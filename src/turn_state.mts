// Tracks the TURN-credential-fetch state for whichever room this device
// currently belongs to. Pure state and promise bookkeeping - no
// RTCPeerConnection, no WebSocket - mirroring rtc_negotiation.mts's split:
// this module decides what index.mts should wait for and what config to
// use, but doesn't touch the network or the WebRTC APIs itself. Kept
// separate specifically so this (non-trivial: a deferred promise, multiple
// call sites racing against it) piece of state can be unit tested in
// isolation.
//
// Lifecycle, driven entirely by index.mts's signaling handlers:
//   - room-created / room-joined: call reset_turn_state() first (clears
//     anything left from a previous room), then, if is_turn is true, call
//     begin_turn_request() and send request-turn-credentials.
//   - turn-credentials arrives: call resolve_turn_credentials(ice_servers).
//   - room-expired arrives (the normal way a failed fetch surfaces - see
//     hopdrop-signaling's close_room_due_to_turn_failure): call
//     reset_turn_state(), which rejects any outstanding wait.
//   - a bare server error arrives while is_turn_request_pending() is true
//     (the rarer, defensive request-turn-credentials error paths - e.g.
//     the room somehow no longer exists by the time the request lands):
//     also call reset_turn_state(), for the same reason.
//   - leaving the room: call reset_turn_state().
//
// Anywhere a peer connection might be created (on_room_joined's initial
// offer loop, on_peer_joined, on_offer) should await
// get_rtc_config_when_ready() first. For a non-TURN room this resolves
// immediately with undefined - a complete no-op - so existing behavior for
// rooms that never touch TURN is unaffected.

import { create_turn_enabled_rtc_config } from "./peer_connection.mjs";

let current_config: RTCConfiguration | undefined;
let ready_promise: Promise<void> = Promise.resolve();
let pending_resolve: (() => void) | undefined;
let pending_reject: ((reason?: unknown) => void) | undefined;

/**
 * Resets to the baseline "no TURN request in flight, no config" state.
 * Rejects any outstanding wait first, so a caller currently blocked in
 * get_rtc_config_when_ready() (e.g. on_peer_joined mid-await when
 * room-expired arrives) gets a rejection to catch and bail out on, rather
 * than hanging forever. Safe to call even when nothing was pending - the
 * rejection call is then just a no-op.
 */
export function reset_turn_state(): void {
  pending_reject?.(new Error("TURN state was reset"));
  current_config = undefined;
  pending_resolve = undefined;
  pending_reject = undefined;
  ready_promise = Promise.resolve();
}

/**
 * Starts a new pending wait - call once the current room is confirmed
 * is_turn: true, right before sending request-turn-credentials. Callers of
 * get_rtc_config_when_ready() block until resolve_turn_credentials (or a
 * reset_turn_state()) settles it.
 */
export function begin_turn_request(): void {
  // Defensive: reset_turn_state() is always supposed to run first (see
  // module comment), so this should never fire on an already-pending
  // request in practice - but if it somehow did, the stale wait shouldn't
  // be left to hang forever.
  pending_reject?.(
    new Error("a new TURN credential request superseded this one"),
  );
  current_config = undefined;
  const promise = new Promise<void>((resolve, reject) => {
    pending_resolve = resolve;
    pending_reject = reject;
  });
  // Attached immediately so a rejection is always "observed", even if
  // nothing has called get_rtc_config_when_ready() yet - avoids a spurious
  // unhandled-rejection warning if this promise is rejected (via
  // reset_turn_state() or a second begin_turn_request()) before any real
  // caller starts awaiting it. Real callers still see the rejection
  // through their own await - multiple handlers can observe one promise.
  promise.catch(() => {});
  ready_promise = promise;
}

/**
 * Call when a turn-credentials message arrives. Builds the RTCConfiguration
 * from the already-validated ice_servers (see signaling_protocol.mts's
 * is_rtc_ice_server_array) and unblocks anything waiting on
 * get_rtc_config_when_ready(). A harmless no-op (still updates the config)
 * if nothing was actually pending.
 */
export function resolve_turn_credentials(ice_servers: RTCIceServer[]): void {
  current_config = create_turn_enabled_rtc_config(ice_servers);
  pending_resolve?.();
  pending_resolve = undefined;
  pending_reject = undefined;
}

/**
 * True while a begin_turn_request() is outstanding with no
 * resolve_turn_credentials() or reset_turn_state() call yet. Used by
 * index.mts's on_server_error to decide whether a bare error is plausibly
 * this pending request failing via one of request-turn-credentials'
 * defensive error paths (not the normal failure path, which is
 * room-expired - see the module comment).
 */
export function is_turn_request_pending(): boolean {
  return pending_resolve !== undefined;
}

/**
 * Resolves once this room's RTC config is settled: immediately with
 * undefined for a room that never called begin_turn_request() (no TURN, or
 * state was reset), or with the built config once
 * resolve_turn_credentials() runs. Rejects if reset_turn_state() fires
 * first (room-expired, a defensive server error, or leaving) - callers
 * should catch this and skip creating a peer connection rather than
 * proceeding, since the room is gone by that point.
 */
export async function get_rtc_config_when_ready(): Promise<
  RTCConfiguration | undefined
> {
  await ready_promise;
  return current_config;
}
