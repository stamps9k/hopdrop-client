import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  register_existing_peers,
  register_new_peer,
  remove_peer,
  get_peer_state,
  should_send_offer,
  mark_offer_sent,
  list_known_peers,
  clear_all_negotiation_state,
} from "../src/rtc_negotiation.mjs";

beforeEach(() => {
  clear_all_negotiation_state();
});

describe("register_existing_peers", () => {
  test("assigns role caller with offer_sent false to each peer_device_id", () => {
    const states = register_existing_peers({
      type: "room-joined",
      room_code: "AB12",
      device_id: "me",
      peer_device_ids: ["d1", "d2"],
    });
    assert.deepEqual(states, [
      { device_id: "d1", role: "caller", offer_sent: false },
      { device_id: "d2", role: "caller", offer_sent: false },
    ]);
    assert.deepEqual(get_peer_state("d1"), {
      device_id: "d1",
      role: "caller",
      offer_sent: false,
    });
  });

  test("returns an empty array when the room was created fresh", () => {
    const states = register_existing_peers({
      type: "room-joined",
      room_code: "AB12",
      device_id: "me",
      peer_device_ids: [],
    });
    assert.deepEqual(states, []);
    assert.deepEqual(list_known_peers(), []);
  });

  test("is idempotent - a duplicate call does not reset offer_sent", () => {
    register_existing_peers({
      type: "room-joined",
      room_code: "AB12",
      device_id: "me",
      peer_device_ids: ["d1"],
    });
    mark_offer_sent("d1");

    register_existing_peers({
      type: "room-joined",
      room_code: "AB12",
      device_id: "me",
      peer_device_ids: ["d1"],
    });

    assert.equal(get_peer_state("d1")?.offer_sent, true);
  });
});

describe("register_new_peer", () => {
  test("assigns role callee with offer_sent false", () => {
    const state = register_new_peer({ type: "peer-joined", device_id: "d3" });
    assert.deepEqual(state, { device_id: "d3", role: "callee", offer_sent: false });
    assert.deepEqual(get_peer_state("d3"), state);
  });

  test("is idempotent - a duplicate peer-joined does not change existing state", () => {
    const first = register_new_peer({ type: "peer-joined", device_id: "d3" });
    mark_offer_sent("d3"); // shouldn't normally happen for a callee, but exercises idempotency regardless
    const second = register_new_peer({ type: "peer-joined", device_id: "d3" });
    assert.equal(second, first);
    assert.equal(get_peer_state("d3")?.offer_sent, true);
  });
});

describe("should_send_offer", () => {
  test("true for a caller that has not been offered to yet", () => {
    register_existing_peers({
      type: "room-joined",
      room_code: "AB12",
      device_id: "me",
      peer_device_ids: ["d1"],
    });
    assert.equal(should_send_offer("d1"), true);
  });

  test("false for a callee", () => {
    register_new_peer({ type: "peer-joined", device_id: "d2" });
    assert.equal(should_send_offer("d2"), false);
  });

  test("false for an unknown device_id", () => {
    assert.equal(should_send_offer("ghost"), false);
  });

  test("false after mark_offer_sent has been called", () => {
    register_existing_peers({
      type: "room-joined",
      room_code: "AB12",
      device_id: "me",
      peer_device_ids: ["d1"],
    });
    mark_offer_sent("d1");
    assert.equal(should_send_offer("d1"), false);
  });
});

describe("mark_offer_sent", () => {
  test("is a no-op for an unknown device_id (does not throw)", () => {
    assert.doesNotThrow(() => mark_offer_sent("ghost"));
  });
});

describe("remove_peer", () => {
  test("removes tracked state so get_peer_state returns undefined", () => {
    register_new_peer({ type: "peer-joined", device_id: "d4" });
    remove_peer({ type: "peer-left", device_id: "d4" });
    assert.equal(get_peer_state("d4"), undefined);
  });

  test("should_send_offer is false after removal even if it was a caller", () => {
    register_existing_peers({
      type: "room-joined",
      room_code: "AB12",
      device_id: "me",
      peer_device_ids: ["d1"],
    });
    remove_peer({ type: "peer-left", device_id: "d1" });
    assert.equal(should_send_offer("d1"), false);
  });

  test("removing an unknown device_id does not throw", () => {
    assert.doesNotThrow(() => remove_peer({ type: "peer-left", device_id: "ghost" }));
  });
});

describe("list_known_peers", () => {
  test("reflects a mix of caller and callee peers currently tracked", () => {
    register_existing_peers({
      type: "room-joined",
      room_code: "AB12",
      device_id: "me",
      peer_device_ids: ["d1", "d2"],
    });
    register_new_peer({ type: "peer-joined", device_id: "d3" });

    const peers = list_known_peers();
    assert.equal(peers.length, 3);
    assert.deepEqual(
      new Set(peers.map((p) => p.device_id)),
      new Set(["d1", "d2", "d3"]),
    );
  });
});

describe("clear_all_negotiation_state", () => {
  test("empties all tracked peers", () => {
    register_existing_peers({
      type: "room-joined",
      room_code: "AB12",
      device_id: "me",
      peer_device_ids: ["d1"],
    });
    clear_all_negotiation_state();
    assert.deepEqual(list_known_peers(), []);
    assert.equal(get_peer_state("d1"), undefined);
  });
});
