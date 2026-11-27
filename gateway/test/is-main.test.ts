import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { isMain } from "../src/is-main.ts";

test("isMain: matches the started script, including paths a URL encodes", () => {
  const p = "/tmp/a dir/escrow.ts";
  assert.equal(isMain(pathToFileURL(p).href, p), true);
  assert.equal(isMain(pathToFileURL(p).href, "/tmp/a dir/other.ts"), false);
  assert.equal(isMain(pathToFileURL(p).href, undefined), false);
  // the old check, for the record: false for the same file
  assert.notEqual(`file://${p}`, pathToFileURL(p).href);
});
