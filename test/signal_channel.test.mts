// Exercises the full signaling pipeline with real crypto: devices are
// signal channels wired together through a fake signaling server that can
// also behave maliciously - reading, rewriting, redirecting, relabelling or
// forging messages - the way a third-party server could.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { create_signal_channel } from "../src/signal_channel.mjs";
import { generate_room_key, import_room_key } from "../src/signal_crypto.mjs";
import type {
  RtcRelayMessage,
  RtcSignalType,
} from "../src/signaling_protocol.mjs";

interface Handled {
  type: RtcSignalType;
  from: string;
  payload: unknown;
}

interface WireMessage {
  type: RtcSignalType;
  from: string;
  to: string;
  payload: unknown;
}

// What the fake server does with each message: deliver it as-is (return it),
// deliver something else, deliver several, or drop it (return []).
type ServerBehaviour = (message: WireMessage) => WireMessage | WireMessage[];

interface Device {
  id: string;
  channel: ReturnType<typeof create_signal_channel>;
  handled: Handled[];
  tampered: { from: string; detail: string }[];
  needs_key: { from: string; detail: string }[];
  logs: string[];
  // Optional extra async work per handled message (e.g. a slow offer).
  on_handle?: (handled: Handled) => Promise<void>;
  // Answer offers automatically, like index.mts's on_offer does.
  auto_answer: boolean;
}

interface Network {
  devices: Map<string, Device>;
  wire: WireMessage[];
  server: ServerBehaviour;
  add(id: string, room_key: CryptoKey | null): Device;
  // Delivers a message to a device as the server would.
  deliver(message: WireMessage): void;
  settle(): Promise<void>;
}

function create_network(): Network {
  const network: Network = {
    devices: new Map(),
    wire: [],
    server: (message) => message,

    add(id, room_key) {
      const device: Device = {
        id,
        handled: [],
        tampered: [],
        needs_key: [],
        logs: [],
        auto_answer: true,
        channel: create_signal_channel({
          send_raw: (type, to, payload) => {
            const sent: WireMessage = { type, from: id, to, payload };
            network.wire.push(sent);
            const out = network.server(sent);
            for (const message of Array.isArray(out) ? out : [out]) {
              network.deliver(message);
            }
          },
          on_tampered: (from, detail) => device.tampered.push({ from, detail }),
          on_needs_key: (from, detail) =>
            device.needs_key.push({ from, detail }),
          log: (label) => device.logs.push(label),
        }),
      };
      device.channel.enter_room(room_key, id);
      network.devices.set(id, device);
      return device;
    },

    deliver(message) {
      const target = network.devices.get(message.to);
      if (target === undefined) {
        return;
      }
      const relayed: RtcRelayMessage = {
        type: message.type,
        from_device_id: message.from,
        payload: message.payload,
      };
      target.channel.receive(relayed, async (payload) => {
        const handled = { type: message.type, from: message.from, payload };
        target.handled.push(handled);
        await target.on_handle?.(handled);
        if (message.type === "offer" && target.auto_answer) {
          target.channel.send("answer", message.from, {
            type: "answer",
            sdp: `answer-from-${target.id}`,
          });
        }
      });
    },

    async settle() {
      // Replies can trigger more traffic, so wait until nothing changes.
      for (let round = 0; round < 20; round++) {
        const before = network.wire.length;
        await Promise.all(
          [...network.devices.values()].map((d) => d.channel.idle()),
        );
        if (network.wire.length === before) {
          return;
        }
      }
      throw new Error("network never settled");
    },
  };
  return network;
}

async function room_key(): Promise<CryptoKey> {
  return import_room_key(generate_room_key());
}

const OFFER = { type: "offer", sdp: "v=0\r\na=fingerprint:sha-256 AA:BB\r\n" };
const candidate = (n: number) => ({ candidate: `candidate:${n}`, sdpMid: "0" });

// The newcomer (caller) offers to an existing room member, then trickles
// ICE - the same order index.mts produces.
function caller_sends(network: Network, from: string, to: string): void {
  const device = network.devices.get(from);
  assert.ok(device);
  device.channel.send("offer", to, OFFER);
  device.channel.send("ice-candidate", to, candidate(1));
  device.channel.send("ice-candidate", to, candidate(2));
}

// reset() empties the queues idle() waits on, so work it orphaned has to
// be given real time to (wrongly) finish before asserting it didn't.
function let_orphaned_work_finish(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 50));
}

function wire_text(network: Network): string {
  return JSON.stringify(network.wire);
}

