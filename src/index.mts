// Top-level wiring for the real app. Same business logic proven in
// full_pipeline_smoke_test.html, now organized as a proper module and
// driven through room_ui.mts's callback interface instead of inline DOM
// manipulation. This file owns state and orchestration; room_ui.mts owns
// presentation.

import {
  create_signaling_socket,
  type SignalingSocket,
} from "./signaling_socket.mjs";
import type { RtcSignalType } from "./signaling_protocol.mjs";
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
import {
  reset_turn_state,
  begin_turn_request,
  resolve_turn_credentials,
  is_turn_request_pending,
  get_rtc_config_when_ready,
} from "./turn_state.mjs";
import { send_file } from "./file_sender.mjs";
import { attach_file_receiver, type FileReceiver } from "./file_receiver.mjs";
import {
  build_join_url,
  choose_room_key_source,
  is_same_signaling_url,
  parse_join_url,
  strip_join_fragment,
  type JoinLink,
} from "./qr_join.mjs";
import { generate_room_key, import_room_key } from "./signal_crypto.mjs";
import { create_signal_channel } from "./signal_channel.mjs";
import { create_room_ui, type PeerOption } from "./room_ui.mjs";

// Remembers the chosen device name across visits in this browser, so
// returning users don't have to retype it every time. Plain localStorage
// is fine here - this is a real deployed app, not a sandboxed artifact.
const DEVICE_NAME_STORAGE_KEY = "hopdrop_device_name";

let socket: SignalingSocket | null = null;
const peer_connections = new Map<string, PeerConnection>();
// Tracks a peer connection's creation while it's still in flight (i.e.
// waiting on get_rtc_config_when_ready()) - not just the finished result.
// Needed because get_or_create_peer_connection is async: without this, two
// messages for the same device_id arriving close together (e.g. peer-joined
// followed shortly by that peer's own offer) could each see no existing
// connection and both start creating one, the second silently clobbering
// the first's data channel. A concurrent call for the same device_id now
// gets the same in-flight promise instead of racing a duplicate creation.
const pending_peer_connections = new Map<string, Promise<PeerConnection>>();
const open_channels = new Map<string, RTCDataChannel>();
const file_receivers = new Map<string, FileReceiver>();
// Display names for peers with an open data channel, captured from
// rtc_negotiation.mts's state the moment the channel opens. Kept here
// rather than read back from rtc_negotiation.mts on demand because that
// module's state is signaling-scoped - it's cleared when the signaling
// socket closes or the room ends - while an open peer connection outlives
// both. Without this copy, the send tab's peer list would lose its names
// the moment signaling dropped.
const connected_peer_names = new Map<string, string>();
// Whether each open peer connection was negotiated over encrypted
// signaling (true) or plaintext (false - one side joined by typed room
// code). Captured at channel open for the same reason as
// connected_peer_names: the signal channel's modes are signaling-scoped.
const connected_peer_verified = new Map<string, boolean>();

// The room's signaling encryption key (see signal_crypto.mts), both forms:
// `encoded` goes into join links, `key` does the work. null means this
// device joined by typed room code and signals in plaintext.
interface RoomKey {
  encoded: string;
  key: CryptoKey;
}
// Chosen when a join is sent, promoted to active_room_key once the server
// confirms the join - so a rejected join (e.g. a taken device name) can't
// leave a key from the wrong room active.
let pending_room_key: RoomKey | null = null;
let active_room_key: RoomKey | null = null;
// The URL this device most recently connected to - written into join
// links whenever it isn't the build's default.
let connected_signaling_url: string | null = null;
// Join details read from a scanned QR / shared link's fragment, if the
// page was opened with one. The room key is only used if the room code
// actually joined matches the link's - see on_join.
const join_link: JoinLink | undefined = parse_join_url(window.location.href);
// Cleared once this device has joined a room, so the link's room code is
// only re-filled on the first connection after opening it - not on every
// later reconnect.
let join_link_unused = join_link !== undefined;

