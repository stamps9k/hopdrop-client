import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { build_join_url, parse_room_code_from_url } from "../src/qr_join.mjs";

describe("build_join_url", () => {
  test("appends the room code as a query param on the given URL", () => {
    const url = build_join_url("https://hopdrop.example/", "AB12CD34");
    assert.equal(url, "https://hopdrop.example/?room=AB12CD34");
  });

  test("preserves a non-root path", () => {
    const url = build_join_url("https://hopdrop.example/app/", "AB12CD34");
    assert.equal(url, "https://hopdrop.example/app/?room=AB12CD34");
  });

  test("preserves a non-default port", () => {
    const url = build_join_url("http://localhost:3001/", "AB12CD34");
    assert.equal(url, "http://localhost:3001/?room=AB12CD34");
  });

  test("discards existing query params rather than merging them", () => {
    const url = build_join_url(
      "https://hopdrop.example/?room=OLDCODE&foo=bar",
      "NEWCODE",
    );
    assert.equal(url, "https://hopdrop.example/?room=NEWCODE");
  });

  test("discards an existing fragment", () => {
    const url = build_join_url(
      "https://hopdrop.example/#some-anchor",
      "AB12CD34",
    );
    assert.equal(url, "https://hopdrop.example/?room=AB12CD34");
  });

  test("URL-encodes a room code containing special characters", () => {
    const url = build_join_url("https://hopdrop.example/", "AB 12+CD");
    assert.equal(url, "https://hopdrop.example/?room=AB+12%2BCD");
  });
});

describe("parse_room_code_from_url", () => {
  test("extracts the room code when present", () => {
    assert.equal(
      parse_room_code_from_url("https://hopdrop.example/?room=AB12CD34"),
      "AB12CD34",
    );
  });

  test("returns undefined when there is no room param", () => {
    assert.equal(
      parse_room_code_from_url("https://hopdrop.example/"),
      undefined,
    );
  });

  test("returns undefined for an empty room param", () => {
    assert.equal(
      parse_room_code_from_url("https://hopdrop.example/?room="),
      undefined,
    );
  });

  test("ignores unrelated query params", () => {
    assert.equal(
      parse_room_code_from_url("https://hopdrop.example/?foo=bar&room=XYZ99"),
      "XYZ99",
    );
  });

  test("round-trips with build_join_url", () => {
    const url = build_join_url("https://hopdrop.example/", "ROUNDTRIP1");
    assert.equal(parse_room_code_from_url(url), "ROUNDTRIP1");
  });
});
