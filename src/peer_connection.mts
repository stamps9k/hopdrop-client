// Thin wrapper around a single RTCPeerConnection for one peer. Not unit
// tested - node:test has no WebRTC implementation, and mocking
// RTCPeerConnection deeply enough to test anything meaningful would just be
// testing the mock. This is verified by hand across two real browser
// tabs/devices, the same way signaling_socket.mts is.
//
// Role (caller vs callee) is decided elsewhere, by rtc_negotiation.mts. This
// module doesn't know or care why it's being asked to create an offer versus
// handle a remote one - it just does the RTCPeerConnection mechanics.

// Public STUN server as a placeholder for NAT traversal. Since hopdrop is
// self-hosted, a TURN server may be worth adding later for the subset of
// NAT combinations plain STUN can't solve, but STUN-only is the right
// starting point for direct P2P testing.
const DEFAULT_RTC_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

const DATA_CHANNEL_LABEL = "file-transfer";

/**
 * Builds an RTCConfiguration for an is_turn room: the default STUN server
 * plus the room's TURN servers, with iceTransportPolicy left at "all" so
 * ICE still prefers a direct host/srflx path and only falls back to relay
 * if one can't be established. Merging - not replacing - STUN is required
 * here: "all" only chooses among candidate types actually present in
 * iceServers, so a direct path can never be found if STUN isn't included
 * alongside the TURN entries. ice_servers is expected to already be
 * validated (see signaling_protocol.mts's is_rtc_ice_server_array) by the
 * time it reaches this function - no re-validation here.
 */
export function create_turn_enabled_rtc_config(
  ice_servers: RTCIceServer[],
): RTCConfiguration {
  return {
    iceServers: [...(DEFAULT_RTC_CONFIG.iceServers ?? []), ...ice_servers],
    iceTransportPolicy: "all",
  };
}

export interface PeerConnectionHandlers {
  on_data_channel_open?: (channel: RTCDataChannel) => void;
  on_data_channel_close?: () => void;
  on_data_channel_message?: (event: MessageEvent) => void;
  on_connection_state_change?: (state: RTCPeerConnectionState) => void;
  // A local ICE candidate that needs to be sent to the peer via the
  // signaling socket. Fires repeatedly during gathering (trickle ICE).
  on_local_ice_candidate?: (candidate: RTCIceCandidate) => void;
}

export interface PeerConnection {
  readonly device_id: string;
  // Caller side: creates the data channel, an SDP offer, sets it as the
  // local description, and returns it for the caller to send via signaling.
  create_and_send_offer(): Promise<RTCSessionDescriptionInit>;
  // Callee side: applies a remote offer, creates an SDP answer, sets it as
  // the local description, and returns it for the caller to send back.
  handle_remote_offer(
    offer: RTCSessionDescriptionInit,
  ): Promise<RTCSessionDescriptionInit>;
  // Caller side: applies the remote answer once it arrives.
  handle_remote_answer(answer: RTCSessionDescriptionInit): Promise<void>;
  // Either side: applies a remote ICE candidate as it trickles in. Safe to
  // call before the remote description is set - candidates are queued and
  // flushed once it is, avoiding the classic "addIceCandidate before
  // setRemoteDescription" race.
  add_remote_ice_candidate(candidate: RTCIceCandidateInit): Promise<void>;
  get_data_channel(): RTCDataChannel | undefined;
  close(): void;
}

export function create_peer_connection(
  device_id: string,
  handlers: PeerConnectionHandlers,
  config: RTCConfiguration = DEFAULT_RTC_CONFIG,
): PeerConnection {
  const pc = new RTCPeerConnection(config);

  let data_channel: RTCDataChannel | undefined;
  let remote_description_set = false;
  let pending_remote_candidates: RTCIceCandidateInit[] = [];

  function wire_data_channel(channel: RTCDataChannel): void {
    data_channel = channel;
    channel.addEventListener("open", () => {
      handlers.on_data_channel_open?.(channel);
    });
    channel.addEventListener("close", () => {
      handlers.on_data_channel_close?.();
    });
    channel.addEventListener("message", (event) => {
      handlers.on_data_channel_message?.(event);
    });
  }

  pc.addEventListener("icecandidate", (event) => {
    if (event.candidate) {
      handlers.on_local_ice_candidate?.(event.candidate);
    }
  });

  pc.addEventListener("connectionstatechange", () => {
    handlers.on_connection_state_change?.(pc.connectionState);
  });

  // Callee side receives the data channel the caller created, rather than
  // creating its own.
  pc.addEventListener("datachannel", (event) => {
    wire_data_channel(event.channel);
  });

  async function set_remote_description_and_flush_candidates(
    description: RTCSessionDescriptionInit,
  ): Promise<void> {
    await pc.setRemoteDescription(description);
    remote_description_set = true;
    const queued = pending_remote_candidates;
    pending_remote_candidates = [];
    for (const candidate of queued) {
      await pc.addIceCandidate(candidate);
    }
  }

  return {
    device_id,

    async create_and_send_offer() {
      const channel = pc.createDataChannel(DATA_CHANNEL_LABEL);
      wire_data_channel(channel);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      return offer;
    },

    async handle_remote_offer(offer) {
      await set_remote_description_and_flush_candidates(offer);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      return answer;
    },

    async handle_remote_answer(answer) {
      await set_remote_description_and_flush_candidates(answer);
    },

    async add_remote_ice_candidate(candidate) {
      if (!remote_description_set) {
        pending_remote_candidates.push(candidate);
        return;
      }
      await pc.addIceCandidate(candidate);
    },

    get_data_channel() {
      return data_channel;
    },

    close() {
      data_channel?.close();
      pc.close();
    },
  };
}