// Set only when a device name is already remembered from a previous visit
// AND the page was opened via a scanned QR / shared join link - in that
// case, once the socket connects, trigger_join() fires automatically
// using whatever room-code/is_turn values were already prefilled from the
// URL, with no typing needed. If there's no remembered name, the room
// code (and is_turn) are still pre-filled but the user has to type a name
// once and press join themselves, since a name can't be silently invented
// on their behalf (that would undercut the whole point of
// server-enforced, user-chosen names). No longer carries room_code/
// device_name itself - trigger_join() reads current form state directly,
// so this is just a "should we auto-trigger" flag.
let pending_auto_join = false;
// Set instead of pending_auto_join when a join link is opened with no
// remembered device name: once connected, the focused join modal opens to
// ask for one (see room_ui.mts's show_join_guide).
let pending_join_guide = false;
// Set when this device joins a room from a link - the first open data
// channel then switches to the Send tab, since sending is what the person
// scanning came to do. Creators and typed-code joiners stay on Connect,
// where the QR code is.
let switch_to_send_tab_on_connect = false;

// Fully tears down one peer: closes its RTCPeerConnection (and with it the
// data channel), detaches its file receiver, and forgets it everywhere.
// Idempotent - safe to call for a peer that's already gone, which matters
// because closing a connection can itself fire the data channel's close
// event, which calls back in here.
function close_peer(device_id: string): void {
  const pc = peer_connections.get(device_id);
  peer_connections.delete(device_id);
  open_channels.delete(device_id);
  connected_peer_names.delete(device_id);
  connected_peer_verified.delete(device_id);
  file_receivers.get(device_id)?.detach();
  file_receivers.delete(device_id);
  pc?.close();
  refresh_peer_select();
}

// Tears down everything that depends on the signaling server - shared by
// every path that means "we're no longer in a room": an explicit Leave
// click, the room expiring server-side, and losing the signaling
// connection outright. Deliberately does NOT touch peer connections whose
// data channel is already open: once the handshake is done, file data
// flows directly between the two browsers and never needs the signaling
// server again, so losing it (e.g. nginx closing an idle WebSocket
// mid-transfer) must not interrupt a transfer. Those connections end only
// when their own data channel closes or the connection fails - see
// on_data_channel_close and on_connection_state_change.
//
// Peer connections that haven't opened a data channel yet are closed,
// though: they're still mid-handshake, and with signaling gone the
// remaining SDP/ICE messages can never arrive. Any creation still in
// flight bails out on its own - reset_turn_state() rejects a pending TURN
// wait, and clearing negotiation state makes get_or_create_peer_connection's
// post-await get_peer_state check fail.
function reset_signaling_state(): void {
  reset_turn_state();
  clear_all_negotiation_state();
  pending_peer_connections.clear();
  signals.reset();
  active_room_key = null;
  pending_room_key = null;
  for (const device_id of [...peer_connections.keys()]) {
    if (!open_channels.has(device_id)) {
      close_peer(device_id);
    }
  }
  refresh_peer_select();
  ui.clear_join_qr_code();
}

function refresh_peer_select(): void {
  const peers: PeerOption[] = [...open_channels.keys()].map((device_id) => ({
    device_id,
    // Falls back to the raw id only if no name was captured when the
    // channel opened, which shouldn't happen in practice - see
    // on_data_channel_open.
    device_name: connected_peer_names.get(device_id) ?? device_id,
    verified: connected_peer_verified.get(device_id) ?? false,
  }));
  ui.set_peer_options(peers);
}

