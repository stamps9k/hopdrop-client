import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CHUNK_SIZE_BYTES,
  split_into_chunks,
  total_chunk_count,
  create_chunk_buffer,
  add_chunk,
  is_complete,
  missing_sequence_numbers,
  reassemble,
  compute_sha256_hex,
  verify_sha256,
} from "../src/chunking.mjs";

function make_bytes(length: number, fill_start: number = 0): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) {
    bytes[i] = (fill_start + i) % 256;
  }
  return bytes;
}

describe("split_into_chunks", () => {
  test("splits data into equal-sized chunks on an exact multiple", () => {
    const data = make_bytes(20);
    const chunks = split_into_chunks(data, 10);
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0]!.sequence_number, 0);
    assert.equal(chunks[1]!.sequence_number, 1);
    assert.deepEqual(chunks[0]!.data, data.slice(0, 10));
    assert.deepEqual(chunks[1]!.data, data.slice(10, 20));
  });

  test("last chunk is shorter when data is not an exact multiple", () => {
    const data = make_bytes(25);
    const chunks = split_into_chunks(data, 10);
    assert.equal(chunks.length, 3);
    assert.equal(chunks[0]!.data.length, 10);
    assert.equal(chunks[1]!.data.length, 10);
    assert.equal(chunks[2]!.data.length, 5);
  });

  test("returns an empty array for zero-length data", () => {
    const chunks = split_into_chunks(new Uint8Array(0), 10);
    assert.deepEqual(chunks, []);
  });

  test("uses DEFAULT_CHUNK_SIZE_BYTES when no chunk size is given", () => {
    const data = make_bytes(DEFAULT_CHUNK_SIZE_BYTES + 1);
    const chunks = split_into_chunks(data);
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0]!.data.length, DEFAULT_CHUNK_SIZE_BYTES);
    assert.equal(chunks[1]!.data.length, 1);
  });

  test("accepts a plain ArrayBuffer as well as a Uint8Array", () => {
    const data = make_bytes(15);
    const chunks = split_into_chunks(data.buffer, 10);
    assert.equal(chunks.length, 2);
    assert.deepEqual(chunks[0]!.data, data.slice(0, 10));
  });

  test("chunk data is a copy, not a view into the source buffer", () => {
    const data = make_bytes(10);
    const chunks = split_into_chunks(data, 10);
    data[0] = 255;
    assert.notEqual(chunks[0]!.data[0], 255);
  });

  test("throws for a zero or negative chunk_size_bytes", () => {
    assert.throws(() => split_into_chunks(make_bytes(10), 0));
    assert.throws(() => split_into_chunks(make_bytes(10), -1));
  });
});

describe("total_chunk_count", () => {
  test("matches split_into_chunks length across several sizes", () => {
    const cases: [total_bytes: number, chunk_size: number][] = [
      [20, 10],
      [25, 10],
      [1, 10],
      [0, 10],
      [10, 10],
    ];
    for (const [total_bytes, chunk_size] of cases) {
      assert.equal(
        total_chunk_count(total_bytes, chunk_size),
        split_into_chunks(make_bytes(total_bytes), chunk_size).length,
      );
    }
  });

  test("returns 0 for zero or negative total_bytes", () => {
    assert.equal(total_chunk_count(0, 10), 0);
    assert.equal(total_chunk_count(-5, 10), 0);
  });
});

