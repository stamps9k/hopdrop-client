// Pure logic for the QR-join flow: turning a room's join details into a
// shareable URL, and pulling them back out of the page's URL when the app
// loads (i.e. after a QR scan opened this page). No DOM or QR rendering
// here - that's in room_ui.mts. This module is plain string/URL
// manipulation, so it's fully testable with node:test.
//
// Everything lives in the URL fragment, never the query string: browsers
// don't send the fragment to any server (so the room key never reaches
// nginx logs or a Referer header), and it reads as one tidy token:
//
//   https://hopdrop.example/#ROOMCD.t.<room key>@signal.example.com
//
//   ROOMCD   room code (required) - see is_valid_room_code below
//   .t       present only for an is_turn room
//   .<key>   the room's signaling encryption key (see signal_crypto.mts).
//            Absent when the sharing device doesn't hold one itself (it
//            joined by typed room code), in which case whoever scans it
//            joins unencrypted too.
//   @host    the signaling server, present only when it isn't this
//            build's default. "wss://" and a bare "/" path are dropped;
//            any other scheme (e.g. ws:// for local dev) is kept in full.
//
// None of the fields can contain "." or "@" (room code and key alphabets
// exclude both; a host can't contain "@" and is split off first), so the
// grammar is unambiguous.

import { is_valid_room_key } from "./signal_crypto.mjs";

// Mirrors hopdrop-signaling's src/room_code.mts (CODE_ALPHABET and
// DEFAULT_CODE_LENGTH) - the repos deliberately share no code, so if
// either changes there, change it here too. The server remains the real
// enforcement point; this only stops a malformed link from ever being
// treated as a join link.
// Excludes visually ambiguous characters (0/O, 1/I/L).
const ROOM_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const ROOM_CODE_LENGTH = 6;

const TURN_FLAG = "t";
const DEFAULT_SIGNALING_SCHEME = "wss://";

export interface JoinLink {
  room_code: string;
  is_turn: boolean;
  // base64url room key, or undefined for an unencrypted (typed-code) room.
  room_key: string | undefined;
  // Full ws(s):// URL, or undefined meaning "use this build's default".
  signaling_url: string | undefined;
}

export function is_valid_room_code(candidate: string): boolean {
  if (candidate.length !== ROOM_CODE_LENGTH) {
    return false;
  }
  for (const char of candidate) {
    if (!ROOM_CODE_ALPHABET.includes(char)) {
      return false;
    }
  }
  return true;
}

// Parses and normalizes a signaling server URL, returning undefined for
// anything that isn't a plain ws:// or wss:// endpoint. Credentials, query
// strings and fragments are rejected outright rather than stripped - a
// join link has no legitimate reason to carry them.
export function normalize_signaling_url(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "wss:" && url.protocol !== "ws:") {
    return undefined;
  }
  if (
    url.hostname.length === 0 ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    return undefined;
  }
  return url.href;
}

// True when both URLs normalize to the same endpoint, so e.g. a trailing
// slash or host casing difference doesn't count as a third-party server.
// An unparseable default (e.g. a dev build with VITE_SIGNALING_URL unset,
// leaving Vite's literal placeholder behind) matches nothing.
export function is_same_signaling_url(a: string, b: string): boolean {
  const normalized_a = normalize_signaling_url(a);
  return (
    normalized_a !== undefined && normalized_a === normalize_signaling_url(b)
  );
}

function signaling_url_to_fragment_host(url: string): string | undefined {
  const normalized = normalize_signaling_url(url);
  if (normalized === undefined) {
    return undefined;
  }
  const parsed = new URL(normalized);
  const path = parsed.pathname === "/" ? "" : parsed.pathname;
  if (parsed.protocol === "wss:") {
    return `${parsed.host}${path}`;
  }
  return `${parsed.protocol}//${parsed.host}${path}`;
}