/**
 * Returns the existing connection for a peer, or creates one - waiting on
 * get_rtc_config_when_ready() first so a TURN-enabled room's connections
 * are built with the right RTCConfiguration rather than racing ahead of
 * credentials that haven't arrived yet. For a non-TURN room this wait
 * resolves immediately, so existing behavior is unaffected there.
 *
 * Can reject if the room closes (room-expired) or a defensive TURN error
 * arrives while this is in flight - see turn_state.mts. Also rejects if
 * the peer itself leaves before its own connection was ready (checked via
 * rtc_negotiation.mts's get_peer_state - reusing its existing tracking
 * rather than adding new state just for this). Callers should use
 * try_get_or_create_peer_connection below rather than call this directly,
 * unless they specifically want to handle the rejection themselves.
 */
async function get_or_create_peer_connection(
  device_id: string,
): Promise<PeerConnection> {
  const existing = peer_connections.get(device_id);
  if (existing !== undefined) {
    return existing;
  }

  const in_flight = pending_peer_connections.get(device_id);
  if (in_flight !== undefined) {
    return in_flight;
  }

  const creation_promise = (async (): Promise<PeerConnection> => {
    const rtc_config = await get_rtc_config_when_ready();

    const pc = create_peer_connection(
      device_id,
      {
        on_local_ice_candidate: (candidate) => {
          signals.send("ice-candidate", device_id, candidate.toJSON());
        },

        on_connection_state_change: (state) => {
          ui.log(`connection state [${device_id}]`, state);
          // The peer connection's own health is what decides its lifetime,
          // not signaling. "disconnected" can recover by itself, so only
          // the terminal states tear down - e.g. the other device closed
          // its tab without its data channel closing cleanly first, and
          // ICE consent checks eventually gave up.
          if (state === "failed" || state === "closed") {
            close_peer(device_id);
          }
        },

        on_data_channel_open: (channel) => {
          open_channels.set(device_id, channel);
          // Every peer is registered in rtc_negotiation.mts (via
          // register_existing_peers or register_new_peer) before its
          // channel can open, so this lookup should always hit.
          connected_peer_names.set(
            device_id,
            get_peer_state(device_id)?.device_name ?? device_id,
          );
          if (switch_to_send_tab_on_connect) {
            switch_to_send_tab_on_connect = false;
            ui.show_send_tab();
          }
          const verified = signals.get_mode(device_id) === "encrypted";
          connected_peer_verified.set(device_id, verified);
          refresh_peer_select();
          ui.log(
            `data channel OPEN with ${device_id}`,
            verified
              ? "verified (encrypted signaling)"
              : "UNVERIFIED (unencrypted signaling - a device joined by typed room code)",
          );

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
              ui.add_downloaded_file(
                result.file_name,
                url,
                result.hash_verified,
              );
            },
            on_error: (error) => {
              ui.log(`file receiver error [${device_id}]`, error.message);
            },
          });
          file_receivers.set(device_id, receiver);
        },

        on_data_channel_close: () => {
          ui.log(`data channel CLOSED with ${device_id}`);
          // The channel is the only thing this connection exists for, so
          // once it's closed (typically the other device closed its tab or
          // its connection) the whole peer connection goes with it.
          close_peer(device_id);
        },
      },
      rtc_config,
    );

    // The peer may have left (peer-left already ran remove_peer) while we
    // were waiting on rtc_config above - don't register a connection for
    // someone who's already gone.
    if (get_peer_state(device_id) === undefined) {
      pc.close();
      throw new Error(`peer ${device_id} left before its connection was ready`);
    }

    peer_connections.set(device_id, pc);
    return pc;
  })();

  pending_peer_connections.set(device_id, creation_promise);
  try {
    return await creation_promise;
  } finally {
    // Only remove OUR entry - if a newer creation_promise for this same
    // device_id has already replaced ours in the map (e.g. leaving and
    // immediately rejoining the same room while this same peer is still
    // present), deleting unconditionally here would remove the NEW
    // in-flight entry instead, right as it starts. Comparing by reference
    // (not just key) is what makes this safe.
    if (pending_peer_connections.get(device_id) === creation_promise) {
      pending_peer_connections.delete(device_id);
    }
  }
}

