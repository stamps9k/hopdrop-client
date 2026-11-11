// The per-peer signaling pipeline: encrypting/decrypting SDP/ICE payloads,
// keeping each peer's messages in order, and enforcing signal_trust.mts's
// rules about which messages to accept. Lives apart from index.mts so the
// whole pipeline - not just its pure decision rules - can be tested under
// node:test with real crypto, by wiring channels together through a fake
// signaling server (see test/signal_channel.test.mts). It has no DOM or
// WebSocket reference: index.mts hands it a send_raw function and a handler
// for each incoming message.
//
// The ordering guarantees matter for correctness, not just tidiness:
//   - A peer's signaling mode is decided and recorded synchronously, the
//     moment a message is sent or arrives, never after an await - arrival
//     order is what signal_trust.mts's rules are about.
//   - Encryption and decryption are async, so each peer has an outgoing and
//     an incoming FIFO queue. Without them, a quick-to-encrypt ICE candidate
//     could overtake the offer it belongs to, and an incoming candidate
//     could be applied before its offer.
//   - reset() starts a new generation; anything still queued from before it
//     drops itself instead of sending or being handled.

import type { RtcRelayMessage, RtcSignalType } from "./signaling_protocol.mjs";
import {
  decrypt_signal_payload,
  encrypt_signal_payload,
  is_encrypted_signal_payload,
  SignalDecryptionError,
} from "./signal_crypto.mjs";
import {
  decide_incoming_signal,
  decide_outgoing_mode,
  type PeerSignalMode,
} from "./signal_trust.mjs";

export interface SignalChannelOptions {
  // Puts an already-prepared (possibly encrypted) payload on the wire. May
  // throw (e.g. the socket closed) - that's caught and logged.
  send_raw: (type: RtcSignalType, device_id: string, payload: unknown) => void;
  // Signaling from this peer failed verification - only interference
  // between the two devices explains it.
  on_tampered: (device_id: string, detail: string) => void;
  // This device has no room key (joined by typed code) and the peer is
  // encrypting - it can't connect to that peer.
  on_needs_key: (device_id: string, detail: string) => void;
  log: (label: string, data?: unknown) => void;
}

export interface SignalChannel {
  // Call once the server confirms a join. room_key is null for a device
  // that joined by typed room code (plaintext signaling).
  enter_room(room_key: CryptoKey | null, my_device_id: string): void;
  // Leaves the room: forgets the key and every peer's mode, and drops
  // anything still queued.
  reset(): void;
  send(type: RtcSignalType, device_id: string, payload: unknown): void;
  // `handle` gets the decrypted (or accepted plaintext) payload, in arrival
  // order per peer, each call finishing before the next starts.
  receive(
    message: RtcRelayMessage,
    handle: (payload: unknown) => Promise<void>,
  ): void;
  get_mode(device_id: string): PeerSignalMode | undefined;
  forget_peer(device_id: string): void;
  // Resolves once everything queued so far has been sent or handled.
  // Mainly for tests.
  idle(): Promise<void>;
}

function describe_error(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function create_signal_channel(
  options: SignalChannelOptions,
): SignalChannel {
  let room_key: CryptoKey | null = null;
  let my_device_id: string | null = null;
  let generation = 0;
  const peer_modes = new Map<string, PeerSignalMode>();
  const outgoing_queues = new Map<string, Promise<void>>();
  const incoming_queues = new Map<string, Promise<void>>();

  function enqueue(
    queues: Map<string, Promise<void>>,
    device_id: string,
    task: () => Promise<void>,
    on_error: (error: unknown) => void,
  ): void {
    const previous = queues.get(device_id) ?? Promise.resolve();
    // .catch keeps the chain alive: one failed message mustn't stall every
    // later one for that peer.
    queues.set(device_id, previous.then(task).catch(on_error));
  }

  return {
    enter_room(key, device_id) {
      room_key = key;
      my_device_id = device_id;
    },

    reset() {
      generation++;
      room_key = null;
      my_device_id = null;
      peer_modes.clear();
      outgoing_queues.clear();
      incoming_queues.clear();
    },

    send(type, device_id, payload) {
      const key = room_key;
      const from_device_id = my_device_id;
      const sent_in = generation;
      const mode = decide_outgoing_mode(
        key !== null,
        peer_modes.get(device_id),
      );
      if (!peer_modes.has(device_id)) {
        peer_modes.set(device_id, mode);
      }

      enqueue(
        outgoing_queues,
        device_id,
        async () => {
          let wire_payload = payload;
          if (mode === "encrypted") {
            if (key === null || from_device_id === null) {
              return;
            }
            wire_payload = await encrypt_signal_payload(key, payload, {
              type,
              from_device_id,
              to_device_id: device_id,
            });
          }
          if (sent_in !== generation) {
            return;
          }
          options.send_raw(type, device_id, wire_payload);
        },
        (error) => {
          options.log(
            `could not send ${type} to ${device_id}`,
            describe_error(error),
          );
        },
      );
    },

    receive(message, handle) {
      const device_id = message.from_device_id;
      const envelope = is_encrypted_signal_payload(message.payload)
        ? message.payload
        : undefined;
      const decision = decide_incoming_signal({
        has_room_key: room_key !== null,
        is_encrypted: envelope !== undefined,
        known_mode: peer_modes.get(device_id),
        type: message.type,
      });
      if (decision.kind === "reject") {
        switch (decision.reason) {
          case "tampered":
            options.on_tampered(device_id, decision.detail);
            break;
          case "needs_key":
            options.on_needs_key(device_id, decision.detail);
            break;
          case "out_of_order":
            options.log(
              `dropped signaling message from ${device_id}`,
              decision.detail,
            );
            break;
        }
        return;
      }
      if (!peer_modes.has(device_id)) {
        peer_modes.set(device_id, decision.mode);
      }

      const key = room_key;
      const to_device_id = my_device_id;
      const received_in = generation;
      enqueue(
        incoming_queues,
        device_id,
        async () => {
          let payload = message.payload;
          if (envelope !== undefined) {
            if (key === null || to_device_id === null) {
              return;
            }
            payload = await decrypt_signal_payload(key, envelope, {
              type: message.type,
              from_device_id: device_id,
              to_device_id,
            });
          }
          if (received_in !== generation) {
            return;
          }
          await handle(payload);
        },
        (error) => {
          if (error instanceof SignalDecryptionError) {
            if (received_in === generation) {
              options.on_tampered(device_id, error.message);
            }
            return;
          }
          options.log(
            `error handling ${message.type} from ${device_id}`,
            describe_error(error),
          );
        },
      );
    },

    get_mode(device_id) {
      return peer_modes.get(device_id);
    },

    forget_peer(device_id) {
      peer_modes.delete(device_id);
      outgoing_queues.delete(device_id);
      incoming_queues.delete(device_id);
    },

    async idle() {
      // Loop because a settling task (e.g. a handler sending a reply) can
      // queue more work.
      for (;;) {
        const pending = [
          ...outgoing_queues.values(),
          ...incoming_queues.values(),
        ];
        await Promise.all(pending);
        const now = [...outgoing_queues.values(), ...incoming_queues.values()];
        if (
          now.length === pending.length &&
          now.every((p, i) => p === pending[i])
        ) {
          return;
        }
      }
    },
  };
}
