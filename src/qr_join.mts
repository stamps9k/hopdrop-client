// Pure logic for the QR-join flow: turning a room code into a shareable
// URL, and pulling a room code back out of the page's current URL when the
// app loads (i.e. after a QR scan opened this page with ?room=... on it).
// No DOM or QR rendering here - that's in room_ui.mts, which is a thin
// wrapper around the actual QR image and is unit-untestable for the usual
// reasons. This module is plain URL manipulation, so it's fully testable
// with node:test's standard URL global.

// Builds a shareable link that encodes the room code (and, if the room is
// TURN-enabled, that too) as query params, preserving the given page URL's
// origin/path but discarding any other query params or fragment - a join
// link should only ever carry what's needed to join, not whatever was
// already on the page from a previous join.
export function build_join_url(
  current_page_url: string,
  room_code: string,
  is_turn: boolean,
): string {
  const url = new URL(current_page_url);
  url.search = "";
  url.hash = "";
  url.searchParams.set("room", room_code);
  // Omitted entirely when false, mirroring room_code's own "absent means
  // not set" convention - parse_is_turn_from_url treats a missing param
  // the same as an explicit false.
  if (is_turn) {
    url.searchParams.set("turn", "1");
  }
  return url.toString();
}

// Reads the room code back out of a URL, e.g. the page's own location
// after a QR scan opened it with ?room=ABCD1234. Returns undefined if
// there's no room param or it's empty, so callers can treat "no code"
// and "blank code" the same way.
export function parse_room_code_from_url(page_url: string): string | undefined {
  const url = new URL(page_url);
  const room_code = url.searchParams.get("room");
  return room_code !== null && room_code.length > 0 ? room_code : undefined;
}

// Reads whether a URL indicates its room is TURN-enabled, e.g. from a
// scanned join link that was built with is_turn: true. Defaults to false
// for a missing param (or any value other than "1") - a join link that
// predates this feature, or one that was hand-edited, is treated as a
// non-TURN room rather than erroring.
export function parse_is_turn_from_url(page_url: string): boolean {
  const url = new URL(page_url);
  return url.searchParams.get("turn") === "1";
}