/**
 * Wraps get_or_create_peer_connection, turning its two failure cases (room
 * closed, or the peer left first - see above) into a logged message and
 * undefined, instead of an unhandled rejection. dispatch_server_message
 * doesn't await handler results, so an uncaught rejection inside an async
 * handler would otherwise surface as a genuine unhandled promise rejection
 * rather than a clean log line.
 */
async function try_get_or_create_peer_connection(
  device_id: string,
): Promise<PeerConnection | undefined> {
  try {
    return await get_or_create_peer_connection(device_id);
  } catch (error) {
    ui.log(
      `could not create a peer connection for ${device_id} - the room closed or the peer left first`,
      error instanceof Error ? error.message : String(error),
    );
    return undefined;
  }
}

async function initiate_offer_if_caller(device_id: string): Promise<void> {
  if (!should_send_offer(device_id)) {
    return;
  }
  const pc = await try_get_or_create_peer_connection(device_id);
  if (pc === undefined) {
    return;
  }
  const offer = await pc.create_and_send_offer();
  mark_offer_sent(device_id);
  // Must be queued synchronously right here, before yielding: the local
  // ICE candidates this offer triggers are queued as they fire, and the
  // queue is what guarantees the offer goes out ahead of them.
  signals.send("offer", device_id, offer);
  ui.log(`sent offer to ${device_id}`);
}

function send_raw_signal(
  type: RtcSignalType,
  device_id: string,
  payload: unknown,
): void {
  if (socket === null) {
    throw new Error("no signaling connection");
  }
  switch (type) {
    case "offer":
      socket.send_offer(device_id, payload);
      break;
    case "answer":
      socket.send_answer(device_id, payload);
      break;
    case "ice-candidate":
      socket.send_ice_candidate(device_id, payload);
      break;
  }
}

function peer_display_name(device_id: string): string {
  return get_peer_state(device_id)?.device_name ?? device_id;
}

// All SDP/ICE traffic goes through this - see signal_channel.mts for the
// encryption, ordering and downgrade rules it enforces.
const signals = create_signal_channel({
  send_raw: send_raw_signal,

  on_tampered(device_id, detail) {
    const peer_name = peer_display_name(device_id);
    ui.log(`SECURITY: signaling from ${peer_name} failed verification`, detail);
    ui.show_signaling_tamper_warning(peer_name);
    // An already-open connection was verified when it was set up and no
    // longer depends on signaling, so it's kept - otherwise a hostile
    // server could kill a running transfer just by injecting junk.
    // Anything still mid-handshake is untrustworthy and goes.
    if (!open_channels.has(device_id)) {
      close_peer(device_id);
    }
  },

  on_needs_key(device_id, detail) {
    ui.log(`cannot connect to ${peer_display_name(device_id)}`, detail);
    if (!open_channels.has(device_id)) {
      close_peer(device_id);
    }
  },

  log: (label, data) => ui.log(label, data),
});

async function load_room_key(encoded: string): Promise<RoomKey> {
  return { encoded, key: await import_room_key(encoded) };
}

function show_join_qr(room_code: string, is_turn: boolean): Promise<void> {
  const join_url = build_join_url(
    window.location.href,
    {
      room_code,
      is_turn,
      room_key: active_room_key?.encoded,
      signaling_url: connected_signaling_url ?? undefined,
    },
    ui.get_default_signaling_url(),
  );
  return ui.show_join_qr_code(join_url);
}

