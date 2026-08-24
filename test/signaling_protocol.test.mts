import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  build_join_message,
  build_leave_message,
  build_offer_message,
  build_answer_message,
  build_ice_candidate_message,
  parse_server_message,
} from "../src/signaling_protocol.mjs";

describe("build_join_message", () => {
  test("omits room_code when creating a new room", () => {
    const raw = build_join_message();
    assert.deepEqual(JSON.parse(raw), { type: "join" });
  });

  test("includes room_code when joining an existing room", () => {
    const raw = build_join_message("ABCD1234");
    assert.deepEqual(JSON.parse(raw), { type: "join", room_code: "ABCD1234" });
  });
});

describe("build_leave_message", () => {
  test("produces a bare leave message", () => {
    const raw = build_leave_message();
    assert.deepEqual(JSON.parse(raw), { type: "leave" });
  });
});

describe("rtc signal message builders", () => {
  test("build_offer_message includes target and payload", () => {
    const raw = build_offer_message("device-1", { sdp: "fake-sdp" });
    assert.deepEqual(JSON.parse(raw), {
      type: "offer",
      target_device_id: "device-1",
      payload: { sdp: "fake-sdp" },
    });
  });

  test("build_answer_message includes target and payload", () => {
    const raw = build_answer_message("device-2", { sdp: "fake-answer" });
    assert.deepEqual(JSON.parse(raw), {
      type: "answer",
      target_device_id: "device-2",
      payload: { sdp: "fake-answer" },
    });
  });

  test("build_ice_candidate_message includes target and payload", () => {
    const raw = build_ice_candidate_message("device-3", { candidate: "fake" });
    assert.deepEqual(JSON.parse(raw), {
      type: "ice-candidate",
      target_device_id: "device-3",
      payload: { candidate: "fake" },
    });
  });
});

describe("parse_server_message - valid messages", () => {
  test("parses room-created", () => {
    const result = parse_server_message(
      JSON.stringify({ type: "room-created", room_code: "AB12", device_id: "d1" }),
    );
    assert.equal(result.ok, true);
    assert.deepEqual(
      result.ok ? result.message : null,
      { type: "room-created", room_code: "AB12", device_id: "d1" },
    );
  });

  test("parses room-joined with peer_device_ids", () => {
    const result = parse_server_message(
      JSON.stringify({
        type: "room-joined",
        room_code: "AB12",
        device_id: "d1",
        peer_device_ids: ["d2", "d3"],
      }),
    );
    assert.equal(result.ok, true);
    assert.deepEqual(
      result.ok ? result.message : null,
      {
        type: "room-joined",
        room_code: "AB12",
        device_id: "d1",
        peer_device_ids: ["d2", "d3"],
      },
    );
  });

  test("parses peer-joined", () => {
    const result = parse_server_message(
      JSON.stringify({ type: "peer-joined", device_id: "d2" }),
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.ok ? result.message : null, {
      type: "peer-joined",
      device_id: "d2",
    });
  });

  test("parses peer-left", () => {
    const result = parse_server_message(
      JSON.stringify({ type: "peer-left", device_id: "d2" }),
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.ok ? result.message : null, {
      type: "peer-left",
      device_id: "d2",
    });
  });

  test("parses offer relay with opaque payload", () => {
    const result = parse_server_message(
      JSON.stringify({ type: "offer", from_device_id: "d2", payload: { sdp: "x" } }),
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.ok ? result.message : null, {
      type: "offer",
      from_device_id: "d2",
      payload: { sdp: "x" },
    });
  });

  test("parses answer relay", () => {
    const result = parse_server_message(
      JSON.stringify({ type: "answer", from_device_id: "d1", payload: { sdp: "y" } }),
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.ok ? result.message : null, {
      type: "answer",
      from_device_id: "d1",
      payload: { sdp: "y" },
    });
  });

  test("parses ice-candidate relay", () => {
    const result = parse_server_message(
      JSON.stringify({
        type: "ice-candidate",
        from_device_id: "d1",
        payload: { candidate: "z" },
      }),
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.ok ? result.message : null, {
      type: "ice-candidate",
      from_device_id: "d1",
      payload: { candidate: "z" },
    });
  });

  test("parses error", () => {
    const result = parse_server_message(
      JSON.stringify({ type: "error", message: "room not found" }),
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.ok ? result.message : null, {
      type: "error",
      message: "room not found",
    });
  });

  test("relay payload of null is preserved, not treated as missing", () => {
    const result = parse_server_message(
      JSON.stringify({ type: "offer", from_device_id: "d2", payload: null }),
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.ok ? result.message : null, {
      type: "offer",
      from_device_id: "d2",
      payload: null,
    });
  });
});

describe("parse_server_message - malformed input", () => {
  test("rejects invalid JSON", () => {
    const result = parse_server_message("{not json");
    assert.equal(result.ok, false);
  });

  test("rejects JSON that is not an object", () => {
    const result = parse_server_message(JSON.stringify(["room-created"]));
    assert.equal(result.ok, false);
  });

  test("rejects missing type field", () => {
    const result = parse_server_message(JSON.stringify({ device_id: "d1" }));
    assert.equal(result.ok, false);
  });

  test("rejects unknown type", () => {
    const result = parse_server_message(JSON.stringify({ type: "not-a-real-type" }));
    assert.equal(result.ok, false);
  });

  test("rejects room-created missing device_id", () => {
    const result = parse_server_message(
      JSON.stringify({ type: "room-created", room_code: "AB12" }),
    );
    assert.equal(result.ok, false);
  });

  test("rejects room-joined with non-array peer_device_ids", () => {
    const result = parse_server_message(
      JSON.stringify({
        type: "room-joined",
        room_code: "AB12",
        device_id: "d1",
        peer_device_ids: "d2",
      }),
    );
    assert.equal(result.ok, false);
  });

  test("rejects room-joined with non-string entries in peer_device_ids", () => {
    const result = parse_server_message(
      JSON.stringify({
        type: "room-joined",
        room_code: "AB12",
        device_id: "d1",
        peer_device_ids: ["d2", 3],
      }),
    );
    assert.equal(result.ok, false);
  });

  test("rejects peer-joined missing device_id", () => {
    const result = parse_server_message(JSON.stringify({ type: "peer-joined" }));
    assert.equal(result.ok, false);
  });

  test("rejects offer relay missing from_device_id", () => {
    const result = parse_server_message(
      JSON.stringify({ type: "offer", payload: { sdp: "x" } }),
    );
    assert.equal(result.ok, false);
  });

  test("rejects offer relay missing payload key entirely", () => {
    const result = parse_server_message(
      JSON.stringify({ type: "offer", from_device_id: "d2" }),
    );
    assert.equal(result.ok, false);
  });

  test("rejects error missing message", () => {
    const result = parse_server_message(JSON.stringify({ type: "error" }));
    assert.equal(result.ok, false);
  });
});