function fragment_host_to_signaling_url(host: string): string | undefined {
  if (host.length === 0 || host.includes("@")) {
    return undefined;
  }
  const has_scheme = host.includes("://");
  if (has_scheme && !/^wss?:\/\//i.test(host)) {
    // e.g. "https://..." - would otherwise become "wss://https://...".
    return undefined;
  }
  const with_scheme = has_scheme ? host : `${DEFAULT_SIGNALING_SCHEME}${host}`;
  return normalize_signaling_url(with_scheme);
}

// Builds a shareable link carrying everything a scanning device needs to
// connect and join in one step. Preserves the given page URL's origin and
// path but discards any query string or fragment already on it.
// default_signaling_url is this build's default - the server is only
// written into the link when it differs.
export function build_join_url(
  current_page_url: string,
  link: JoinLink,
  default_signaling_url: string,
): string {
  const url = new URL(current_page_url);
  url.search = "";

  let fragment = link.room_code;
  if (link.is_turn) {
    fragment += `.${TURN_FLAG}`;
  }
  if (link.room_key !== undefined) {
    fragment += `.${link.room_key}`;
  }
  if (
    link.signaling_url !== undefined &&
    !is_same_signaling_url(link.signaling_url, default_signaling_url)
  ) {
    const host = signaling_url_to_fragment_host(link.signaling_url);
    if (host !== undefined) {
      fragment += `@${host}`;
    }
  }
  url.hash = fragment;
  return url.toString();
}

// Reads join details back out of a URL's fragment. Strict on purpose:
// anything that isn't exactly the grammar above (including in-page anchors
// like "#app") returns undefined, so it's ignored rather than half-used.
export function parse_join_url(page_url: string): JoinLink | undefined {
  let fragment: string;
  try {
    // Decoded first: none of the grammar's characters need encoding, but
    // some QR scanner apps percent-encode them anyway (e.g. "@" as "%40").
    // Decoding can't smuggle anything past the strict checks below.
    fragment = decodeURIComponent(new URL(page_url).hash.slice(1));
  } catch {
    return undefined;
  }
  if (fragment.length === 0) {
    return undefined;
  }

  let main = fragment;
  let signaling_url: string | undefined;
  const at_index = fragment.indexOf("@");
  if (at_index !== -1) {
    main = fragment.slice(0, at_index);
    signaling_url = fragment_host_to_signaling_url(
      fragment.slice(at_index + 1),
    );
    if (signaling_url === undefined) {
      return undefined;
    }
  }

  const [room_code, ...rest] = main.split(".");
  if (room_code === undefined || !is_valid_room_code(room_code)) {
    return undefined;
  }

  let is_turn = false;
  if (rest[0] === TURN_FLAG) {
    is_turn = true;
    rest.shift();
  }

  let room_key: string | undefined;
  if (rest.length > 0) {
    const candidate_key = rest.shift();
    if (candidate_key === undefined || !is_valid_room_key(candidate_key)) {
      return undefined;
    }
    room_key = candidate_key;
  }

  if (rest.length > 0) {
    return undefined;
  }

  return { room_code, is_turn, room_key, signaling_url };
}

// Same URL with its fragment removed - used to clear a consumed join link
// from the address bar so a refresh or a copied tab URL doesn't try to
// rejoin a room that has since expired, or leak the room key.
export function strip_join_fragment(page_url: string): string {
  const url = new URL(page_url);
  url.hash = "";
  return url.toString();
}

export type RoomKeySource =
  { kind: "generate" } | { kind: "link"; room_key: string } | { kind: "none" };

// Where a join's room key comes from. Creating a room (no room code) mints
// a fresh key. Joining uses the opened link's key, but only when joining
// that link's own room - a code typed by hand never picks up a key from
// some other link, so it joins unencrypted (see signal_trust.mts).
export function choose_room_key_source(
  room_code: string | undefined,
  link: JoinLink | undefined,
): RoomKeySource {
  if (room_code === undefined) {
    return { kind: "generate" };
  }
  if (link?.room_code === room_code && link.room_key !== undefined) {
    return { kind: "link", room_key: link.room_key };
  }
  return { kind: "none" };
}