function connect_to_signaling(url: string): void {
  connected_signaling_url = url;
  ui.clear_signaling_tamper_warning();
  ui.set_third_party_signaling_url(
    is_same_signaling_url(url, ui.get_default_signaling_url())
      ? undefined
      : url,
  );
  socket = create_signaling_socket(url, {
    on_open: () => {
      ui.set_status("Connected to signaling");
      ui.set_connect_state(true);
      ui.set_room_status("waiting");
      // set_room_status("waiting") empties the room code field (right for
      // a Leave, wrong here) - put a scanned link's code back, or the
      // auto-join below (or the user's own Join click) would create a new
      // room instead of joining the one the link points at.
      if (join_link !== undefined && join_link_unused) {
        ui.prefill_room_code(join_link.room_code);
      }
      ui.log("signaling OPEN");
      if (pending_auto_join) {
        pending_auto_join = false;
        ui.log("auto-joining (from scanned link)");
        // Goes through the exact same validation/consent-gated flow a
        // manual click would (including the TURN warning modal, if
        // is_turn was prefilled true from the URL) - reads room code,
        // device name, and is_turn straight from the DOM, all of which
        // were already prefilled below before this socket connected.
        ui.trigger_join();
      } else if (pending_join_guide && join_link !== undefined) {
        pending_join_guide = false;
        ui.show_join_guide(join_link.room_code);
      }
    },
    on_close: (event) => {
      // Matches index.html's initial text, so the connect tab looks the
      // same as it did before the first connect.
      ui.set_status("Not connected");
      ui.set_connect_state(false);
      ui.set_room_status("disconnected");
      ui.set_third_party_signaling_url(undefined);
      // Resets the connect tab only - open peer connections, and any
      // transfer running over them, carry on (see reset_signaling_state).
      reset_signaling_state();
      ui.log("signaling CLOSE", { code: event.code, reason: event.reason });
    },
    on_socket_error: () => ui.log("signaling SOCKET ERROR"),
    on_parse_error: (raw, error) => ui.log("PARSE ERROR", { raw, error }),

    on_room_created: (message) => {
      ui.report_join_guide_result();
      join_link_unused = false;
      active_room_key = pending_room_key;
      pending_room_key = null;
      signals.enter_room(active_room_key?.key ?? null, message.device_id);
      reset_turn_state();
      if (message.is_turn) {
        begin_turn_request();
        socket?.request_turn_credentials();
      }
      ui.set_status(
        `Room ${message.room_code} - I am "${message.device_name}"`,
      );
      ui.log("room-created", message);
      ui.set_room_status("joined");
      ui.prefill_room_code(message.room_code);
      void show_join_qr(message.room_code, message.is_turn);
    },

    on_room_joined: async (message) => {
      ui.report_join_guide_result();
      if (join_link_unused && message.room_code === join_link?.room_code) {
        switch_to_send_tab_on_connect = true;
      }
      join_link_unused = false;
      active_room_key = pending_room_key;
      pending_room_key = null;
      signals.enter_room(active_room_key?.key ?? null, message.device_id);
      reset_turn_state();
      if (message.is_turn) {
        begin_turn_request();
        socket?.request_turn_credentials();
      }
      ui.set_status(
        `Room ${message.room_code} - I am "${message.device_name}"`,
      );
      ui.log("room-joined", message);
      ui.set_room_status("joined");
      const peers = register_existing_peers(message);
      for (const peer of peers) {
        await initiate_offer_if_caller(peer.device_id);
      }
      await show_join_qr(message.room_code, message.is_turn);
      ui.collapse_join_qr_code();
    },

    on_peer_joined: async (message) => {
      ui.log("peer-joined", message);
      ui.collapse_join_qr_code();
      register_new_peer(message);
      // Created now (rather than waiting for their offer) so it's ready to
      // receive it as soon as it arrives.
      await try_get_or_create_peer_connection(message.device_id);
    },

    on_peer_left: (message) => {
      ui.log("peer-left", message);
      remove_peer(message);
      signals.forget_peer(message.device_id);
      // peer-left only means the peer's *signaling* connection is gone
      // (they clicked Leave, their room expired, or their WebSocket
      // dropped) - it says nothing about the direct connection between
      // us. An already-open data channel is kept; it'll close by itself
      // if the peer really went away. A connection still mid-handshake
      // can't finish without signaling, so that one is closed.
      if (open_channels.has(message.device_id)) {
        ui.log(
          `${message.device_name} left signaling - direct connection kept`,
        );
        return;
      }
      close_peer(message.device_id);
    },

    on_room_expired: (message) => {
      ui.log("room-expired", message);
      // Reusing room-expired for both TTL timeout and a failed TURN
      // credential fetch is a known limitation (hopdrop-signaling side) -
      // the client can't yet tell these apart. Rejects any peer connection
      // currently waiting on TURN credentials so it can bail out cleanly
      // instead of hanging. Open peer connections are kept, same as a
      // signaling disconnect.
      ui.set_room_status("waiting");
      ui.set_status("Connected to signaling");
      reset_signaling_state();
    },

    on_turn_credentials: (message) => {
      ui.log("turn-credentials received");
      resolve_turn_credentials(message.ice_servers);
    },

    // Server-relayed SDP/ICE payloads are opaque `unknown` by design (see
    // hopdrop-signaling's protocol). signals.receive authenticates and
    // decrypts them where the room is encrypted; past that, the client
    // trusts its own peer's payload shape. Fine at hopdrop's
    // personal-use, paired-devices-you-control scope; would need
    // validation if this ever faced untrusted peers.
    on_offer: (message) => {
      const device_id = message.from_device_id;
      ui.log(`offer from ${device_id}`);
      signals.receive(message, async (payload) => {
        const pc = await try_get_or_create_peer_connection(device_id);
        if (pc === undefined) {
          return;
        }
        const answer = await pc.handle_remote_offer(
          payload as RTCSessionDescriptionInit,
        );
        // Queued before yielding, ahead of the ICE candidates the answer
        // triggers - same reason as in initiate_offer_if_caller.
        signals.send("answer", device_id, answer);
        ui.log(`sent answer to ${device_id}`);
      });
    },

    on_answer: (message) => {
      const device_id = message.from_device_id;
      ui.log(`answer from ${device_id}`);
      signals.receive(message, async (payload) => {
        const pc = peer_connections.get(device_id);
        if (pc === undefined) {
          ui.log(`WARNING: answer from unknown peer ${device_id}`);
          return;
        }
        await pc.handle_remote_answer(payload as RTCSessionDescriptionInit);
      });
    },

    on_ice_candidate: (message) => {
      const device_id = message.from_device_id;
      signals.receive(message, async (payload) => {
        const pc = peer_connections.get(device_id);
        if (pc === undefined) {
          ui.log(`WARNING: ICE candidate from unknown peer ${device_id}`);
          return;
        }
        await pc.add_remote_ice_candidate(payload as RTCIceCandidateInit);
      });
    },

    on_server_error: (message) => {
      ui.log("server error", message);
      // e.g. the chosen name is already taken in that room - reopens the
      // join modal with the reason, if the join came from it.
      ui.report_join_guide_result(message.message);
      // The normal way a failed TURN fetch surfaces is room-expired, not a
      // bare error (see hopdrop-signaling's close_room_due_to_turn_failure)
      // - this only catches the narrower, defensive request-turn-credentials
      // error paths (e.g. the room somehow no longer exists by the time the
      // request lands). Without this, one of those rare cases would leave
      // get_rtc_config_when_ready() waiting forever.
      if (is_turn_request_pending()) {
        reset_turn_state();
      }
    },
  });
  ui.log("connecting to", url);
}

