import assert from "node:assert/strict";
import test from "node:test";
import { parseHttpRange } from "../src/domain/httpRange.mjs";

test("parseHttpRange returns full response when range header is missing", () => {
  const result = parseHttpRange("", 100);

  assert.equal(result.ok, true);
  assert.deepEqual(result.data, { ranged: false, start: 0, end: 99 });
});

test("parseHttpRange supports explicit byte ranges for video seeking", () => {
  const result = parseHttpRange("bytes=10-19", 100);

  assert.equal(result.ok, true);
  assert.deepEqual(result.data, { ranged: true, start: 10, end: 19 });
});

test("parseHttpRange supports suffix byte ranges", () => {
  const result = parseHttpRange("bytes=-20", 100);

  assert.equal(result.ok, true);
  assert.deepEqual(result.data, { ranged: true, start: 80, end: 99 });
});

test("parseHttpRange rejects unsatisfiable ranges", () => {
  const result = parseHttpRange("bytes=200-300", 100);

  assert.equal(result.ok, false);
  assert.equal(result.code, "RANGE_NOT_SATISFIABLE");
});
