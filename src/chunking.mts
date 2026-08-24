// Pure logic for splitting file data into chunks, reassembling received
// chunks back into the original bytes, and hashing for integrity checks.
// No RTCDataChannel or File/Blob I/O here - that lives in file_sender.mts
// and file_receiver.mts. Uses the standard Web Crypto API (crypto.subtle),
// which Node also provides globally, so this is fully testable with
// node:test without a browser.

// RTCDataChannel messages have practical size limits well below the nominal
// SCTP max; 16 KiB is a widely-used safe default that avoids fragmentation
// issues across browsers.
export const DEFAULT_CHUNK_SIZE_BYTES = 16 * 1024;

export interface FileChunk {
  sequence_number: number;
  data: Uint8Array;
}

// Splits data into ordered, sequence-numbered chunks. Each chunk's data is
// copied (not a view into the original buffer), so callers are free to
// reuse or discard the source buffer immediately after this returns.
export function split_into_chunks(
  data: ArrayBufferLike | Uint8Array,
  chunk_size_bytes: number = DEFAULT_CHUNK_SIZE_BYTES,
): FileChunk[] {
  if (chunk_size_bytes <= 0) {
    throw new Error("chunk_size_bytes must be greater than zero");
  }

  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const chunks: FileChunk[] = [];

  for (let offset = 0, sequence_number = 0; offset < bytes.length; offset += chunk_size_bytes, sequence_number += 1) {
    chunks.push({
      sequence_number,
      data: bytes.slice(offset, offset + chunk_size_bytes),
    });
  }

  return chunks;
}

// How many chunks split_into_chunks would produce for a given byte length,
// without actually splitting anything - useful for a sender to announce
// total_chunks up front (e.g. in a control message) before chunking begins.
export function total_chunk_count(
  total_bytes: number,
  chunk_size_bytes: number = DEFAULT_CHUNK_SIZE_BYTES,
): number {
  if (total_bytes <= 0) {
    return 0;
  }
  return Math.ceil(total_bytes / chunk_size_bytes);
}

// ---------------------------------------------------------------------------
// Reassembly
// ---------------------------------------------------------------------------

export interface ChunkBuffer {
  total_chunks: number;
  received: Map<number, Uint8Array>;
}

export function create_chunk_buffer(total_chunks: number): ChunkBuffer {
  if (total_chunks < 0) {
    throw new Error("total_chunks must be zero or greater");
  }
  return { total_chunks, received: new Map() };
}

// Idempotent by sequence_number: re-adding the same sequence_number
// (e.g. a duplicate delivery) overwrites in place rather than growing the
// buffer, since RTCDataChannel is ordered/reliable by default and true
// duplicates shouldn't occur - but a defensive overwrite is cheap insurance.
export function add_chunk(buffer: ChunkBuffer, chunk: FileChunk): void {
  if (chunk.sequence_number < 0 || chunk.sequence_number >= buffer.total_chunks) {
    throw new Error(
      `chunk sequence_number ${chunk.sequence_number} out of range for total_chunks ${buffer.total_chunks}`,
    );
  }
  buffer.received.set(chunk.sequence_number, chunk.data);
}

export function is_complete(buffer: ChunkBuffer): boolean {
  return buffer.received.size === buffer.total_chunks;
}

export function missing_sequence_numbers(buffer: ChunkBuffer): number[] {
  const missing: number[] = [];
  for (let i = 0; i < buffer.total_chunks; i += 1) {
    if (!buffer.received.has(i)) {
      missing.push(i);
    }
  }
  return missing;
}

// Concatenates all received chunks back into original byte order. Throws if
// any chunk is still missing - check is_complete() first, or catch and
// inspect missing_sequence_numbers() for a more actionable error.
export function reassemble(buffer: ChunkBuffer): Uint8Array {
  if (!is_complete(buffer)) {
    const missing = missing_sequence_numbers(buffer);
    throw new Error(`cannot reassemble: missing chunk(s) ${missing.join(", ")}`);
  }

  let total_length = 0;
  for (let i = 0; i < buffer.total_chunks; i += 1) {
    total_length += (buffer.received.get(i) as Uint8Array).length;
  }

  const result = new Uint8Array(total_length);
  let offset = 0;
  for (let i = 0; i < buffer.total_chunks; i += 1) {
    const part = buffer.received.get(i) as Uint8Array;
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Integrity hashing (SHA-256 via the standard Web Crypto API)
// ---------------------------------------------------------------------------

function bytes_to_hex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function compute_sha256_hex(data: Uint8Array): Promise<string> {
  // crypto.subtle.digest's BufferSource type is pinned to ArrayBuffer-backed
  // views; Uint8Array's type parameter also allows SharedArrayBuffer, so a
  // narrowing cast is needed even though this is safe at runtime for the
  // plain Uint8Arrays this module produces.
  const digest = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return bytes_to_hex(new Uint8Array(digest));
}

export async function verify_sha256(
  data: Uint8Array,
  expected_hex: string,
): Promise<boolean> {
  const actual_hex = await compute_sha256_hex(data);
  return actual_hex === expected_hex;
}
