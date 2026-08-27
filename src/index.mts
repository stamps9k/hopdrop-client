// Top-level wiring for the real app. Same business logic proven in
// full_pipeline_smoke_test.html, now organized as a proper module and
// driven through room_ui.mts's callback interface instead of inline DOM
// manipulation. This file owns state and orchestration; room_ui.mts owns
// presentation.

import "bootstrap/dist/css/bootstrap.min.css";
import "bootstrap-icons/font/bootstrap-icons.min.css";
import "bootstrap/dist/js/bootstrap.bundle.min.js";
import "../styles/cover.css";

import {
  create_signaling_socket,
  type SignalingSocket,
} from "./signaling_socket.mjs";
import {
  register_existing_peers,
  register_new_peer,
  remove_peer,
  should_send_offer,
  mark_offer_sent,
  get_peer_state,
  clear_all_negotiation_state,
} from "./rtc_negotiation.mjs";
import {
  create_peer_connection,
  type PeerConnection,
} from "./peer_connection.mjs";
import { send_file } from "./file_sender.mjs";
import { attach_file_receiver, type FileReceiver } from "./file_receiver.mjs";
import { build_join_url, parse_room_code_from_url } from "./qr_join.mjs";
import { create_room_ui, type PeerOption } from "./room_ui.mjs";

// Remembers the chosen device name across visits in this browser, so
// returning users don't have to retype it every time. Plain localStorage
// is fine here - this is a real deployed app, not a sandboxed artifact.
const DEVICE_NAME_STORAGE_KEY = "hopdrop_device_name";

let socket: SignalingSocket | null = null;
const peer_connections = new Map<string, PeerConnection>();
const open_channels = new Map<string, RTCDataChannel>();
const file_receivers = new Map<string, FileReceiver>();

// Set only when the page was opened via a scanned QR / shared join link
// AND a device name is already remembered from a previous visit - in that
// case both connect and join fire automatically with no typing needed. If
// there's no remembered name, the room code is still pre-filled but the
// user has to type a name once and press join themselves, since a name
// can't be silently invented on their behalf (that would undercut the
// whole point of server-enforced, user-chosen names).
let pending_auto_join: { room_code: string; device_name: string } | undefined;

function refresh_peer_select(): void {
  const peers: PeerOption[] = [...open_channels.keys()].map((device_id) => ({
    device_id,
    // Falls back to the raw id only if negotiation state is somehow
    // missing for an open channel, which shouldn't happen in practice -
    // every open channel's peer was registered via register_existing_peers
    // or register_new_peer before the channel could open.
    device_name: get_peer_state(device_id)?.device_name ?? device_id,
  }));
  ui.set_peer_options(peers);
}

function get_or_create_peer_connection(device_id: string): PeerConnection {
  const existing = peer_connections.get(device_id);
  if (existing !== undefined) {
    return existing;
  }

  const pc = create_peer_connection(device_id, {
    on_local_ice_candidate: (candidate) => {
      socket?.send_ice_candidate(device_id, candidate.toJSON());
    },

    on_connection_state_change: (state) => {
      ui.log(`connection state [${device_id}]`, state);
    },

    on_data_channel_open: (channel) => {
      open_channels.set(device_id, channel);
      refresh_peer_select();
      ui.log(`data channel OPEN with ${device_id}`);

      const receiver = attach_file_receiver(channel, {
        on_start: (info) => {
          ui.log(`receiving "${info.file_name}" from ${device_id}`, {
            file_size: info.file_size,
            total_chunks: info.total_chunks,
          });
        },
        on_progress: (progress) => {
          ui.log(
            `recv progress [${device_id}] ${progress.chunks_received}/${progress.total_chunks} chunks`,
          );
        },
        on_complete: (result) => {
          ui.log(`file received from ${device_id}`, {
            file_name: result.file_name,
            bytes_received: result.bytes_received,
            hash_verified: result.hash_verified,
          });
          const url = URL.createObjectURL(result.blob);
          ui.add_downloaded_file(result.file_name, url, result.hash_verified);
        },
        on_error: (error) => {
          ui.log(`file receiver error [${device_id}]`, error.message);
        },
      });
      file_receivers.set(device_id, receiver);
    },

    on_data_channel_close: () => {
      open_channels.delete(device_id);
      file_receivers.get(device_id)?.detach();
      file_receivers.delete(device_id);
      refresh_peer_select();
      ui.log(`data channel CLOSED with ${device_id}`);
    },
  });

  peer_connections.set(device_id, pc);
  return pc;
}

