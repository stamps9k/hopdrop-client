// Pure message construction + parsing/validation for the hopdrop-signaling
// WebSocket protocol. No WebSocket reference here on purpose - this module
// takes/returns plain strings and objects so it can be unit tested without
// a live socket. The actual connection lives in signaling_socket.mts.

// ---------------------------------------------------------------------------
// Client -> server message shapes
// ---------------------------------------------------------------------------

export interface JoinMessage {
  type: "join";
  device_name: string;
  room_code?: string;
  // Whether this device wants TURN enforced for this room. Only meaningful
  // when creating a room (room_code omitted) - when joining an existing
  // room, the server checks this against the room's stored value and
  // rejects a mismatch. Optional, defaults to false server-side, for
  // backwards compatibility with clients that predate TURN support.
  is_turn?: boolean;
}

export interface LeaveMessage {
  type: "leave";
}

export type RtcSignalType = "offer" | "answer" | "ice-candidate";

export interface RtcSignalMessage {
  type: RtcSignalType;
  target_device_id: string;
  payload: unknown;
}

// No fields - the server resolves which room this applies to from the
// sender's own connection state, same as `leave`.
export interface RequestTurnCredentialsMessage {
  type: "request-turn-credentials";
}

export type ClientMessage =
  JoinMessage | LeaveMessage | RtcSignalMessage | RequestTurnCredentialsMessage;

// ---------------------------------------------------------------------------
// Server -> client message shapes
// ---------------------------------------------------------------------------

export interface RoomCreatedMessage {
  type: "room-created";
  room_code: string;
  device_id: string;
  device_name: string;
  // Always echoes the room's resolved value, even when the creating
  // device didn't specify one (resolves to false in that case).
  is_turn: boolean;
}

export interface PeerDeviceInfo {
  device_id: string;
  device_name: string;
}

export interface RoomJoinedMessage {
  type: "room-joined";
  room_code: string;
  device_id: string;
  device_name: string;
  peer_devices: PeerDeviceInfo[];
  is_turn: boolean;
}

export interface PeerJoinedMessage {
  type: "peer-joined";
  device_id: string;
  device_name: string;
}

export interface PeerLeftMessage {
  type: "peer-left";
  device_id: string;
  device_name: string;
}

export interface RoomExpiredMessage {
  type: "room-expired";
  room_code: string;
}

// Fully validated against RTCIceServer's shape (see is_rtc_ice_server_array
// below) - unlike RtcRelayMessage's payload further down, this value is
// consumed structurally by peer_connection.mts (as
// RTCConfiguration.iceServers), so an unvalidated value would surface as a
// confusing WebRTC-level failure far from the actual cause instead of a
// clear parse error here.
export interface TurnCredentialsMessage {
  type: "turn-credentials";
  ice_servers: RTCIceServer[];
}

export interface RtcRelayMessage {
  type: RtcSignalType;
  from_device_id: string;
  payload: unknown;
}

export interface ServerErrorMessage {
  type: "error";
  message: string;
}

export type ServerMessage =
  | RoomCreatedMessage
  | RoomJoinedMessage
  | PeerJoinedMessage
  | PeerLeftMessage
  | RoomExpiredMessage
  | TurnCredentialsMessage
  | RtcRelayMessage
  | ServerErrorMessage;

export type ParseServerMessageResult =
  { ok: true; message: ServerMessage } | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Client -> server: message builders
// Each returns a JSON string ready to hand to WebSocket.send.
// ---------------------------------------------------------------------------

export function build_join_message(
  device_name: string,
  room_code?: string,
  is_turn?: boolean,
): string {
  const message: JoinMessage = { type: "join", device_name };
  if (room_code !== undefined) {
    message.room_code = room_code;
  }
  if (is_turn !== undefined) {
    message.is_turn = is_turn;
  }
  return JSON.stringify(message);
}

export function build_leave_message(): string {
  const message: LeaveMessage = { type: "leave" };
  return JSON.stringify(message);
}

export function build_rtc_signal_message(
  type: RtcSignalType,
  target_device_id: string,
  payload: unknown,
): string {
  const message: RtcSignalMessage = { type, target_device_id, payload };
  return JSON.stringify(message);
}

export function build_offer_message(
  target_device_id: string,
  payload: unknown,
): string {
  return build_rtc_signal_message("offer", target_device_id, payload);
}

export function build_answer_message(
  target_device_id: string,
  payload: unknown,
): string {
  return build_rtc_signal_message("answer", target_device_id, payload);
}

export function build_ice_candidate_message(
  target_device_id: string,
  payload: unknown,
): string {
  return build_rtc_signal_message("ice-candidate", target_device_id, payload);
}

export function build_request_turn_credentials_message(): string {
  const message: RequestTurnCredentialsMessage = {
    type: "request-turn-credentials",
  };
  return JSON.stringify(message);
}

// ---------------------------------------------------------------------------
// Server -> client: parsing + validation
// ---------------------------------------------------------------------------

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function is_string(value: unknown): value is string {
  return typeof value === "string";
}

