// Pure decision rules for which signaling payloads to accept, encrypt or
// reject, per peer. No crypto or I/O here (that's signal_crypto.mts and
// index.mts) - kept separate so the downgrade rules can be unit tested on
// their own, since they're what the encryption's guarantees rest on.
//
// Background: a device that joined via a QR code / link holds the room key
// and encrypts every SDP/ICE payload. A device that joined by typing the
// room code has no key, so it can only signal in plaintext - an accepted
// fallback. For the two to still connect, a keyed device has to accept
// plaintext from a keyless peer. That's also exactly what a malicious
// signaling server would try (strip the encryption and substitute its own
// SDP), so plaintext is only ever accepted where a keyless peer would
// legitimately produce it, and the resulting connection is reported as
// unverified rather than silently treated the same as an encrypted one:
//
//   - A keyless peer is always the newcomer (a typed-code joiner joins an
//     existing room), so it's always the caller (see rtc_negotiation.mts):
//     its first message is a plaintext offer. That's the only way a peer
//     can be established as plaintext.
//   - Once a peer's mode is set, it never changes. A plaintext answer to
//     our encrypted offer, or plaintext arriving mid-exchange from a peer
//     that has been signaling encrypted, is a downgrade attempt.
//   - Plaintext ICE before any offer/answer can't come from a well-behaved
//     peer (offers are always sent before candidates) - dropped.

import type { RtcSignalType } from "./signaling_protocol.mjs";

export type PeerSignalMode = "encrypted" | "plaintext";

export type IncomingSignalDecision =
  | { kind: "decrypt"; mode: "encrypted" }
  | { kind: "accept_plaintext"; mode: "plaintext" }
  | { kind: "reject"; reason: RejectReason; detail: string };

// "tampered": only explicable by interference between the two devices -
// worth a loud warning. "needs_key": this device joined by typed code and
// the peer is encrypting, which it legitimately does if it joined by link.
// "out_of_order": dropped without alarm.
export type RejectReason = "tampered" | "needs_key" | "out_of_order";

export interface IncomingSignal {
  has_room_key: boolean;
  is_encrypted: boolean;
  known_mode: PeerSignalMode | undefined;
  type: RtcSignalType;
}

export function decide_incoming_signal(
  signal: IncomingSignal,
): IncomingSignalDecision {
  const { has_room_key, is_encrypted, known_mode, type } = signal;

  if (is_encrypted) {
    if (!has_room_key) {
      return {
        kind: "reject",
        reason: "needs_key",
        detail:
          "this peer joined with the encrypted link - rejoin by scanning the QR code or opening the join link",
      };
    }
    if (known_mode === "plaintext") {
      return {
        kind: "reject",
        reason: "tampered",
        detail: "peer switched from unencrypted to encrypted signaling",
      };
    }
    return { kind: "decrypt", mode: "encrypted" };
  }

  if (!has_room_key) {
    return { kind: "accept_plaintext", mode: "plaintext" };
  }
  if (known_mode === "plaintext") {
    return { kind: "accept_plaintext", mode: "plaintext" };
  }
  if (known_mode === "encrypted") {
    return {
      kind: "reject",
      reason: "tampered",
      detail: "unencrypted message from a peer that was signaling encrypted",
    };
  }
  if (type === "offer") {
    return { kind: "accept_plaintext", mode: "plaintext" };
  }
  if (type === "answer") {
    // Only reachable if we never sent an offer ourselves - an answer we
    // didn't ask for, in plaintext, is never legitimate.
    return {
      kind: "reject",
      reason: "tampered",
      detail: "unsolicited unencrypted answer",
    };
  }
  return {
    kind: "reject",
    reason: "out_of_order",
    detail: "unencrypted ICE candidate before any offer",
  };
}

// Which mode to send in. A peer established as plaintext gets plaintext
// back (it couldn't read anything else); otherwise a keyed device always
// encrypts - including the very first message, which is what sets the
// peer's mode to "encrypted" from our side.
export function decide_outgoing_mode(
  has_room_key: boolean,
  known_mode: PeerSignalMode | undefined,
): PeerSignalMode {
  if (!has_room_key || known_mode === "plaintext") {
    return "plaintext";
  }
  return "encrypted";
}
