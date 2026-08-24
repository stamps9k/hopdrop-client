// Thin wrapper around the browser WebSocket API. All message shaping lives
// in signaling_protocol.mts; this module owns the live connection and wires
// its send/receive sides to that pure logic. Not unit tested - node:test has
// no WebSocket implementation, so this is verified by hand against a running
// hopdrop-signaling instance (the browser equivalent of the wscat pass done
// on the server side).

import {
  build_answer_message,
  build_ice_candidate_message,
  build_join_message,
  build_leave_message,
  build_offer_message,
  parse_server_message,
  type PeerJoinedMessage,
  type PeerLeftMessage,
  type RoomCreatedMessage,
  type RoomJoinedMessage,
  type RtcRelayMessage,
  type ServerErrorMessage,
  type ServerMessage,
} from "./signaling_protocol.mjs";

export interface SignalingSocketHandlers {
  on_room_created?: (message: RoomCreatedMessage) => void;
  on_room_joined?: (message: RoomJoinedMessage) => void;
  on_peer_joined?: (message: PeerJoinedMessage) => void;
  on_peer_left?: (message: PeerLeftMessage) => void;
  on_offer?: (message: RtcRelayMessage) => void;
  on_answer?: (message: RtcRelayMessage) => void;
  on_ice_candidate?: (message: RtcRelayMessage) => void;
  on_server_error?: (message: ServerErrorMessage) => void;
  // Fires when a message arrives that isn't valid JSON, or doesn't match
  // any known server message shape. Should never happen against a trusted
  // hopdrop-signaling instance, but the client shouldn't crash if it does.
  on_parse_error?: (raw: string, error: string) => void;
  on_open?: () => void;
  on_close?: (event: CloseEvent) => void;
  on_socket_error?: (event: Event) => void;
}

export interface SignalingSocket {
  join(room_code?: string): void;
  leave(): void;
  send_offer(target_device_id: string, payload: unknown): void;
  send_answer(target_device_id: string, payload: unknown): void;
  send_ice_candidate(target_device_id: string, payload: unknown): void;
  close(): void;
  readonly ready_state: number;
}

function dispatch_server_message(
  message: ServerMessage,
  handlers: SignalingSocketHandlers,
): void {
  switch (message.type) {
    case "room-created":
      handlers.on_room_created?.(message);
      break;
    case "room-joined":
      handlers.on_room_joined?.(message);
      break;
    case "peer-joined":
      handlers.on_peer_joined?.(message);
      break;
    case "peer-left":
      handlers.on_peer_left?.(message);
      break;
    case "offer":
    case "answer":
    case "ice-candidate":
      if (message.type === "offer") {
        handlers.on_offer?.(message);
      } else if (message.type === "answer") {
        handlers.on_answer?.(message);
      } else {
        handlers.on_ice_candidate?.(message);
      }
      break;
    case "error":
      handlers.on_server_error?.(message);
      break;
  }
}

export function create_signaling_socket(
  url: string,
  handlers: SignalingSocketHandlers,
): SignalingSocket {
  const socket = new WebSocket(url);

  socket.addEventListener("open", () => {
    handlers.on_open?.();
  });

  socket.addEventListener("close", (event) => {
    handlers.on_close?.(event);
  });

  socket.addEventListener("error", (event) => {
    handlers.on_socket_error?.(event);
  });

  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") {
      handlers.on_parse_error?.("", "received non-string message data");
      return;
    }
    const result = parse_server_message(event.data);
    if (!result.ok) {
      handlers.on_parse_error?.(event.data, result.error);
      return;
    }
    dispatch_server_message(result.message, handlers);
  });

  function send_raw(raw: string): void {
    if (socket.readyState !== WebSocket.OPEN) {
      throw new Error("cannot send: signaling socket is not open");
    }
    socket.send(raw);
  }

  return {
    join(room_code) {
      send_raw(build_join_message(room_code));
    },
    leave() {
      send_raw(build_leave_message());
    },
    send_offer(target_device_id, payload) {
      send_raw(build_offer_message(target_device_id, payload));
    },
    send_answer(target_device_id, payload) {
      send_raw(build_answer_message(target_device_id, payload));
    },
    send_ice_candidate(target_device_id, payload) {
      send_raw(build_ice_candidate_message(target_device_id, payload));
    },
    close() {
      socket.close();
    },
    get ready_state() {
      return socket.readyState;
    },
  };
}
