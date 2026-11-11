import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  build_file_complete_message,
  build_file_start_message,
  parse_file_control_message,
  parse_file_start_message,
} from "../src/file_transfer_protocol.mjs";

const SAMPLE_HASH =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

describe("build_file_start_message", () => {
  test("produces a well-formed file-start message", () => {
    const raw = build_file_start_message({
      file_name: "photo.png",
      file_size: 2048,
      total_chunks: 3,
      sha256_hex: SAMPLE_HASH,
    });
    assert.deepEqual(JSON.parse(raw), {
      type: "file-start",
      file_name: "photo.png",
      file_size: 2048,
      total_chunks: 3,
      sha256_hex: SAMPLE_HASH,
    });
  });

  test("supports a zero-byte file (total_chunks 0)", () => {
    const raw = build_file_start_message({
      file_name: "empty.txt",
      file_size: 0,
      total_chunks: 0,
      sha256_hex: SAMPLE_HASH,
    });
    assert.deepEqual(JSON.parse(raw), {
      type: "file-start",
      file_name: "empty.txt",
      file_size: 0,
      total_chunks: 0,
      sha256_hex: SAMPLE_HASH,
    });
  });
});

describe("parse_file_start_message - valid messages", () => {
  test("round-trips a message built by build_file_start_message", () => {
    const raw = build_file_start_message({
      file_name: "doc.pdf",
      file_size: 99999,
      total_chunks: 7,
      sha256_hex: SAMPLE_HASH,
    });
    const result = parse_file_start_message(raw);
    assert.equal(result.ok, true);
    assert.deepEqual(result.ok ? result.message : null, {
      type: "file-start",
      file_name: "doc.pdf",
      file_size: 99999,
      total_chunks: 7,
      sha256_hex: SAMPLE_HASH,
    });
  });
});

describe("parse_file_start_message - malformed input", () => {
  test("rejects invalid JSON", () => {
    assert.equal(parse_file_start_message("{not json").ok, false);
  });

  test("rejects JSON that is not an object", () => {
    assert.equal(
      parse_file_start_message(JSON.stringify(["file-start"])).ok,
      false,
    );
  });

  test("rejects a missing type field", () => {
    assert.equal(
      parse_file_start_message(JSON.stringify({ file_name: "x" })).ok,
      false,
    );
  });

  test("rejects the wrong type value", () => {
    assert.equal(
      parse_file_start_message(JSON.stringify({ type: "offer" })).ok,
      false,
    );
  });

  test("rejects a missing file_name", () => {
    const result = parse_file_start_message(
      JSON.stringify({
        type: "file-start",
        file_size: 10,
        total_chunks: 1,
        sha256_hex: SAMPLE_HASH,
      }),
    );
    assert.equal(result.ok, false);
  });

  test("rejects a non-integer file_size", () => {
    const result = parse_file_start_message(
      JSON.stringify({
        type: "file-start",
        file_name: "x",
        file_size: 10.5,
        total_chunks: 1,
        sha256_hex: SAMPLE_HASH,
      }),
    );
    assert.equal(result.ok, false);
  });

  test("rejects a negative total_chunks", () => {
    const result = parse_file_start_message(
      JSON.stringify({
        type: "file-start",
        file_name: "x",
        file_size: 10,
        total_chunks: -1,
        sha256_hex: SAMPLE_HASH,
      }),
    );
    assert.equal(result.ok, false);
  });

  test("rejects a non-string sha256_hex", () => {
    const result = parse_file_start_message(
      JSON.stringify({
        type: "file-start",
        file_name: "x",
        file_size: 10,
        total_chunks: 1,
        sha256_hex: 12345,
      }),
    );
    assert.equal(result.ok, false);
  });
});

describe("file-complete messages", () => {
  test("round-trip through parse_file_control_message", () => {
    const raw = build_file_complete_message({
      file_name: "photo.jpg",
      sha256_hex: SAMPLE_HASH,
      hash_verified: false,
    });
    assert.deepEqual(parse_file_control_message(raw), {
      ok: true,
      message: {
        type: "file-complete",
        file_name: "photo.jpg",
        sha256_hex: SAMPLE_HASH,
        hash_verified: false,
      },
    });
  });

  test("reject a missing or non-boolean hash_verified", () => {
    for (const hash_verified of [undefined, "true", 1, null]) {
      const raw = JSON.stringify({
        type: "file-complete",
        file_name: "a",
        sha256_hex: SAMPLE_HASH,
        hash_verified,
      });
      assert.deepEqual(parse_file_control_message(raw), {
        ok: false,
        error: "invalid file-complete payload",
      });
    }
  });

  test("are not accepted as a file-start", () => {
    const raw = build_file_complete_message({
      file_name: "a",
      sha256_hex: SAMPLE_HASH,
      hash_verified: true,
    });
    assert.equal(parse_file_start_message(raw).ok, false);
  });
});

describe("parse_file_control_message", () => {
  test("parses a file-start the same as parse_file_start_message", () => {
    const raw = build_file_start_message({
      file_name: "a.txt",
      file_size: 3,
      total_chunks: 1,
      sha256_hex: SAMPLE_HASH,
    });
    assert.deepEqual(
      parse_file_control_message(raw),
      parse_file_start_message(raw),
    );
  });

  test("rejects unknown types and malformed JSON", () => {
    assert.deepEqual(parse_file_control_message('{"type":"file-cancel"}'), {
      ok: false,
      error: "missing or invalid type field",
    });
    assert.deepEqual(parse_file_control_message("[1]"), {
      ok: false,
      error: "missing or invalid type field",
    });
    assert.deepEqual(parse_file_control_message("{"), {
      ok: false,
      error: "malformed JSON",
    });
  });
});