function is_boolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function is_peer_device_info(value: unknown): value is PeerDeviceInfo {
  return (
    is_record(value) &&
    is_string(value.device_id) &&
    is_string(value.device_name)
  );
}

function is_peer_device_array(value: unknown): value is PeerDeviceInfo[] {
  return Array.isArray(value) && value.every(is_peer_device_info);
}

function is_rtc_signal_type(value: unknown): value is RtcSignalType {
  return value === "offer" || value === "answer" || value === "ice-candidate";
}

// RTCIceServer.urls is a single URL string or a non-empty array of them.
function is_ice_server_urls(value: unknown): value is string | string[] {
  if (is_string(value)) {
    return true;
  }
  return Array.isArray(value) && value.length > 0 && value.every(is_string);
}

function is_rtc_ice_server(value: unknown): value is RTCIceServer {
  if (!is_record(value) || !is_ice_server_urls(value.urls)) {
    return false;
  }
  if (value.username !== undefined && !is_string(value.username)) {
    return false;
  }
  if (value.credential !== undefined && !is_string(value.credential)) {
    return false;
  }
  // "password" is the only credentialType the spec defines (the historical
  // "token" option was dropped) - anything else present is treated as
  // invalid rather than silently accepted.
  if (
    value.credentialType !== undefined &&
    value.credentialType !== "password"
  ) {
    return false;
  }
  return true;
}

function is_rtc_ice_server_array(value: unknown): value is RTCIceServer[] {
  return (
    Array.isArray(value) && value.length > 0 && value.every(is_rtc_ice_server)
  );
}

function validate_room_created(
  value: Record<string, unknown>,
): RoomCreatedMessage | null {
  if (
    !is_string(value.room_code) ||
    !is_string(value.device_id) ||
    !is_string(value.device_name) ||
    !is_boolean(value.is_turn)
  ) {
    return null;
  }
  return {
    type: "room-created",
    room_code: value.room_code,
    device_id: value.device_id,
    device_name: value.device_name,
    is_turn: value.is_turn,
  };
}

function validate_room_joined(
  value: Record<string, unknown>,
): RoomJoinedMessage | null {
  if (
    !is_string(value.room_code) ||
    !is_string(value.device_id) ||
    !is_string(value.device_name) ||
    !is_peer_device_array(value.peer_devices) ||
    !is_boolean(value.is_turn)
  ) {
    return null;
  }
  return {
    type: "room-joined",
    room_code: value.room_code,
    device_id: value.device_id,
    device_name: value.device_name,
    peer_devices: value.peer_devices,
    is_turn: value.is_turn,
  };
}

function validate_peer_joined(
  value: Record<string, unknown>,
): PeerJoinedMessage | null {
  if (!is_string(value.device_id) || !is_string(value.device_name)) {
    return null;
  }
  return {
    type: "peer-joined",
    device_id: value.device_id,
    device_name: value.device_name,
  };
}

function validate_peer_left(
  value: Record<string, unknown>,
): PeerLeftMessage | null {
  if (!is_string(value.device_id) || !is_string(value.device_name)) {
    return null;
  }
  return {
    type: "peer-left",
    device_id: value.device_id,
    device_name: value.device_name,
  };
}

function validate_room_expired(
  value: Record<string, unknown>,
): RoomExpiredMessage | null {
  if (!is_string(value.room_code)) {
    return null;
  }
  return { type: "room-expired", room_code: value.room_code };
}

function validate_turn_credentials(
  value: Record<string, unknown>,
): TurnCredentialsMessage | null {
  if (!is_rtc_ice_server_array(value.ice_servers)) {
    return null;
  }
  return { type: "turn-credentials", ice_servers: value.ice_servers };
}

function validate_rtc_relay(
  type: RtcSignalType,
  value: Record<string, unknown>,
): RtcRelayMessage | null {
  if (!is_string(value.from_device_id) || !("payload" in value)) {
    return null;
  }
  return { type, from_device_id: value.from_device_id, payload: value.payload };
}

function validate_error(
  value: Record<string, unknown>,
): ServerErrorMessage | null {
  if (!is_string(value.message)) {
    return null;
  }
  return { type: "error", message: value.message };
}

export function parse_server_message(raw: string): ParseServerMessageResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "malformed JSON" };
  }

  if (!is_record(parsed) || !is_string(parsed.type)) {
    return { ok: false, error: "missing or invalid type field" };
  }

  const type = parsed.type;
  let message: ServerMessage | null;

  switch (type) {
    case "room-created":
      message = validate_room_created(parsed);
      break;
    case "room-joined":
      message = validate_room_joined(parsed);
      break;
    case "peer-joined":
      message = validate_peer_joined(parsed);
      break;
    case "peer-left":
      message = validate_peer_left(parsed);
      break;
    case "room-expired":
      message = validate_room_expired(parsed);
      break;
    case "turn-credentials":
      message = validate_turn_credentials(parsed);
      break;
    case "error":
      message = validate_error(parsed);
      break;
    default:
      message = is_rtc_signal_type(type)
        ? validate_rtc_relay(type, parsed)
        : null;
  }

  if (message === null) {
    return { ok: false, error: `invalid payload for message type "${type}"` };
  }
  return { ok: true, message };
}
