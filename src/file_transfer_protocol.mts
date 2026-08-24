// Pure message construction + parsing for the small control protocol that
// rides alongside raw binary chunk data on the RTCDataChannel. The channel
// carries two kinds of messages: this JSON control message (as a string),
// sent once before a file's chunks, and the chunk bytes themselves (as
// ArrayBuffer, sent by file_sender.mts and handled directly by
// file_receiver.mts via chunking.mts - no protocol wrapper needed per
// chunk, since the channel is ordered/reliable and total_chunks is already
// known from this message).
//
// Deliberately self-contained (small is_record/is_string duplication vs
// signaling_protocol.mts) so this module has no dependency on the
// signaling protocol - it describes a completely different channel.

export interface FileStartMessage {
  type: "file-start";
  file_name: string;
  file_size: number;
  total_chunks: number;
  sha256_hex: string;
}

export function build_file_start_message(
  params: Omit<FileStartMessage, "type">,
): string {
  const message: FileStartMessage = { type: "file-start", ...params };
  return JSON.stringify(message);
}

export type ParseFileStartMessageResult =
  { ok: true; message: FileStartMessage } | { ok: false; error: string };

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function is_string(value: unknown): value is string {
  return typeof value === "string";
}

function is_non_negative_integer(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function parse_file_start_message(
  raw: string,
): ParseFileStartMessageResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "malformed JSON" };
  }

  if (!is_record(parsed) || parsed.type !== "file-start") {
    return { ok: false, error: "missing or invalid type field" };
  }
  if (
    !is_string(parsed.file_name) ||
    !is_non_negative_integer(parsed.file_size) ||
    !is_non_negative_integer(parsed.total_chunks) ||
    !is_string(parsed.sha256_hex)
  ) {
    return { ok: false, error: "invalid file-start payload" };
  }

  return {
    ok: true,
    message: {
      type: "file-start",
      file_name: parsed.file_name,
      file_size: parsed.file_size,
      total_chunks: parsed.total_chunks,
      sha256_hex: parsed.sha256_hex,
    },
  };
}
