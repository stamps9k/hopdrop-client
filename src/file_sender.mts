// Thin wrapper that drives an actual File and RTCDataChannel. The byte-level
// logic it calls into (chunking, hashing, message framing) is covered by
// chunking.mts and file_transfer_protocol.mts tests; the flow here (waiting
// for the receiver's confirmation, failing when the channel closes,
// refusing overlapping sends) is tested against a fake channel in
// test/file_transfer.test.mts.
//
// A send goes through three stages, reported through the handlers:
//   on_progress   chunks being handed to the channel
//   on_sent       every chunk is in the channel's send buffer - but not yet
//                 confirmed as received
//   on_complete   the receiver has rebuilt the file and reported its hash
//                 check (file-complete) - only now is it "delivered"
// on_error covers everything else: the channel closing at any stage, no
// confirmation arriving in time, or a send already running on the channel.
//
// Known limitation: the whole file is read into memory at once via
// file.arrayBuffer() before sending starts. Fine for hopdrop's personal-use
// scale; a streaming reader would be the fix if very large files ever
// become a problem, but that's out of scope for now.

import {
  compute_sha256_hex,
  split_into_chunks,
  total_chunk_count,
} from "./chunking.mjs";
import {
  build_file_start_message,
  parse_file_control_message,
} from "./file_transfer_protocol.mjs";

// Once bufferedAmount exceeds this, sending pauses until the channel drains
// back down to it (via the bufferedamountlow event) before the next chunk
// goes out. Keeps memory bounded on a slow/congested connection without
// throttling throughput on a fast one.
const DEFAULT_BUFFERED_AMOUNT_LOW_THRESHOLD = 256 * 1024;

// How long to wait for the receiver's confirmation, counted from when the
// last chunk has actually left the send buffer. The receiver still has to
// rebuild and hash the whole file, so larger files get longer: a fixed
// base plus one second per 50 MB.
const CONFIRMATION_BASE_TIMEOUT_MS = 15_000;
const CONFIRMATION_BYTES_PER_EXTRA_SECOND = 50 * 1024 * 1024;

export interface FileSendProgress {
  file_name: string;
  bytes_sent: number;
  total_bytes: number;
  chunks_sent: number;
  total_chunks: number;
}

export interface FileSendResult {
  file_name: string;
  // The receiver's own hash check. false means the file arrived corrupted.
  hash_verified: boolean;
}

export interface FileSenderHandlers {
  on_progress?: (progress: FileSendProgress) => void;
  on_sent?: (file_name: string) => void;
  on_complete?: (result: FileSendResult) => void;
  on_error?: (error: Error) => void;
}

export interface SendFileOptions {
  buffered_amount_low_threshold?: number;
  // Overrides the size-based confirmation timeout - mainly for tests.
  confirmation_timeout_ms?: number;
}

// Channels with a send in progress. Two interleaved sends on one channel
// would be unrecoverable for the receiver (it can't tell whose chunk is
// whose), so a second send is refused rather than queued.
const busy_channels = new WeakSet<RTCDataChannel>();

export function confirmation_timeout_for(file_size: number): number {
  return (
    CONFIRMATION_BASE_TIMEOUT_MS +
    Math.ceil(file_size / CONFIRMATION_BYTES_PER_EXTRA_SECOND) * 1000
  );
}

export class ChannelClosedError extends Error {
  constructor(stage: string) {
    super(`the connection closed ${stage}`);
    this.name = "ChannelClosedError";
  }
}

// Resolves once bufferedAmount is at or below threshold; rejects if the
// channel closes first - without that, a peer vanishing mid-transfer would
// leave the send waiting forever.
function wait_for_buffer_drain(
  channel: RTCDataChannel,
  threshold: number,
  stage: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (channel.readyState !== "open") {
      reject(new ChannelClosedError(stage));
      return;
    }
    if (channel.bufferedAmount <= threshold) {
      resolve();
      return;
    }
    channel.bufferedAmountLowThreshold = threshold;
    const cleanup = (): void => {
      channel.removeEventListener("bufferedamountlow", handle_low);
      channel.removeEventListener("close", handle_close);
    };
    const handle_low = (): void => {
      cleanup();
      resolve();
    };
    const handle_close = (): void => {
      cleanup();
      reject(new ChannelClosedError(stage));
    };
    channel.addEventListener("bufferedamountlow", handle_low);
    channel.addEventListener("close", handle_close);
  });
}

