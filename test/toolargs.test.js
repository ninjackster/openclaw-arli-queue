import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanToolParams } from "../toolargs.js";

test("trims stray newlines from a path argument", () => {
  assert.deepEqual(
    cleanToolParams("edit", { path: "\n\n/Users/me/Projects/app/Risk.swift", edits: [{ oldText: " a", newText: " b" }] }),
    { path: "/Users/me/Projects/app/Risk.swift", edits: [{ oldText: " a", newText: " b" }] },
  );
});
test("returns undefined when nothing needs cleaning", () => {
  assert.equal(cleanToolParams("read", { path: "/tmp/x.txt" }), undefined);
  assert.equal(cleanToolParams("read", undefined), undefined);
});
test("does not touch content, text or command arguments", () => {
  assert.equal(cleanToolParams("write", { path: "/tmp/x", content: "\n\nkeep leading blank lines\n" }), undefined);
  assert.equal(cleanToolParams("exec", { command: "\n echo hi" }), undefined);
});
test("strips leading whitespace from an apply_patch body only", () => {
  assert.deepEqual(cleanToolParams("apply_patch", { input: "\n\n*** Begin Patch\n*** End Patch\n" }), { input: "*** Begin Patch\n*** End Patch\n" });
  assert.equal(cleanToolParams("other_tool", { input: "\n\nx" }), undefined);
});
test("handles several path keys and is case-insensitive on the key", () => {
  assert.deepEqual(cleanToolParams("exec", { command: "ls", workdir: " /tmp \n", Cwd: "\n/var" }), { command: "ls", workdir: "/tmp", Cwd: "/var" });
});
