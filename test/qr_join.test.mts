import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  build_join_url,
  choose_room_key_source,
  is_same_signaling_url,
  is_valid_room_code,
  normalize_signaling_url,
  parse_join_url,
  strip_join_fragment,
  type JoinLink,
} from "../src/qr_join.mjs";

const DEFAULT_URL = "wss://hdws.stampatron.com";
const PAGE = "https://hopdrop.example/";
// A canonical 22-character base64url encoding of 16 bytes.
const KEY = "Xq3vN8kLp2RmT7wYc9ZbFg";

function link(overrides: Partial<JoinLink> = {}): JoinLink {
  return {
    room_code: "ABC234",
    is_turn: false,
    room_key: KEY,
    signaling_url: undefined,
    ...overrides,
  };
}

describe("is_valid_room_code", () => {
  test("accepts a 6-character code from the room code alphabet", () => {
    assert.equal(is_valid_room_code("ABC234"), true);
  });

  test("rejects the wrong length", () => {
    assert.equal(is_valid_room_code("ABC23"), false);
    assert.equal(is_valid_room_code("ABC2345"), false);
  });

  // Pins the alphabet against hopdrop-signaling's src/room_code.mts
  // (CODE_ALPHABET). If this needs changing, change the server too.
  test("accepts exactly the shared room code alphabet, nothing else", () => {
    const alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
    for (let code_point = 0; code_point < 128; code_point++) {
      const char = String.fromCharCode(code_point);
      assert.equal(
        is_valid_room_code(`ABC23${char}`),
        alphabet.includes(char),
        `character code ${code_point}`,
      );
    }
  });

  test("rejects ambiguous and lowercase characters", () => {
    for (const code of ["ABC230", "ABC23O", "ABC231", "ABC23I", "ABC23L"]) {
      assert.equal(is_valid_room_code(code), false, code);
    }
    assert.equal(is_valid_room_code("abc234"), false);
  });
});

describe("normalize_signaling_url", () => {
  test("accepts ws and wss URLs", () => {
    assert.equal(
      normalize_signaling_url("wss://a.example"),
      "wss://a.example/",
    );
    assert.equal(
      normalize_signaling_url("ws://localhost:3000"),
      "ws://localhost:3000/",
    );
  });

  test("rejects other schemes, credentials, queries and fragments", () => {
    for (const raw of [
      "https://a.example",
      "wss://user:pw@a.example",
      "wss://a.example/?x=1",
      "wss://a.example/#x",
      "not a url",
    ]) {
      assert.equal(normalize_signaling_url(raw), undefined, raw);
    }
  });
});

describe("is_same_signaling_url", () => {
  test("ignores a trailing slash and host casing", () => {
    assert.equal(
      is_same_signaling_url("wss://HDWS.stampatron.com/", DEFAULT_URL),
      true,
    );
  });

  test("an unparseable default matches nothing", () => {
    assert.equal(
      is_same_signaling_url("%VITE_SIGNALING_URL%", "%VITE_SIGNALING_URL%"),
      false,
    );
  });
});

describe("build_join_url", () => {
  test("encodes room code and key in the fragment", () => {
    assert.equal(
      build_join_url(PAGE, link(), DEFAULT_URL),
      `https://hopdrop.example/#ABC234.${KEY}`,
    );
  });

  test("adds the turn flag between code and key", () => {
    assert.equal(
      build_join_url(PAGE, link({ is_turn: true }), DEFAULT_URL),
      `https://hopdrop.example/#ABC234.t.${KEY}`,
    );
  });

  test("omits the key for an unencrypted room", () => {
    assert.equal(
      build_join_url(PAGE, link({ room_key: undefined }), DEFAULT_URL),
      "https://hopdrop.example/#ABC234",
    );
  });

  test("omits the server when it's the default", () => {
    assert.equal(
      build_join_url(
        PAGE,
        link({ signaling_url: "wss://hdws.stampatron.com/" }),
        DEFAULT_URL,
      ),
      `https://hopdrop.example/#ABC234.${KEY}`,
    );
  });

  test("adds a third-party wss server without its scheme", () => {
    assert.equal(
      build_join_url(
        PAGE,
        link({ is_turn: true, signaling_url: "wss://signal.example.com" }),
        DEFAULT_URL,
      ),
      `https://hopdrop.example/#ABC234.t.${KEY}@signal.example.com`,
    );
  });

  test("keeps a port and a non-root path", () => {
    assert.equal(
      build_join_url(
        PAGE,
        link({ signaling_url: "wss://signal.example.com:8443/ws" }),
        DEFAULT_URL,
      ),
      `https://hopdrop.example/#ABC234.${KEY}@signal.example.com:8443/ws`,
    );
  });

  test("keeps a non-wss scheme in full", () => {
    assert.equal(
      build_join_url(
        PAGE,
        link({ signaling_url: "ws://localhost:3000" }),
        DEFAULT_URL,
      ),
      `https://hopdrop.example/#ABC234.${KEY}@ws://localhost:3000`,
    );
  });

  test("preserves path and port, discards existing query and fragment", () => {
    assert.equal(
      build_join_url(
        "http://localhost:7421/app/?room=OLD&turn=1#app",
        link(),
        DEFAULT_URL,
      ),
      `http://localhost:7421/app/#ABC234.${KEY}`,
    );
  });
});

