import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  validateProposedFiles,
  stageFiles,
  diffStaged,
  discardStaged,
} from "../apply-patch.mjs";

test("validateProposedFiles accepts a single allowed path", () => {
  const result = validateProposedFiles({
    "config/eyelash_corne.keymap": "/ {};",
  });
  assert.deepEqual(result, { ok: true, reasons: [] });
});

test("validateProposedFiles rejects a disallowed path even alongside an allowed one", () => {
  const result = validateProposedFiles({
    "config/eyelash_corne.keymap": "/ {};",
    "boards/shields/eyelash_corne/eyelash_corne.overlay": "// nope",
  });
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((r) => r.includes("boards/shields/eyelash_corne/eyelash_corne.overlay")));
});

test("validateProposedFiles rejects build.yaml and config/west.yml by name", () => {
  const result = validateProposedFiles({
    "build.yaml": "include: []",
    "config/west.yml": "manifest: {}",
  });
  assert.equal(result.ok, false);
  assert.equal(result.reasons.length, 2);
});

test("validateProposedFiles rejects content that fails the structural check", () => {
  const result = validateProposedFiles({
    "config/eyelash_corne.keymap": "/ { unbalanced",
  });
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((r) => r.includes("brace")));
});

test("validateProposedFiles rejects an empty proposal", () => {
  const result = validateProposedFiles({});
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((r) => r.includes("No files")));
});

test("validateProposedFiles rejects non-string content without throwing", () => {
  const result = validateProposedFiles({
    "config/eyelash_corne.keymap": null,
    "config/eyelash_corne.conf": 42,
  });
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((r) => r.includes("config/eyelash_corne.keymap") && r.includes("must be a string")));
  assert.ok(result.reasons.some((r) => r.includes("config/eyelash_corne.conf") && r.includes("must be a string")));
});

test("stageFiles writes content, diffStaged shows it, discardStaged reverts it", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "edit-firmware-test-"));
  try {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
    // Disable line-ending rewriting for this scratch repo so the test is
    // hermetic regardless of the developer machine's global core.autocrlf
    // setting (Windows commonly defaults this to true, which would rewrite
    // LF to CRLF on `git checkout --` and break the exact-content asserts
    // below).
    execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: dir });
    mkdirSync(path.join(dir, "config"), { recursive: true });
    const keymapPath = path.join(dir, "config", "eyelash_corne.keymap");
    writeFileSync(keymapPath, "/ { original = <1>; };\n", { flag: "wx" });
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: dir });

    stageFiles(dir, { "config/eyelash_corne.keymap": "/ { changed = <2>; };\n" });
    const diff = diffStaged(dir, ["config/eyelash_corne.keymap"]);
    assert.match(diff, /-\/ \{ original = <1>; \};/);
    assert.match(diff, /\+\/ \{ changed = <2>; \};/);
    assert.equal(readFileSync(keymapPath, "utf8"), "/ { changed = <2>; };\n");

    discardStaged(dir, ["config/eyelash_corne.keymap"]);
    assert.equal(readFileSync(keymapPath, "utf8"), "/ { original = <1>; };\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