describe("signal channel: normal exchanges", () => {
  test("two link holders exchange encrypted signaling and are verified", async () => {
    const network = create_network();
    const key = await room_key();
    const a = network.add("a", key);
    const b = network.add("b", key);

    caller_sends(network, "b", "a");
    await network.settle();

    assert.deepEqual(
      a.handled.map((h) => [h.type, h.payload]),
      [
        ["offer", OFFER],
        ["ice-candidate", candidate(1)],
        ["ice-candidate", candidate(2)],
      ],
    );
    assert.deepEqual(
      b.handled.map((h) => h.type),
      ["answer"],
    );
    assert.equal(a.channel.get_mode("b"), "encrypted");
    assert.equal(b.channel.get_mode("a"), "encrypted");
    // Nothing readable crossed the server.
    assert.equal(wire_text(network).includes("fingerprint"), false);
    assert.equal(wire_text(network).includes("candidate:"), false);
    assert.equal(wire_text(network).includes("answer-from"), false);
    assert.deepEqual([...a.tampered, ...b.tampered], []);
  });

  test("a typed-code joiner connects to a link holder unverified, in plaintext both ways", async () => {
    const network = create_network();
    const a = network.add("a", await room_key());
    const typed = network.add("typed", null);

    caller_sends(network, "typed", "a");
    await network.settle();

    assert.deepEqual(
      a.handled.map((h) => h.type),
      ["offer", "ice-candidate", "ice-candidate"],
    );
    assert.deepEqual(
      typed.handled.map((h) => h.type),
      ["answer"],
    );
    assert.equal(a.channel.get_mode("typed"), "plaintext");
    assert.equal(typed.channel.get_mode("a"), "plaintext");
    assert.deepEqual([...a.tampered, ...typed.tampered], []);
  });

  test("two typed-code joiners connect in plaintext", async () => {
    const network = create_network();
    const first = network.add("first", null);
    const second = network.add("second", null);
    caller_sends(network, "second", "first");
    await network.settle();
    assert.equal(first.handled.length, 3);
    assert.deepEqual(
      second.handled.map((h) => h.type),
      ["answer"],
    );
  });

  test("a link holder joining after a typed-code device can't reach it", async () => {
    const network = create_network();
    const typed = network.add("typed", null);
    network.add("late", await room_key());

    caller_sends(network, "late", "typed");
    await network.settle();

    assert.deepEqual(typed.handled, []);
    assert.equal(typed.needs_key.length, 3);
    assert.deepEqual(typed.tampered, []);
  });

  test("an incoming offer is fully handled before that peer's ICE candidates", async () => {
    const network = create_network();
    const key = await room_key();
    const a = network.add("a", key);
    network.add("b", key);
    const events: string[] = [];
    a.on_handle = async (h) => {
      events.push(`start ${h.type}`);
      if (h.type === "offer") {
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      events.push(`end ${h.type}`);
    };

    const b = network.devices.get("b");
    assert.ok(b);
    b.channel.send("offer", "a", OFFER);
    for (let n = 0; n < 10; n++) {
      b.channel.send("ice-candidate", "a", candidate(n));
    }
    await network.settle();

    assert.deepEqual(events.slice(0, 3), [
      "start offer",
      "end offer",
      "start ice-candidate",
    ]);
    assert.deepEqual(
      a.handled.slice(1).map((h) => h.payload),
      Array.from({ length: 10 }, (_, n) => candidate(n)),
    );
  });

  test("outgoing messages reach the wire in the order they were sent", async () => {
    const network = create_network();
    const key = await room_key();
    const a = network.add("a", key);
    network.add("b", key);
    a.channel.send("offer", "b", OFFER);
    for (let n = 0; n < 25; n++) {
      a.channel.send("ice-candidate", "b", candidate(n));
    }
    await network.settle();
    const from_a = network.wire.filter((m) => m.from === "a");
    assert.deepEqual(
      from_a.map((m) => m.type),
      ["offer", ...Array<RtcSignalType>(25).fill("ice-candidate")],
    );
  });
});

describe("signal channel: a malicious signaling server", () => {
  test("tampered ciphertext is reported", async () => {
    const network = create_network();
    const key = await room_key();
    const a = network.add("a", key);
    network.add("b", key);
    network.server = (m) => {
      if (m.type !== "offer") return m;
      const payload = m.payload as { ct: string };
      const ct = (payload.ct[0] === "A" ? "B" : "A") + payload.ct.slice(1);
      return { ...m, payload: { ...payload, ct } };
    };

    caller_sends(network, "b", "a");
    await network.settle();

    assert.equal(
      a.handled.some((h) => h.type === "offer"),
      false,
    );
    assert.equal(a.tampered.length >= 1, true);
    assert.equal(a.tampered[0]?.from, "b");
  });

  test("a message claiming a different sender is reported", async () => {
    const network = create_network();
    const key = await room_key();
    const a = network.add("a", key);
    network.add("b", key);
    network.add("c", key);
    network.server = (m) => (m.from === "b" ? { ...m, from: "c" } : m);

    caller_sends(network, "b", "a");
    await network.settle();

    assert.deepEqual(a.handled, []);
    assert.equal(a.tampered.length, 3);
    assert.equal(
      a.tampered.every((t) => t.from === "c"),
      true,
    );
  });

  test("a message redirected to a different peer is reported", async () => {
    const network = create_network();
    const key = await room_key();
    network.add("a", key);
    network.add("b", key);
    const c = network.add("c", key);
    network.server = (m) => (m.to === "a" ? { ...m, to: "c" } : m);

    caller_sends(network, "b", "a");
    await network.settle();

    assert.deepEqual(c.handled, []);
    assert.equal(c.tampered.length, 3);
  });

  test("an offer relabelled as another message type is reported", async () => {
    const network = create_network();
    const key = await room_key();
    const a = network.add("a", key);
    const b = network.add("b", key);
    network.server = (m) =>
      m.type === "offer" ? { ...m, type: "ice-candidate" } : m;

    b.channel.send("offer", "a", OFFER);
    await network.settle();

    assert.deepEqual(a.handled, []);
    assert.equal(a.tampered.length, 1);
  });

  test("a replayed answer delivered as an offer is reported", async () => {
    const network = create_network();
    const key = await room_key();
    network.add("a", key);
    network.add("b", key);
    const captured: WireMessage[] = [];
    network.server = (m) => {
      if (m.type === "answer") captured.push(m);
      return m;
    };
    caller_sends(network, "b", "a");
    await network.settle();
    const answer = captured[0];
    assert.ok(answer);

    const b = network.devices.get("b");
    assert.ok(b);
    const before = b.handled.length;
    network.deliver({ ...answer, type: "offer" });
    await network.settle();
    assert.equal(b.handled.length, before);
    assert.equal(b.tampered.length, 1);
  });

  test("stripping encryption mid-exchange (downgrade) is reported", async () => {
    const network = create_network();
    const key = await room_key();
    const a = network.add("a", key);
    network.add("b", key);
    network.server = (m) =>
      m.type === "ice-candidate" ? { ...m, payload: candidate(99) } : m;

    caller_sends(network, "b", "a");
    await network.settle();

    assert.deepEqual(
      a.handled.map((h) => h.type),
      ["offer"],
    );
    assert.equal(a.tampered.length, 2);
    assert.equal(a.channel.get_mode("b"), "encrypted");
  });

  test("a plaintext answer to an encrypted offer is reported", async () => {
    const network = create_network();
    const key = await room_key();
    network.add("a", key);
    const b = network.add("b", key);
    network.server = (m) =>
      m.type === "answer"
        ? { ...m, payload: { type: "answer", sdp: "evil" } }
        : m;

    caller_sends(network, "b", "a");
    await network.settle();

    assert.deepEqual(b.handled, []);
    assert.equal(b.tampered.length, 1);
  });

  test("a message encrypted under another room's key is reported", async () => {
    const network = create_network();
    const a = network.add("a", await room_key());
    network.add("b", await room_key());
    caller_sends(network, "b", "a");
    await network.settle();
    assert.deepEqual(a.handled, []);
    assert.equal(a.tampered.length, 3);
  });

  test("plaintext ICE before any offer is dropped quietly", async () => {
    const network = create_network();
    const a = network.add("a", await room_key());
    network.deliver({
      type: "ice-candidate",
      from: "ghost",
      to: "a",
      payload: candidate(1),
    });
    await network.settle();
    assert.deepEqual(a.handled, []);
    assert.deepEqual(a.tampered, []);
    assert.equal(a.logs.length, 1);
  });

  // The accepted cost of the typed-code fallback: a server can forge a
  // plaintext offer from a peer that hasn't signaled yet. It's accepted -
  // but only ever as plaintext, which the UI shows as "unverified". If this
  // test starts failing, the fallback rules changed: make sure that was
  // deliberate.
  test("a forged plaintext offer from a new peer is accepted, but only as unverified", async () => {
    const network = create_network();
    const a = network.add("a", await room_key());
    network.deliver({
      type: "offer",
      from: "mallory",
      to: "a",
      payload: { type: "offer", sdp: "forged" },
    });
    await network.settle();
    assert.deepEqual(
      a.handled.map((h) => h.type),
      ["offer"],
    );
    assert.equal(a.channel.get_mode("mallory"), "plaintext");
  });

  test("a forged plaintext offer can't take over a peer already signaling encrypted", async () => {
    const network = create_network();
    const key = await room_key();
    const a = network.add("a", key);
    network.add("b", key);
    caller_sends(network, "b", "a");
    await network.settle();

    network.deliver({
      type: "offer",
      from: "b",
      to: "a",
      payload: { type: "offer", sdp: "forged" },
    });
    await network.settle();
    assert.equal(a.handled.filter((h) => h.type === "offer").length, 1);
    assert.equal(a.tampered.length, 1);
    assert.equal(a.channel.get_mode("b"), "encrypted");
  });
});

describe("signal channel: lifecycle", () => {
  test("reset drops sends that are still being encrypted", async () => {
    const network = create_network();
    const key = await room_key();
    const a = network.add("a", key);
    network.add("b", key);
    a.channel.send("offer", "b", OFFER);
    a.channel.reset();
    await let_orphaned_work_finish();
    assert.deepEqual(network.wire, []);
  });

  test("reset drops received messages still being decrypted", async () => {
    const network = create_network();
    const key = await room_key();
    const a = network.add("a", key);
    network.add("b", key);
    // Intercept the encrypted offer, then deliver it right before a reset.
    const held: WireMessage[] = [];
    network.server = (m) => {
      held.push(m);
      return [];
    };
    const b = network.devices.get("b");
    assert.ok(b);
    b.channel.send("offer", "a", OFFER);
    await network.settle();
    const offer = held[0];
    assert.ok(offer);

    network.deliver(offer);
    a.channel.reset();
    await let_orphaned_work_finish();
    assert.deepEqual(a.handled, []);
    assert.deepEqual(a.tampered, []);
  });

  test("reset forgets peer modes and the room key", async () => {
    const network = create_network();
    const key = await room_key();
    const a = network.add("a", key);
    network.add("b", key);
    caller_sends(network, "b", "a");
    await network.settle();
    assert.equal(a.channel.get_mode("b"), "encrypted");

    a.channel.reset();
    assert.equal(a.channel.get_mode("b"), undefined);
    // With no key any more, a's next send goes out in plaintext.
    a.channel.enter_room(null, "a");
    a.channel.send("offer", "b", OFFER);
    await network.settle();
    const last = network.wire.at(-1);
    assert.deepEqual(last?.payload, OFFER);
  });

  test("forget_peer lets a peer start over (e.g. after peer-left)", async () => {
    const network = create_network();
    const key = await room_key();
    const a = network.add("a", key);
    network.add("b", key);
    caller_sends(network, "b", "a");
    await network.settle();

    a.channel.forget_peer("b");
    assert.equal(a.channel.get_mode("b"), undefined);
  });

  test("a failing send is logged and doesn't block later sends", async () => {
    const network = create_network();
    const key = await room_key();
    network.add("a", key);
    network.add("b", key);
    let fail_next = true;
    network.server = (m) => {
      if (fail_next) {
        fail_next = false;
        throw new Error("socket closed");
      }
      return m;
    };
    const a = network.devices.get("a");
    assert.ok(a);
    a.channel.send("ice-candidate", "b", candidate(1));
    a.channel.send("ice-candidate", "b", candidate(2));
    await network.settle();
    assert.equal(
      a.logs.some((l) => l.includes("could not send")),
      true,
    );
    assert.equal(network.wire.length, 2);
  });

  test("a failing handler is logged and doesn't block later messages", async () => {
    const network = create_network();
    const key = await room_key();
    const a = network.add("a", key);
    network.add("b", key);
    a.auto_answer = false;
    let fail_next = true;
    a.on_handle = async () => {
      if (fail_next) {
        fail_next = false;
        throw new Error("setRemoteDescription failed");
      }
    };
    caller_sends(network, "b", "a");
    await network.settle();
    assert.equal(a.handled.length, 3);
    assert.equal(
      a.logs.some((l) => l.includes("error handling offer")),
      true,
    );
    assert.deepEqual(a.tampered, []);
  });
});