async function initiate_offer_if_caller(device_id: string): Promise<void> {
  if (!should_send_offer(device_id)) {
    return;
  }
  const pc = get_or_create_peer_connection(device_id);
  const offer = await pc.create_and_send_offer();
  mark_offer_sent(device_id);
  socket?.send_offer(device_id, offer);
  ui.log(`sent offer to ${device_id}`);
}

function connect_to_signaling(url: string): void {
  socket = create_signaling_socket(url, {
    on_open: () => {
      ui.set_status("Connected to signaling");
      ui.set_connected_status();
      ui.log("signaling OPEN");
      if (pending_auto_join !== undefined) {
        const { room_code, device_name } = pending_auto_join;
        pending_auto_join = undefined;
        socket?.join(device_name, room_code);
        ui.log("sent join (auto, from scanned link)", {
          room_code,
          device_name,
        });
      }
    },
    on_close: (event) => {
      ui.set_status("Disconnected");
      ui.log("signaling CLOSE", { code: event.code, reason: event.reason });
    },
    on_socket_error: () => ui.log("signaling SOCKET ERROR"),
    on_parse_error: (raw, error) => ui.log("PARSE ERROR", { raw, error }),

    on_room_created: (message) => {
      ui.set_status(
        `Room ${message.room_code} - I am "${message.device_name}"`,
      );
      ui.log("room-created", message);
      ui.set_room_status(true);
      ui.prefill_room_code(message.room_code);
      const join_url = build_join_url(window.location.href, message.room_code);
      void ui.show_join_qr_code(join_url);
    },

    on_room_joined: async (message) => {
      ui.set_status(
        `Room ${message.room_code} - I am "${message.device_name}"`,
      );
      ui.log("room-joined", message);
      ui.set_room_status(true);
      const peers = register_existing_peers(message);
      for (const peer of peers) {
        await initiate_offer_if_caller(peer.device_id);
      }
      const join_url = build_join_url(window.location.href, message.room_code);
      await ui.show_join_qr_code(join_url);
      ui.collapse_join_qr_code();
    },

    on_peer_joined: (message) => {
      ui.log("peer-joined", message);
      ui.collapse_join_qr_code();
      register_new_peer(message);
      get_or_create_peer_connection(message.device_id);
    },

    on_peer_left: (message) => {
      ui.log("peer-left", message);
      remove_peer(message);
      peer_connections.get(message.device_id)?.close();
      peer_connections.delete(message.device_id);
      file_receivers.get(message.device_id)?.detach();
      file_receivers.delete(message.device_id);
      open_channels.delete(message.device_id);
      refresh_peer_select();
    },

    on_room_expired: (message) => {
      ui.log("room-expired", message);
      ui.set_room_status(false);
      ui.clear_join_qr_code();
      ui.set_status("Connected to signaling");
    },

    // Server-relayed SDP/ICE payloads are opaque `unknown` by design (see
    // hopdrop-signaling's protocol) - the server never inspects them, so
    // the client is trusting its own peer's shape here. Fine at hopdrop's
    // personal-use, paired-devices-you-control scope; would need
    // validation if this ever faced untrusted peers.
    on_offer: async (message) => {
      ui.log(`offer from ${message.from_device_id}`);
      const pc = get_or_create_peer_connection(message.from_device_id);
      const answer = await pc.handle_remote_offer(
        message.payload as RTCSessionDescriptionInit,
      );
      socket?.send_answer(message.from_device_id, answer);
      ui.log(`sent answer to ${message.from_device_id}`);
    },

    on_answer: async (message) => {
      ui.log(`answer from ${message.from_device_id}`);
      const pc = peer_connections.get(message.from_device_id);
      if (pc === undefined) {
        ui.log(`WARNING: answer from unknown peer ${message.from_device_id}`);
        return;
      }
      await pc.handle_remote_answer(
        message.payload as RTCSessionDescriptionInit,
      );
    },

    on_ice_candidate: async (message) => {
      const pc = peer_connections.get(message.from_device_id);
      if (pc === undefined) {
        ui.log(
          `WARNING: ICE candidate from unknown peer ${message.from_device_id}`,
        );
        return;
      }
      await pc.add_remote_ice_candidate(message.payload as RTCIceCandidateInit);
    },

    on_server_error: (message) => ui.log("server error", message),
  });
  ui.log("connecting to", url);
}