describe("ChunkBuffer - add_chunk / is_complete / missing_sequence_numbers", () => {
  test("is_complete is false until every sequence number has been added", () => {
    const buffer = create_chunk_buffer(3);
    assert.equal(is_complete(buffer), false);
    add_chunk(buffer, { sequence_number: 0, data: make_bytes(2) });
    add_chunk(buffer, { sequence_number: 2, data: make_bytes(2) });
    assert.equal(is_complete(buffer), false);
    add_chunk(buffer, { sequence_number: 1, data: make_bytes(2) });
    assert.equal(is_complete(buffer), true);
  });

  test("a buffer with total_chunks 0 is complete immediately (empty file)", () => {
    const buffer = create_chunk_buffer(0);
    assert.equal(is_complete(buffer), true);
    assert.deepEqual(missing_sequence_numbers(buffer), []);
  });

  test("missing_sequence_numbers reports exactly the gaps, in order", () => {
    const buffer = create_chunk_buffer(4);
    add_chunk(buffer, { sequence_number: 1, data: make_bytes(1) });
    assert.deepEqual(missing_sequence_numbers(buffer), [0, 2, 3]);
  });

  test("re-adding the same sequence_number overwrites rather than growing the buffer", () => {
    const buffer = create_chunk_buffer(2);
    add_chunk(buffer, { sequence_number: 0, data: new Uint8Array([1, 2]) });
    add_chunk(buffer, { sequence_number: 0, data: new Uint8Array([9, 9]) });
    assert.equal(buffer.received.size, 1);
    assert.deepEqual(buffer.received.get(0), new Uint8Array([9, 9]));
  });

  test("throws when sequence_number is negative", () => {
    const buffer = create_chunk_buffer(2);
    assert.throws(() => add_chunk(buffer, { sequence_number: -1, data: make_bytes(1) }));
  });

  test("throws when sequence_number is >= total_chunks", () => {
    const buffer = create_chunk_buffer(2);
    assert.throws(() => add_chunk(buffer, { sequence_number: 2, data: make_bytes(1) }));
  });
});

describe("reassemble", () => {
  test("round-trips split_into_chunks output back to the original bytes", () => {
    const original = make_bytes(37, 5);
    const chunks = split_into_chunks(original, 10);
    const buffer = create_chunk_buffer(chunks.length);
    for (const chunk of chunks) {
      add_chunk(buffer, chunk);
    }
    assert.deepEqual(reassemble(buffer), original);
  });

  test("reassembles correctly even if chunks are added out of order", () => {
    const original = make_bytes(30, 1);
    const chunks = split_into_chunks(original, 10);
    const buffer = create_chunk_buffer(chunks.length);
    add_chunk(buffer, chunks[2]!);
    add_chunk(buffer, chunks[0]!);
    add_chunk(buffer, chunks[1]!);
    assert.deepEqual(reassemble(buffer), original);
  });

  test("an empty-file buffer (total_chunks 0) reassembles to a zero-length array", () => {
    const buffer = create_chunk_buffer(0);
    assert.deepEqual(reassemble(buffer), new Uint8Array(0));
  });

  test("throws with the missing sequence numbers when incomplete", () => {
    const buffer = create_chunk_buffer(3);
    add_chunk(buffer, { sequence_number: 0, data: make_bytes(1) });
    assert.throws(() => reassemble(buffer), /1, 2/);
  });
});

describe("compute_sha256_hex / verify_sha256", () => {
  test("produces a 64-character lowercase hex digest", async () => {
    const hash = await compute_sha256_hex(make_bytes(100));
    assert.equal(hash.length, 64);
    assert.match(hash, /^[0-9a-f]{64}$/);
  });

  test("is deterministic for the same input", async () => {
    const data = make_bytes(500, 3);
    const first = await compute_sha256_hex(data);
    const second = await compute_sha256_hex(data);
    assert.equal(first, second);
  });

  test("differs for different input", async () => {
    const a = await compute_sha256_hex(make_bytes(50, 0));
    const b = await compute_sha256_hex(make_bytes(50, 1));
    assert.notEqual(a, b);
  });

  test("verify_sha256 returns true for a matching hash", async () => {
    const data = make_bytes(200, 7);
    const hash = await compute_sha256_hex(data);
    assert.equal(await verify_sha256(data, hash), true);
  });

  test("verify_sha256 returns false for a mismatched hash", async () => {
    const data = make_bytes(200, 7);
    assert.equal(await verify_sha256(data, "0".repeat(64)), false);
  });

  test("known SHA-256 vector: empty input", async () => {
    const hash = await compute_sha256_hex(new Uint8Array(0));
    assert.equal(
      hash,
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});

describe("end-to-end: split, reassemble, verify", () => {
  test("hash of reassembled data matches hash of the original", async () => {
    const original = make_bytes(12345, 11);
    const original_hash = await compute_sha256_hex(original);

    const chunks = split_into_chunks(original, 1024);
    const buffer = create_chunk_buffer(chunks.length);
    for (const chunk of chunks) {
      add_chunk(buffer, chunk);
    }
    const reassembled = reassemble(buffer);

    assert.deepEqual(reassembled, original);
    assert.equal(await verify_sha256(reassembled, original_hash), true);
  });
});