interface ConfirmationWatcher {
  // Starts the timeout and resolves with the receiver's hash result.
  wait(timeout_ms: number): Promise<boolean>;
  cancel(): void;
}

// Listens for the receiver's file-complete from the very start of the
// send, not just once the last chunk is out - a fast receiver can confirm
// before this side has even finished draining its buffer. Matched on the
// file's hash, so a confirmation for any other transfer is ignored.
function watch_for_confirmation(
  channel: RTCDataChannel,
  file_name: string,
  sha256_hex: string,
): ConfirmationWatcher {
  let result: boolean | undefined;
  let settle: ((hash_verified: boolean) => void) | undefined;
  let fail: ((error: Error) => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function handle_message(event: MessageEvent): void {
    if (typeof event.data !== "string") {
      return;
    }
    const parsed = parse_file_control_message(event.data);
    if (
      !parsed.ok ||
      parsed.message.type !== "file-complete" ||
      parsed.message.sha256_hex !== sha256_hex ||
      parsed.message.file_name !== file_name
    ) {
      return;
    }
    result = parsed.message.hash_verified;
    settle?.(result);
  }

  function handle_close(): void {
    fail?.(new ChannelClosedError("before the other device confirmed receipt"));
  }

  function cancel(): void {
    channel.removeEventListener("message", handle_message);
    channel.removeEventListener("close", handle_close);
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }

  channel.addEventListener("message", handle_message);
  channel.addEventListener("close", handle_close);

  return {
    wait(timeout_ms) {
      return new Promise<boolean>((resolve, reject) => {
        settle = resolve;
        fail = reject;
        if (result !== undefined) {
          resolve(result);
          return;
        }
        if (channel.readyState !== "open") {
          handle_close();
          return;
        }
        timer = setTimeout(() => {
          reject(
            new Error(
              "the other device didn't confirm receipt in time - it may have closed, or be running an older version of hopdrop",
            ),
          );
        }, timeout_ms);
      });
    },
    cancel,
  };
}

export async function send_file(
  channel: RTCDataChannel,
  file: File,
  handlers: FileSenderHandlers = {},
  options: SendFileOptions = {},
): Promise<FileSendResult> {
  const threshold =
    options.buffered_amount_low_threshold ??
    DEFAULT_BUFFERED_AMOUNT_LOW_THRESHOLD;

  if (busy_channels.has(channel)) {
    const error = new Error(
      "a file is already being sent to this device - wait for it to finish",
    );
    handlers.on_error?.(error);
    throw error;
  }
  busy_channels.add(channel);

  let confirmation: ConfirmationWatcher | undefined;
  try {
    if (channel.readyState !== "open") {
      throw new Error(
        `cannot send file: data channel is "${channel.readyState}", not "open"`,
      );
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const sha256_hex = await compute_sha256_hex(bytes);
    const total_chunks = total_chunk_count(bytes.length);

    confirmation = watch_for_confirmation(channel, file.name, sha256_hex);
    channel.send(
      build_file_start_message({
        file_name: file.name,
        file_size: bytes.length,
        total_chunks,
        sha256_hex,
      }),
    );

    const chunks = split_into_chunks(bytes);
    let bytes_sent = 0;
    for (const chunk of chunks) {
      await wait_for_buffer_drain(channel, threshold, "during the transfer");
      // chunk.data is already an independent copy (chunking.mts builds it
      // via Uint8Array.slice()), so it's safe to hand straight to the
      // channel - RTCDataChannel.send accepts any ArrayBufferView.
      channel.send(chunk.data as unknown as ArrayBufferView<ArrayBuffer>);
      bytes_sent += chunk.data.byteLength;
      handlers.on_progress?.({
        file_name: file.name,
        bytes_sent,
        total_bytes: bytes.length,
        chunks_sent: chunk.sequence_number + 1,
        total_chunks,
      });
    }

    // Wait for the buffer to empty completely before starting the
    // confirmation clock, so a slow link doesn't eat into the receiver's
    // time to rebuild and hash the file.
    await wait_for_buffer_drain(channel, 0, "during the transfer");
    handlers.on_sent?.(file.name);

    const hash_verified = await confirmation.wait(
      options.confirmation_timeout_ms ?? confirmation_timeout_for(bytes.length),
    );
    const result: FileSendResult = { file_name: file.name, hash_verified };
    handlers.on_complete?.(result);
    return result;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    handlers.on_error?.(error);
    throw error;
  } finally {
    confirmation?.cancel();
    busy_channels.delete(channel);
  }
}