const ui = create_room_ui({
  on_connect(url) {
    connect_to_signaling(url);
  },

  on_disconnect() {
    // The actual icon/button flip happens in on_close above, once the
    // socket confirms it's actually shut - same path a server-initiated
    // or network-dropped close goes through, so there's one source of
    // truth for "are we connected" regardless of who ended it.
    socket?.close();
    ui.log("disconnecting");
  },

  async on_join(device_name, room_code, is_turn) {
    if (socket === null || socket.ready_state !== WebSocket.OPEN) {
      ui.log("still connecting to the server - try again in a moment");
      return false;
    }
    try {
      localStorage.setItem(DEVICE_NAME_STORAGE_KEY, device_name);
    } catch {
      // Storage can fail (private browsing, quota, disabled) - losing the
      // "remember my name" convenience isn't worth failing the join over.
    }
    // Creating a room mints a fresh key, shared via the QR code/link;
    // joining uses the opened link's key only if this is that link's room
    // (see choose_room_key_source).
    const key_source = choose_room_key_source(room_code, join_link);
    let room_key: RoomKey | null = null;
    try {
      if (key_source.kind === "generate") {
        room_key = await load_room_key(generate_room_key());
      } else if (key_source.kind === "link") {
        room_key = await load_room_key(key_source.room_key);
      }
    } catch (error) {
      ui.log(
        "could not set up the room key - join not sent",
        error instanceof Error ? error.message : String(error),
      );
      return false;
    }
    if (socket === null || socket.ready_state !== WebSocket.OPEN) {
      ui.log("lost the server connection - join not sent");
      return false;
    }
    pending_room_key = room_key;
    socket.join(device_name, room_code, is_turn);
    ui.log("sent join", {
      device_name,
      room_code,
      is_turn,
      encrypted_signaling: room_key !== null,
    });
    if (room_key === null) {
      ui.log(
        "joining by typed room code - connections in this room can't be verified against signaling server tampering. Scan the QR code or open the join link to get a verified connection.",
      );
    }
    return true;
  },

  on_leave() {
    socket?.leave();
    ui.log("sent leave");
    ui.set_room_status("waiting");
    ui.set_status("Connected to signaling");
    // Leaving the room is a signaling action only - open peer connections
    // are kept, same as a signaling disconnect.
    reset_signaling_state();
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

if (join_link !== undefined) {
  // Consumed now - clear it from the address bar so a refresh or a shared
  // tab URL doesn't retry a room that has since expired (or pass the room
  // key along). Non-join fragments like the "#app" anchor are left alone.
  window.history.replaceState(
    window.history.state,
    "",
    strip_join_fragment(window.location.href),
  );

  ui.prefill_room_code(join_link.room_code);
  ui.prefill_is_turn(join_link.is_turn);
  if (join_link.signaling_url !== undefined) {
    ui.prefill_signaling_url(join_link.signaling_url);
  }

  // Connect right away regardless of whether a device name is remembered -
  // connecting doesn't require a name, only the join message does. This
  // means the user never has to press "connect" themselves after opening
  // a shared link; if a name isn't remembered yet, they just type one and
  // press "join", which works immediately since the socket is already open.
  if (remembered_device_name !== null && remembered_device_name.length > 0) {
    pending_auto_join = true;
    ui.log(`auto-joining room ${join_link.room_code} (from scanned link)`, {
      is_turn: join_link.is_turn,
      encrypted_signaling: join_link.room_key !== undefined,
    });
  } else {
    pending_join_guide = true;
    ui.log(
      `room ${join_link.room_code} ready to join - waiting for a device name`,
    );
  }
  connect_to_signaling(ui.get_signaling_url());
}

// Opening a join link while this page is already open on the same URL
// (e.g. pasting it into the same tab) only changes the fragment, which
// doesn't reload the page. Reloading hands it to the same startup path
// above. In-page anchors like "#app" don't parse as join links, so the
// "Start a transfer" button is unaffected.
//
// A reload would cut any open peer connections - and with them any
// transfer in progress - so in that case it asks first.
window.addEventListener("hashchange", () => {
  if (parse_join_url(window.location.href) === undefined) {
    return;
  }
  if (
    open_channels.size > 0 &&
    !window.confirm(
      "Open this join link? Your current connections will be closed.",
    )
  ) {
    window.history.replaceState(
      window.history.state,
      "",
      strip_join_fragment(window.location.href),
    );
    return;
  }
  window.location.reload();
});
