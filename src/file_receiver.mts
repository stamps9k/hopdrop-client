// Thin wrapper that listens on an actual RTCDataChannel and drives the pure
// logic in chunking.mts and file_transfer_protocol.mts. Not unit tested for
// the same reason as file_sender.mts - the byte-level logic is already
// covered by those modules' tests; what's left is real channel I/O,
// verified by hand.
//
// Wire format expected (matches what file_sender.mts sends): one JSON
// "file-start" string message, then that file's chunks as raw ArrayBuffer
// messages in order. Sequence numbers aren't embedded per chunk - this
// relies on the data channel's default ordered/reliable delivery and just
// counts chunks as they arrive. After a file completes, the channel is
// ready for another file-start (sequential transfers over one channel).

import {
  add_chunk,
  create_chunk_buffer,
  is_complete,
  reassemble,
  verify_sha256,
  type ChunkBuffer,
} from "./chunking.mjs";
import { parse_file_start_message } from "./file_transfer_protocol.mjs";

export interface FileReceiveStart {
  file_name: string;
  file_size: number;
  total_chunks: number;
}

export interface FileReceiveProgress {
  file_name: string;
  bytes_received: number;
  total_bytes: number;
  chunks_received: number;
  total_chunks: number;
}

export interface FileReceiveComplete {
  file_name: string;
  blob: Blob;
  bytes_received: number;
  hash_verified: boolean;
}

export interface FileReceiverHandlers {
  on_start?: (info: FileReceiveStart) => void;
  on_progress?: (progress: FileReceiveProgress) => void;
  on_complete?: (result: FileReceiveComplete) => void;
  on_error?: (error: Error) => void;
}

export interface FileReceiver {
  detach(): void;
}

interface ActiveTransfer {
  file_name: string;
  file_size: number;
  total_chunks: number;
  sha256_hex: string;
  chunk_buffer: ChunkBuffer;
  next_sequence_number: number;
  bytes_received: number;
}

export function attach_file_receiver(
  channel: RTCDataChannel,
  handlers: FileReceiverHandlers = {},
): FileReceiver {
  let active: ActiveTransfer | null = null;

  async function finalize_active(finished: ActiveTransfer): Promise<void> {
    try {
      const data = reassemble(finished.chunk_buffer);
      const hash_verified = await verify_sha256(data, finished.sha256_hex);
      const blob = new Blob([data as unknown as BlobPart]);
      handlers.on_complete?.({
        file_name: finished.file_name,
        blob,
        bytes_received: finished.bytes_received,
        hash_verified,
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      handlers.on_error?.(error);
    }
  }

  function handle_control_message(raw: string): void {
    const result = parse_file_start_message(raw);
    if (!result.ok) {
      handlers.on_error?.(
        new Error(`invalid control message: ${result.error}`),
      );
      return;
    }

    if (active !== null) {
      handlers.on_error?.(
        new Error(
          `received new file-start for "${result.message.file_name}" while ` +
            `"${active.file_name}" was still in progress; abandoning previous transfer`,
        ),
      );
    }

    const { file_name, file_size, total_chunks, sha256_hex } = result.message;
    active = {
      file_name,
      file_size,
      total_chunks,
      sha256_hex,
      chunk_buffer: create_chunk_buffer(total_chunks),
      next_sequence_number: 0,
      bytes_received: 0,
    };
    handlers.on_start?.({ file_name, file_size, total_chunks });

    // Zero-byte file: no chunk messages will ever arrive, so finish now.
    if (is_complete(active.chunk_buffer)) {
      const finished = active;
      active = null;
      void finalize_active(finished);
    }
  }

  function handle_binary_message(data: ArrayBuffer): void {
    if (active === null) {
      handlers.on_error?.(
        new Error("received chunk data before a file-start message"),
      );
      return;
    }
    if (active.next_sequence_number >= active.total_chunks) {
      handlers.on_error?.(
        new Error(
          `received more chunk data than the announced total_chunks (${active.total_chunks})`,
        ),
      );
      return;
    }

    const chunk_bytes = new Uint8Array(data);
    add_chunk(active.chunk_buffer, {
      sequence_number: active.next_sequence_number,
      data: chunk_bytes,
    });
    active.next_sequence_number += 1;
    active.bytes_received += chunk_bytes.byteLength;

    handlers.on_progress?.({
      file_name: active.file_name,
      bytes_received: active.bytes_received,
      total_bytes: active.file_size,
      chunks_received: active.next_sequence_number,
      total_chunks: active.total_chunks,
    });

    if (is_complete(active.chunk_buffer)) {
      const finished = active;
      active = null;
      void finalize_active(finished);
    }
  }

  function handle_message(event: MessageEvent): void {
    if (typeof event.data === "string") {
      handle_control_message(event.data);
      return;
    }
    if (event.data instanceof ArrayBuffer) {
      handle_binary_message(event.data);
      return;
    }
    handlers.on_error?.(
      new Error(
        'received a binary message that was not an ArrayBuffer - is channel.binaryType set to "arraybuffer"?',
      ),
    );
  }

  channel.addEventListener("message", handle_message);

  return {
    detach() {
      channel.removeEventListener("message", handle_message);
    },
  };
}
