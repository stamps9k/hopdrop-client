import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  build_file_start_message,
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
