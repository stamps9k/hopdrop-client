// Pure logic for deciding WebRTC negotiation roles. No RTCPeerConnection or
// any browser API is touched here - that lives in peer_connection.mts, which
// consults this module for "what do I do next" decisions. Kept separate so
// the role-assignment rule can be unit tested without a real WebRTC stack.
//
// Rule: for each peer, exactly one side initiates the offer, decided by how
// that peer was discovered:
//   - Peers listed in room-joined's peer_device_ids were already in the room
//     before this device joined -> this device is the "caller" and initiates
//     an offer to each of them.
//   - Peers announced later via peer-joined joined *after* this device -> the
//     newcomer is responsible for initiating; this device is the "callee"
//     and waits for their offer.
// This gives a deterministic, glare-free assignment without comparing
// device_ids: whichever side's join was the "later" event, relative to a
// given peer, is the one that reaches out.

import type {
  PeerJoinedMessage,
  PeerLeftMessage,
  RoomJoinedMessage,
} from "./signaling_protocol.mjs";

export type NegotiationRole = "caller" | "callee";

export interface PeerNegotiationState {
  device_id: string;
  role: NegotiationRole;
  offer_sent: boolean;
}

const peer_roles = new Map<string, PeerNegotiationState>();

function register_peer_if_absent(
  device_id: string,
  role: NegotiationRole,
): PeerNegotiationState {
  const existing = peer_roles.get(device_id);
  if (existing !== undefined) {
    // Idempotent on purpose: a duplicate room-joined/peer-joined for a peer
    // we already know about (e.g. a reconnect race) must not reset
    // offer_sent, or we'd risk sending a second offer to the same peer.
    return existing;
  }
  const state: PeerNegotiationState = { device_id, role, offer_sent: false };
  peer_roles.set(device_id, state);
  return state;
}

// Call once when this device's room-joined arrives. Registers every peer
// already present in the room with role "caller" and returns their states
// so the caller can immediately begin sending offers to each.
export function register_existing_peers(
  room_joined: RoomJoinedMessage,
): PeerNegotiationState[] {
  return room_joined.peer_device_ids.map((device_id) =>
    register_peer_if_absent(device_id, "caller"),
  );
}

// Call for each peer-joined event received after this device is already in
// the room. Registers that peer with role "callee".
export function register_new_peer(
  peer_joined: PeerJoinedMessage,
): PeerNegotiationState {
  return register_peer_if_absent(peer_joined.device_id, "callee");
}

// Call for each peer-left event to stop tracking that peer.
export function remove_peer(peer_left: PeerLeftMessage): void {
  peer_roles.delete(peer_left.device_id);
}

export function get_peer_state(
  device_id: string,
): PeerNegotiationState | undefined {
  return peer_roles.get(device_id);
}

// True only for a known peer whose role is "caller" and who hasn't been
// offered to yet. peer_connection.mts should check this before creating and
// sending an SDP offer.
export function should_send_offer(device_id: string): boolean {
  const state = peer_roles.get(device_id);
  return state !== undefined && state.role === "caller" && !state.offer_sent;
}

// Call once an offer has actually been sent to this peer, so a duplicate
// peer-joined/room-joined can't trigger a second one.
export function mark_offer_sent(device_id: string): void {
  const state = peer_roles.get(device_id);
  if (state !== undefined) {
    state.offer_sent = true;
  }
}

export function list_known_peers(): PeerNegotiationState[] {
  return [...peer_roles.values()];
}

// Test-only reset, mirroring hopdrop-signaling's clear_all_*_state()
// convention so each test starts from a clean module-level state.
export function clear_all_negotiation_state(): void {
  peer_roles.clear();
}
