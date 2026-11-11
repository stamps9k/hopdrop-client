import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  decrypt_signal_payload,
  encrypt_signal_payload,
  generate_room_key,
  import_room_key,
  is_encrypted_signal_payload,
  is_valid_room_key,
  SignalDecryptionError,
  type SignalContext,
} from "../src/signal_crypto.mjs";

const CONTEXT: SignalContext = {
  type: "offer",
  from_device_id: "device-a",
  to_device_id: "device-b",
};
const SDP = { type: "offer", sdp: "v=0\r\na=fingerprint:sha-256 AB:CD\r\n" };

async function fresh_key(): Promise<CryptoKey> {
  return import_room_key(generate_room_key());
}

describe("room keys", () => {
  test("generated keys are 22-character canonical base64url", () => {
    for (let i = 0; i < 50; i++) {
      const key = generate_room_key();
      assert.match(key, /^[A-Za-z0-9_-]{22}$/);
      assert.equal(is_valid_room_key(key), true);
    }
  });

  test("generated keys differ", () => {
    assert.notEqual(generate_room_key(), generate_room_key());
  });

  test("is_valid_room_key rejects wrong length, bad characters and non-canonical encodings", () => {
    assert.equal(is_valid_room_key("Xq3vN8kLp2RmT7wYc9ZbF"), false);
    assert.equal(is_valid_room_key("Xq3vN8kLp2RmT7wYc9ZbF+"), false);
    assert.equal(is_valid_room_key("Xq3vN8kLp2RmT7wYc9ZbFh"), false);
    assert.equal(is_valid_room_key("Xq3vN8kLp2RmT7wYc9ZbFg"), true);
  });

  test("import_room_key rejects an invalid key", async () => {
    await assert.rejects(import_room_key("nope"));
  });
});

describe("encrypt/decrypt", () => {
  test("round-trips a payload", async () => {
    const key = await fresh_key();
    const envelope = await encrypt_signal_payload(key, SDP, CONTEXT);
    assert.equal(is_encrypted_signal_payload(envelope), true);
    assert.deepEqual(await decrypt_signal_payload(key, envelope, CONTEXT), SDP);
  });

  test("the ciphertext doesn't contain the plaintext", async () => {
    const key = await fresh_key();
    const envelope = await encrypt_signal_payload(key, SDP, CONTEXT);
    assert.equal(JSON.stringify(envelope).includes("fingerprint"), false);
  });

  test("uses a fresh IV per message", async () => {
    const key = await fresh_key();
    const a = await encrypt_signal_payload(key, SDP, CONTEXT);
    const b = await encrypt_signal_payload(key, SDP, CONTEXT);
    assert.notEqual(a.iv, b.iv);
    assert.notEqual(a.ct, b.ct);
  });

  test("fails with a different key", async () => {
    const envelope = await encrypt_signal_payload(
      await fresh_key(),
      SDP,
      CONTEXT,
    );
    await assert.rejects(
      decrypt_signal_payload(await fresh_key(), envelope, CONTEXT),
      SignalDecryptionError,
    );
  });

  test("fails when any part of the context differs", async () => {
    const key = await fresh_key();
    const envelope = await encrypt_signal_payload(key, SDP, CONTEXT);
    for (const other of [
      { ...CONTEXT, type: "answer" as const },
      { ...CONTEXT, from_device_id: "device-c" },
      { ...CONTEXT, to_device_id: "device-c" },
      {
        ...CONTEXT,
        from_device_id: CONTEXT.to_device_id,
        to_device_id: CONTEXT.from_device_id,
      },
    ]) {
      await assert.rejects(
        decrypt_signal_payload(key, envelope, other),
        SignalDecryptionError,
      );
    }
  });

  test("fails when the ciphertext or IV is tampered with", async () => {
    const key = await fresh_key();
    const envelope = await encrypt_signal_payload(key, SDP, CONTEXT);
    const flip = (s: string): string => (s[0] === "A" ? "B" : "A") + s.slice(1);
    await assert.rejects(
      decrypt_signal_payload(
        key,
        { ...envelope, ct: flip(envelope.ct) },
        CONTEXT,
      ),
      SignalDecryptionError,
    );
    await assert.rejects(
      decrypt_signal_payload(
        key,
        { ...envelope, iv: flip(envelope.iv) },
        CONTEXT,
      ),
      SignalDecryptionError,
    );
    await assert.rejects(
      decrypt_signal_payload(key, { ...envelope, iv: "!!" }, CONTEXT),
      SignalDecryptionError,
    );
  });
});

describe("is_encrypted_signal_payload", () => {
  test("distinguishes envelopes from plain SDP/ICE payloads", () => {
    assert.equal(is_encrypted_signal_payload({ v: 1, iv: "a", ct: "b" }), true);
    assert.equal(is_encrypted_signal_payload(SDP), false);
    assert.equal(
      is_encrypted_signal_payload({ candidate: "candidate:1", sdpMid: "0" }),
      false,
    );
    assert.equal(
      is_encrypted_signal_payload({ v: 2, iv: "a", ct: "b" }),
      false,
    );
    assert.equal(is_encrypted_signal_payload(null), false);
    assert.equal(is_encrypted_signal_payload([1]), false);
  });
});

describe("message size", () => {
  // hopdrop-signaling rejects raw messages longer than
  // MAX_RAW_MESSAGE_LENGTH (64 * 1024 characters). Encryption grows a
  // payload by about a third (base64), so check a generously large SDP
  // still fits once wrapped in the relay message the server measures.
  const MAX_RAW_MESSAGE_LENGTH = 64 * 1024;

  test("an encrypted 24 KB SDP offer fits in one signaling message", async () => {
    const key = await fresh_key();
    // A data-channel-only SDP is typically 1-3 KB; 24 KB leaves wide
    // margin for many ICE candidates or extra media sections.
    const sdp = "a=candidate:1 1 udp 2122260223 192.0.2.1 54321 typ host\r\n"
      .repeat(420)
      .slice(0, 24 * 1024);
    const envelope = await encrypt_signal_payload(
      key,
      { type: "offer", sdp },
      CONTEXT,
    );
    const relayed = JSON.stringify({
      type: "offer",
      target_device_id: "00000000-0000-0000-0000-000000000000",
      payload: envelope,
    });
    assert.ok(
      relayed.length < MAX_RAW_MESSAGE_LENGTH,
      `${relayed.length} characters`,
    );
  });
});
