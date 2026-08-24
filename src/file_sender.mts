// Thin wrapper that drives an actual File and RTCDataChannel. Not unit
// tested - the byte-level logic it calls into (chunking, hashing, message
// framing) is already covered by chunking.mts and file_transfer_protocol.mts
// tests; what's left here is real browser I/O (File reading, channel
// backpressure) that's verified by hand, the same way peer_connection.mts is.
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
import { build_file_start_message } from "./file_transfer_protocol.mjs";

// Once bufferedAmount exceeds this, sending pauses until the channel drains
// back down to it (via the bufferedamountlow event) before the next chunk
// goes out. Keeps memory bounded on a slow/congested connection without
// throttling throughput on a fast one.
const DEFAULT_BUFFERED_AMOUNT_LOW_THRESHOLD = 256 * 1024;

export interface FileSendProgress {
  file_name: string;
  bytes_sent: number;
  total_bytes: number;
  chunks_sent: number;
  total_chunks: number;
}

export interface FileSenderHandlers {
  on_progress?: (progress: FileSendProgress) => void;
  on_complete?: (file_name: string) => void;
  on_error?: (error: Error) => void;
}

export interface SendFileOptions {
  buffered_amount_low_threshold?: number;
}

function wait_for_buffer_drain(
  channel: RTCDataChannel,
  threshold: number,
): Promise<void> {
  return new Promise((resolve) => {
    if (channel.bufferedAmount <= threshold) {
      resolve();
      return;
    }
    channel.bufferedAmountLowThreshold = threshold;
    const handle_low = (): void => {
      channel.removeEventListener("bufferedamountlow", handle_low);
      resolve();
    };
    channel.addEventListener("bufferedamountlow", handle_low);
  });
}

export async function send_file(
  channel: RTCDataChannel,
  file: File,
  handlers: FileSenderHandlers = {},
  options: SendFileOptions = {},
): Promise<void> {
  const threshold =
    options.buffered_amount_low_threshold ??
    DEFAULT_BUFFERED_AMOUNT_LOW_THRESHOLD;

  try {
    if (channel.readyState !== "open") {
      throw new Error(
        `cannot send file: data channel is "${channel.readyState}", not "open"`,
      );
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const sha256_hex = await compute_sha256_hex(bytes);
    const total_chunks = total_chunk_count(bytes.length);

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
      await wait_for_buffer_drain(channel, threshold);
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

    handlers.on_complete?.(file.name);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    handlers.on_error?.(error);
    throw error;
  }
}
