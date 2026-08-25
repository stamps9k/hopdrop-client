// Pure logic for the QR-join flow: turning a room code into a shareable
// URL, and pulling a room code back out of the page's current URL when the
// app loads (i.e. after a QR scan opened this page with ?room=... on it).
// No DOM or QR rendering here - that's in room_ui.mts, which is a thin
// wrapper around the actual QR image and is unit-untestable for the usual
// reasons. This module is plain URL manipulation, so it's fully testable
// with node:test's standard URL global.

// Builds a shareable link that encodes the room code as a query param,
// preserving the given page URL's origin/path but discarding any other
// query params or fragment (a join link should only ever carry the room
// code - not, say, whatever ?room= was already on the page from a
// previous join).
export function build_join_url(
  current_page_url: string,
  room_code: string,
): string {
  const url = new URL(current_page_url);
  url.search = "";
  url.hash = "";
  url.searchParams.set("room", room_code);
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