describe("parse_join_url", () => {
  test("round-trips every combination built by build_join_url", () => {
    for (const is_turn of [false, true]) {
      for (const room_key of [KEY, undefined]) {
        for (const signaling_url of [
          undefined,
          "wss://signal.example.com/",
          "wss://signal.example.com:8443/ws",
          "ws://localhost:3000/",
        ]) {
          const original = link({ is_turn, room_key, signaling_url });
          const parsed = parse_join_url(
            build_join_url(PAGE, original, DEFAULT_URL),
          );
          assert.deepEqual(parsed, original);
        }
      }
    }
  });

  test("returns undefined with no fragment or an in-page anchor", () => {
    assert.equal(parse_join_url(PAGE), undefined);
    assert.equal(parse_join_url(`${PAGE}#`), undefined);
    assert.equal(parse_join_url(`${PAGE}#app`), undefined);
  });

  test("rejects an invalid room code", () => {
    assert.equal(parse_join_url(`${PAGE}#abc234.${KEY}`), undefined);
    assert.equal(parse_join_url(`${PAGE}#ABC2340.${KEY}`), undefined);
  });

  test("rejects a malformed or non-canonical key", () => {
    assert.equal(parse_join_url(`${PAGE}#ABC234.short`), undefined);
    assert.equal(parse_join_url(`${PAGE}#ABC234.${KEY}x`), undefined);
    // Same length, but the last character carries non-zero padding bits.
    assert.equal(
      parse_join_url(`${PAGE}#ABC234.Xq3vN8kLp2RmT7wYc9ZbFh`),
      undefined,
    );
  });

  test("rejects misplaced or repeated segments", () => {
    assert.equal(parse_join_url(`${PAGE}#ABC234.${KEY}.t`), undefined);
    assert.equal(parse_join_url(`${PAGE}#ABC234.t.t`), undefined);
    assert.equal(parse_join_url(`${PAGE}#ABC234.${KEY}.${KEY}`), undefined);
    assert.equal(parse_join_url(`${PAGE}#ABC234.`), undefined);
  });

  test("rejects an empty or invalid server", () => {
    assert.equal(parse_join_url(`${PAGE}#ABC234.${KEY}@`), undefined);
    assert.equal(
      parse_join_url(`${PAGE}#ABC234.${KEY}@https://a.example`),
      undefined,
    );
    assert.equal(
      parse_join_url(`${PAGE}#ABC234.${KEY}@user@a.example`),
      undefined,
    );
  });

  test("accepts a percent-encoded fragment", () => {
    assert.deepEqual(
      parse_join_url(`${PAGE}#ABC234%2Et%2E${KEY}%40signal.example.com`),
      link({ is_turn: true, signaling_url: "wss://signal.example.com/" }),
    );
  });

  test("rejects a malformed percent-encoding", () => {
    assert.equal(parse_join_url(`${PAGE}#ABC234.${KEY}%E0%A4%A`), undefined);
  });

  test("round-trips IPv6, uppercase and internationalised server hosts", () => {
    for (const [given, normalized] of [
      ["wss://[::1]:7420", "wss://[::1]:7420/"],
      ["ws://[2001:db8::1]:3000/ws", "ws://[2001:db8::1]:3000/ws"],
      ["wss://Signal.EXAMPLE.com", "wss://signal.example.com/"],
      ["wss://bücher.example", "wss://xn--bcher-kva.example/"],
    ] as const) {
      const parsed = parse_join_url(
        build_join_url(PAGE, link({ signaling_url: given }), DEFAULT_URL),
      );
      assert.equal(parsed?.signaling_url, normalized, given);
    }
  });

  test("ignores the query string entirely", () => {
    assert.equal(parse_join_url(`${PAGE}?room=ABC234&turn=1`), undefined);
  });
});

describe("strip_join_fragment", () => {
  test("removes the fragment and keeps everything else", () => {
    assert.equal(
      strip_join_fragment(`http://localhost:7421/app/?x=1#ABC234.${KEY}`),
      "http://localhost:7421/app/?x=1",
    );
  });
});

describe("choose_room_key_source", () => {
  const opened = link({ room_code: "ABC234", room_key: KEY });

  test("creating a room mints a new key, whatever link was opened", () => {
    assert.deepEqual(choose_room_key_source(undefined, undefined), {
      kind: "generate",
    });
    assert.deepEqual(choose_room_key_source(undefined, opened), {
      kind: "generate",
    });
  });

  test("joining the opened link's room uses the link's key", () => {
    assert.deepEqual(choose_room_key_source("ABC234", opened), {
      kind: "link",
      room_key: KEY,
    });
  });

  test("a typed code for any other room never picks up the link's key", () => {
    assert.deepEqual(choose_room_key_source("XYZ789", opened), {
      kind: "none",
    });
  });

  test("no key when no link was opened, or the link carried none", () => {
    assert.deepEqual(choose_room_key_source("ABC234", undefined), {
      kind: "none",
    });
    assert.deepEqual(
      choose_room_key_source("ABC234", link({ room_key: undefined })),
      { kind: "none" },
    );
  });
});
