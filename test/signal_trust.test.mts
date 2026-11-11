import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  decide_incoming_signal,
  decide_outgoing_mode,
  type IncomingSignal,
  type PeerSignalMode,
} from "../src/signal_trust.mjs";
import type { RtcSignalType } from "../src/signaling_protocol.mjs";

function decide(signal: Partial<IncomingSignal>): string {
  const decision = decide_incoming_signal({
    has_room_key: true,
    is_encrypted: true,
    known_mode: undefined,
    type: "offer",
    ...signal,
  });
  return decision.kind === "reject"
    ? `reject:${decision.reason}`
    : decision.kind;
}

describe("decide_incoming_signal - this device holds the room key", () => {
  test("decrypts encrypted messages from a new or encrypted peer", () => {
    for (const type of ["offer", "answer", "ice-candidate"] as const) {
      assert.equal(decide({ type }), "decrypt");
      assert.equal(decide({ type, known_mode: "encrypted" }), "decrypt");
    }
  });

  test("accepts a plaintext offer from a new peer (typed-code joiner)", () => {
    assert.equal(decide({ is_encrypted: false }), "accept_plaintext");
  });

  test("keeps accepting plaintext from an established plaintext peer", () => {
    for (const type of ["offer", "answer", "ice-candidate"] as const) {
      assert.equal(
        decide({ type, is_encrypted: false, known_mode: "plaintext" }),
        "accept_plaintext",
      );
    }
  });

  test("rejects a downgrade from encrypted to plaintext as tampering", () => {
    for (const type of ["offer", "answer", "ice-candidate"] as const) {
      assert.equal(
        decide({ type, is_encrypted: false, known_mode: "encrypted" }),
        "reject:tampered",
      );
    }
  });

  test("rejects a switch from plaintext to encrypted as tampering", () => {
    assert.equal(decide({ known_mode: "plaintext" }), "reject:tampered");
  });

  test("rejects an unsolicited plaintext answer as tampering", () => {
    assert.equal(
      decide({ type: "answer", is_encrypted: false }),
      "reject:tampered",
    );
  });

  test("drops plaintext ICE before any offer without alarm", () => {
    assert.equal(
      decide({ type: "ice-candidate", is_encrypted: false }),
      "reject:out_of_order",
    );
  });
});

describe("decide_incoming_signal - this device joined by typed code", () => {
  test("accepts plaintext", () => {
    for (const type of ["offer", "answer", "ice-candidate"] as const) {
      assert.equal(
        decide({ type, has_room_key: false, is_encrypted: false }),
        "accept_plaintext",
      );
    }
  });

  test("reports encrypted messages as needing the key", () => {
    assert.equal(decide({ has_room_key: false }), "reject:needs_key");
  });
});

describe("decide_outgoing_mode", () => {
  test("encrypts when holding the key, unless the peer is plaintext", () => {
    assert.equal(decide_outgoing_mode(true, undefined), "encrypted");
    assert.equal(decide_outgoing_mode(true, "encrypted"), "encrypted");
    assert.equal(decide_outgoing_mode(true, "plaintext"), "plaintext");
  });

  test("always plaintext without the key", () => {
    assert.equal(decide_outgoing_mode(false, undefined), "plaintext");
    assert.equal(decide_outgoing_mode(false, "encrypted"), "plaintext");
  });
});

// Every input combination, pinned. The tests above check the reasoning;
// this table makes any change to any single outcome fail loudly, so a
// change to the trust rules is always a deliberate edit here too.
describe("decide_incoming_signal - full decision table", () => {
  type Row = [
    has_room_key: boolean,
    is_encrypted: boolean,
    known_mode: PeerSignalMode | null,
    type: RtcSignalType,
    expected: string,
  ];
  const table: Row[] = [
    [true, true, null, "offer", "decrypt"],
    [true, true, null, "answer", "decrypt"],
    [true, true, null, "ice-candidate", "decrypt"],
    [true, true, "encrypted", "offer", "decrypt"],
    [true, true, "encrypted", "answer", "decrypt"],
    [true, true, "encrypted", "ice-candidate", "decrypt"],
    [true, true, "plaintext", "offer", "reject:tampered"],
    [true, true, "plaintext", "answer", "reject:tampered"],
    [true, true, "plaintext", "ice-candidate", "reject:tampered"],
    [true, false, null, "offer", "accept_plaintext"],
    [true, false, null, "answer", "reject:tampered"],
    [true, false, null, "ice-candidate", "reject:out_of_order"],
    [true, false, "encrypted", "offer", "reject:tampered"],
    [true, false, "encrypted", "answer", "reject:tampered"],
    [true, false, "encrypted", "ice-candidate", "reject:tampered"],
    [true, false, "plaintext", "offer", "accept_plaintext"],
    [true, false, "plaintext", "answer", "accept_plaintext"],
    [true, false, "plaintext", "ice-candidate", "accept_plaintext"],
    [false, true, null, "offer", "reject:needs_key"],
    [false, true, null, "answer", "reject:needs_key"],
    [false, true, null, "ice-candidate", "reject:needs_key"],
    [false, true, "encrypted", "offer", "reject:needs_key"],
    [false, true, "encrypted", "answer", "reject:needs_key"],
    [false, true, "encrypted", "ice-candidate", "reject:needs_key"],
    [false, true, "plaintext", "offer", "reject:needs_key"],
    [false, true, "plaintext", "answer", "reject:needs_key"],
    [false, true, "plaintext", "ice-candidate", "reject:needs_key"],
    [false, false, null, "offer", "accept_plaintext"],
    [false, false, null, "answer", "accept_plaintext"],
    [false, false, null, "ice-candidate", "accept_plaintext"],
    [false, false, "encrypted", "offer", "accept_plaintext"],
    [false, false, "encrypted", "answer", "accept_plaintext"],
    [false, false, "encrypted", "ice-candidate", "accept_plaintext"],
    [false, false, "plaintext", "offer", "accept_plaintext"],
    [false, false, "plaintext", "answer", "accept_plaintext"],
    [false, false, "plaintext", "ice-candidate", "accept_plaintext"],
  ];

  test("covers all 36 combinations exactly once", () => {
    const keys = new Set(table.map((row) => row.slice(0, 4).join("|")));
    assert.equal(table.length, 36);
    assert.equal(keys.size, 36);
  });

  for (const [
    has_room_key,
    is_encrypted,
    known_mode,
    type,
    expected,
  ] of table) {
    test(`key=${has_room_key} encrypted=${is_encrypted} mode=${known_mode} ${type} -> ${expected}`, () => {
      assert.equal(
        decide({
          has_room_key,
          is_encrypted,
          known_mode: known_mode ?? undefined,
          type,
        }),
        expected,
      );
    });
  }
});