const ui = create_room_ui({
  on_connect(url) {
    connect_to_signaling(url);
  },

  on_join(device_name, room_code) {
    if (socket === null || socket.ready_state !== WebSocket.OPEN) {
      ui.log("still connecting to the server - try again in a moment");
      return;
    }
    try {
      localStorage.setItem(DEVICE_NAME_STORAGE_KEY, device_name);
    } catch {
      // Storage can fail (private browsing, quota, disabled) - losing the
      // "remember my name" convenience isn't worth failing the join over.
    }
    socket.join(device_name, room_code);
    ui.log("sent join", { device_name, room_code });
  },

  on_leave() {
    socket?.leave();
    ui.log("sent leave");
    ui.set_room_status(false);
    for (const pc of peer_connections.values()) {
      pc.close();
    }
    for (const receiver of file_receivers.values()) {
      receiver.detach();
    }
    peer_connections.clear();
    file_receivers.clear();
    open_channels.clear();
    clear_all_negotiation_state();
    refresh_peer_select();
    ui.clear_join_qr_code();
  },

  on_send_file(device_id, file) {
    const channel = open_channels.get(device_id);
    if (channel === undefined) {
      ui.log("no open channel for the selected peer");
      return;
    }

    ui.set_send_progress(0, `sending ${file.name}...`);

    send_file(channel, file, {
      on_progress: (progress) => {
        const percent = Math.round(
          (progress.bytes_sent / progress.total_bytes) * 100,
        );
        ui.set_send_progress(
          percent,
          `${file.name}: ${progress.chunks_sent}/${progress.total_chunks} chunks (${percent}%)`,
        );
      },
      on_complete: (file_name) => {
        ui.log(`send complete: ${file_name}`);
        ui.set_send_progress(100, `${file_name}`);
      },
      on_error: (error) => {
        ui.log("send error", error.message);
        ui.set_send_progress(0, `error: ${error.message}`);
      },
    }).catch(() => {
      // Already logged via on_error above.
    });
  },
});

clear_all_negotiation_state();

let remembered_device_name: string | null = null;
try {
  remembered_device_name = localStorage.getItem(DEVICE_NAME_STORAGE_KEY);
} catch {
  // Storage access can throw (private browsing, disabled entirely) - just
  // proceed as if nothing was remembered.
}
if (remembered_device_name !== null && remembered_device_name.length > 0) {
  ui.prefill_device_name(remembered_device_name);
}

const room_code_from_url = parse_room_code_from_url(window.location.href);
if (room_code_from_url !== undefined) {
  ui.prefill_room_code(room_code_from_url);

  // Connect right away regardless of whether a device name is remembered -
  // connecting doesn't require a name, only the join message does. This
  // means the user never has to press "connect" themselves after opening
  // a shared link; if a name isn't remembered yet, they just type one and
  // press "join", which works immediately since the socket is already open.
  if (remembered_device_name !== null && remembered_device_name.length > 0) {
    pending_auto_join = {
      room_code: room_code_from_url,
      device_name: remembered_device_name,
    };
    ui.log(`auto-joining room ${room_code_from_url} (from scanned link)`);
  } else {
    ui.log(
      `room ${room_code_from_url} ready to join - enter a device name and press join`,
    );
  }
  connect_to_signaling(ui.get_signaling_url());
}
