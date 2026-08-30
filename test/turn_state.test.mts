import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  reset_turn_state,
  begin_turn_request,
  resolve_turn_credentials,
  is_turn_request_pending,
  get_rtc_config_when_ready,
} from "../src/turn_state.mjs";

const FAKE_ICE_SERVERS: RTCIceServer[] = [
  {
    urls: "turn:standard.relay.metered.ca:80",
    username: "u",
    credential: "p",
  },
];

// turn_state.mts holds module-level state shared across every test in this
// file, so each test needs a clean slate.
beforeEach(() => {
  reset_turn_state();
});

describe("baseline state (no TURN request ever begun)", () => {
  test("get_rtc_config_when_ready resolves to undefined immediately", async () => {
    const config = await get_rtc_config_when_ready();
    assert.equal(config, undefined);
  });

  test("is_turn_request_pending is false", () => {
    assert.equal(is_turn_request_pending(), false);
  });
});

describe("begin_turn_request / resolve_turn_credentials", () => {
  test("is_turn_request_pending is true once a request has begun", () => {
    begin_turn_request();
    assert.equal(is_turn_request_pending(), true);
  });

  test("get_rtc_config_when_ready does not resolve until resolve_turn_credentials is called", async () => {
    begin_turn_request();

    let resolved = false;
    const config_promise = get_rtc_config_when_ready().then((config) => {
      resolved = true;
      return config;
    });

    // Give a wrongly-immediate resolution a chance to happen before we
    // assert it hasn't.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(resolved, false);

    resolve_turn_credentials(FAKE_ICE_SERVERS);
    await config_promise;

    assert.equal(resolved, true);
  });

  test("resolved config merges the default STUN server with the TURN servers and sets iceTransportPolicy to all", async () => {
    begin_turn_request();
    resolve_turn_credentials(FAKE_ICE_SERVERS);

    const config = await get_rtc_config_when_ready();

    assert.ok(config);
    assert.equal(config.iceTransportPolicy, "all");
    assert.ok(config.iceServers);
    // The default STUN entry plus the one TURN entry supplied.
    assert.equal(config.iceServers.length, 2);
    assert.deepEqual(config.iceServers[1], FAKE_ICE_SERVERS[0]);
  });

  test("is_turn_request_pending is false once resolved", () => {
    begin_turn_request();
    resolve_turn_credentials(FAKE_ICE_SERVERS);
    assert.equal(is_turn_request_pending(), false);
  });

  test("a second get_rtc_config_when_ready call after resolution returns the same config", async () => {
    begin_turn_request();
    resolve_turn_credentials(FAKE_ICE_SERVERS);

    const first = await get_rtc_config_when_ready();
    const second = await get_rtc_config_when_ready();

    assert.equal(first, second);
  });

  test("resolve_turn_credentials with nothing pending still sets the config (harmless no-op on the pending side)", async () => {
    resolve_turn_credentials(FAKE_ICE_SERVERS);

    const config = await get_rtc_config_when_ready();
    assert.ok(config);
    assert.equal(is_turn_request_pending(), false);
  });
});

describe("reset_turn_state", () => {
  test("clears a resolved config back to undefined", async () => {
    begin_turn_request();
    resolve_turn_credentials(FAKE_ICE_SERVERS);

    reset_turn_state();

    const config = await get_rtc_config_when_ready();
    assert.equal(config, undefined);
  });

  test("is a harmless no-op when nothing was pending", () => {
    assert.doesNotThrow(() => reset_turn_state());
  });

  test("rejects an outstanding wait", async () => {
    begin_turn_request();
    const config_promise = get_rtc_config_when_ready();

    reset_turn_state();

    await assert.rejects(config_promise);
  });

  test("is_turn_request_pending is false after reset, even if a request was pending", () => {
    begin_turn_request();
    reset_turn_state();
    assert.equal(is_turn_request_pending(), false);
  });

  test("a fresh begin_turn_request after reset starts a clean wait, unaffected by the earlier rejection", async () => {
    begin_turn_request();
    reset_turn_state();

    begin_turn_request();
    resolve_turn_credentials(FAKE_ICE_SERVERS);

    const config = await get_rtc_config_when_ready();
    assert.ok(config);
  });
});

describe("begin_turn_request called again while already pending (defensive path)", () => {
  test("rejects the first wait rather than leaving it to hang", async () => {
    begin_turn_request();
    const first_wait = get_rtc_config_when_ready();

    begin_turn_request();

    await assert.rejects(first_wait);
  });

  test("the second request can still resolve normally afterward", async () => {
    begin_turn_request();
    begin_turn_request();
    resolve_turn_credentials(FAKE_ICE_SERVERS);

    const config = await get_rtc_config_when_ready();
    assert.ok(config);
  });
});
