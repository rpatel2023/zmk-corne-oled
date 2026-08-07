// tools/edit-firmware/src/__tests__/rollback.test.mjs
//
// rollback.mjs is a CLI entry point -- it calls main() at module load and
// resolves its repo root from the process cwd -- so it is exercised here as
// a real child process against a real temp git repo, matching this
// project's convention of testing git behavior with real git rather than
// mocks (see git-helpers.test.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROLLBACK_CLI = fileURLToPath(new URL("../rollback.mjs", import.meta.url));
const KEYMAP = "config/eyelash_corne.keymap";
const BACKUP_TAG = "backup/2026-01-01T00-00-00-000Z-first";

// A repo with a committed baseline, a backup tag pointing at it, and a
// later commit that moved the keymap away from that baseline -- i.e. the
// exact shape where `--to <tag>` has real work to do.
function makeRepoWithBackupTag() {
  const workDir = mkdtempSync(path.join(tmpdir(), "rollback-work-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: workDir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: workDir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: workDir });
  // These tests assert on exact file content, so checkout-time line-ending
  // normalization must be off regardless of the host's global git config.
  execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: workDir });

  mkdirSync(path.join(workDir, "config"), { recursive: true });
  writeFileSync(path.join(workDir, KEYMAP), "/ { v = <1>; };\n");
  writeFileSync(path.join(workDir, "config", "eyelash_corne.conf"), "CONFIG_ZMK_SLEEP=y\n");
  execFileSync("git", ["add", "-A"], { cwd: workDir });
  execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: workDir });
  execFileSync("git", ["tag", BACKUP_TAG], { cwd: workDir });

  writeFileSync(path.join(workDir, KEYMAP), "/ { v = <2>; };\n");
  execFileSync("git", ["commit", "-q", "-am", "a risky change"], { cwd: workDir });

  return workDir;
}

function runRollback(workDir, args) {
  return spawnSync(process.execPath, [ROLLBACK_CLI, ...args], {
    cwd: workDir,
    encoding: "utf8",
  });
}

test("rollback --to refuses when an editable file has uncommitted changes, and leaves that content untouched", () => {
  const workDir = makeRepoWithBackupTag();
  try {
    // Uncommitted work sitting in an editable file. revertConfigToTag's
    // `git checkout <tag> -- <paths>` would overwrite this with the tag's
    // "<1>" content, and it exists nowhere in the object DB -- no stash
    // entry, no reflog entry, nothing to recover from.
    const uncommitted = "/ { v = <99>; };\n";
    writeFileSync(path.join(workDir, KEYMAP), uncommitted);
    const headBefore = execFileSync("git", ["rev-parse", "HEAD"], { cwd: workDir, encoding: "utf8" }).trim();

    const result = runRollback(workDir, ["--to", BACKUP_TAG]);

    assert.equal(result.status, 1, "rollback must exit non-zero when it refuses");
    assert.match(result.stderr, /uncommitted changes to .* -- commit or stash them first/);

    assert.equal(
      readFileSync(path.join(workDir, KEYMAP), "utf8"),
      uncommitted,
      "the user's uncommitted work must survive the refusal completely untouched",
    );
    // Assert on absence too: no rollback commit was created behind the refusal.
    assert.equal(
      execFileSync("git", ["rev-parse", "HEAD"], { cwd: workDir, encoding: "utf8" }).trim(),
      headBefore,
      "a refused rollback must not move HEAD",
    );
    assert.doesNotMatch(result.stdout, /Source restored to/);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("rollback --to still performs a normal rollback when the editable files are clean", () => {
  const workDir = makeRepoWithBackupTag();
  try {
    const headBefore = execFileSync("git", ["rev-parse", "HEAD"], { cwd: workDir, encoding: "utf8" }).trim();

    const result = runRollback(workDir, ["--to", BACKUP_TAG]);

    assert.equal(result.status, 0, `rollback should succeed on a clean tree; stderr: ${result.stderr}`);
    assert.match(result.stdout, /Source restored to/);
    assert.equal(
      readFileSync(path.join(workDir, KEYMAP), "utf8"),
      "/ { v = <1>; };\n",
      "the clean-tree path must still restore the tag's content",
    );
    // Additive history, never a destructive reset -- the risky commit is
    // still reachable and HEAD moved forward rather than backward.
    const headAfter = execFileSync("git", ["rev-parse", "HEAD"], { cwd: workDir, encoding: "utf8" }).trim();
    assert.notEqual(headAfter, headBefore, "a real rollback creates a NEW commit");
    const log = execFileSync("git", ["log", "--oneline"], { cwd: workDir, encoding: "utf8" });
    assert.match(log, /a risky change/);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("rollback --to ignores uncommitted changes to files outside the editable allowlist", () => {
  const workDir = makeRepoWithBackupTag();
  try {
    // The guard is scoped to ALLOWED_EDIT_PATHS. Unrelated dirty files are
    // not at risk from `git checkout <tag> -- <editable paths>`, so they
    // must not block a rollback.
    writeFileSync(path.join(workDir, "unrelated.txt"), "unrelated dirty content\n");

    const result = runRollback(workDir, ["--to", BACKUP_TAG]);

    assert.equal(result.status, 0, `unrelated dirt must not block rollback; stderr: ${result.stderr}`);
    assert.match(result.stdout, /Source restored to/);
    assert.equal(
      readFileSync(path.join(workDir, "unrelated.txt"), "utf8"),
      "unrelated dirty content\n",
      "the unrelated file must be left exactly as the user had it",
    );
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
