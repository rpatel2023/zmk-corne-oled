// tools/edit-firmware/src/__tests__/git-helpers.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  currentHeadSha,
  createBackupTag,
  commitAndPush,
  listBackupTags,
  revertConfigToTag,
  hasUncommittedChanges,
} from "../git-helpers.mjs";

// createBackupTag and commitAndPush both push to a remote, so they are
// exercised against a local bare repo acting as "origin" rather than a
// real GitHub remote -- this proves the push mechanics without any
// network access or real credentials.
function makeRepoWithRemote() {
  const remoteDir = mkdtempSync(path.join(tmpdir(), "git-helpers-remote-"));
  execFileSync("git", ["init", "-q", "--bare", "-b", "main"], { cwd: remoteDir });

  const workDir = mkdtempSync(path.join(tmpdir(), "git-helpers-work-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: workDir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: workDir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: workDir });
  // Force LF-only checkouts regardless of the host machine's global git
  // config (e.g. Windows boxes with core.autocrlf=true) -- these tests
  // assert on exact file content, so line-ending normalization on
  // checkout must be disabled for the test repo to be deterministic.
  execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: workDir });
  execFileSync("git", ["remote", "add", "origin", remoteDir], { cwd: workDir });

  mkdirSync(path.join(workDir, "config"), { recursive: true });
  writeFileSync(path.join(workDir, "config", "eyelash_corne.keymap"), "/ { v = <1>; };\n");
  writeFileSync(path.join(workDir, "config", "eyelash_corne.conf"), "CONFIG_ZMK_SLEEP=y\n");
  execFileSync("git", ["add", "-A"], { cwd: workDir });
  execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: workDir });
  execFileSync("git", ["push", "-q", "-u", "origin", "main"], { cwd: workDir });

  return { workDir, remoteDir };
}

test("currentHeadSha returns the real HEAD commit sha", () => {
  const { workDir, remoteDir } = makeRepoWithRemote();
  try {
    const sha = currentHeadSha(workDir);
    const expected = execFileSync("git", ["rev-parse", "HEAD"], { cwd: workDir, encoding: "utf8" }).trim();
    assert.equal(sha, expected);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
    rmSync(remoteDir, { recursive: true, force: true });
  }
});

test("revertConfigToTag restores the two editable files to their content at a tag, as a new commit", () => {
  const { workDir, remoteDir } = makeRepoWithRemote();
  try {
    execFileSync("git", ["tag", "backup/before-change"], { cwd: workDir });
    const beforeSha = currentHeadSha(workDir);

    writeFileSync(path.join(workDir, "config", "eyelash_corne.keymap"), "/ { v = <2>; };\n");
    execFileSync("git", ["commit", "-q", "-am", "a risky change"], { cwd: workDir });
    const afterChangeSha = currentHeadSha(workDir);
    assert.notEqual(afterChangeSha, beforeSha);

    const result = revertConfigToTag(workDir, "backup/before-change");

    assert.notEqual(result.sha, afterChangeSha, "revert must create a NEW commit, not reset HEAD");
    assert.equal(
      readFileSync(path.join(workDir, "config", "eyelash_corne.keymap"), "utf8"),
      "/ { v = <1>; };\n",
    );
    // History is preserved -- the risky commit is still reachable, not destroyed.
    const log = execFileSync("git", ["log", "--oneline"], { cwd: workDir, encoding: "utf8" });
    assert.match(log, /a risky change/);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
    rmSync(remoteDir, { recursive: true, force: true });
  }
});

test("revertConfigToTag called twice in a row to the same tag does not throw, and resolves to the same sha both times", () => {
  const { workDir, remoteDir } = makeRepoWithRemote();
  try {
    execFileSync("git", ["tag", "backup/before-change"], { cwd: workDir });

    writeFileSync(path.join(workDir, "config", "eyelash_corne.keymap"), "/ { v = <2>; };\n");
    execFileSync("git", ["commit", "-q", "-am", "a risky change"], { cwd: workDir });

    const firstResult = revertConfigToTag(workDir, "backup/before-change");
    // Second call: the working tree already matches the tag's content, so
    // `git add` stages nothing and a plain `git commit` would fail with
    // "nothing to commit, working tree clean". This must resolve cleanly
    // instead of throwing a raw git error.
    const secondResult = revertConfigToTag(workDir, "backup/before-change");

    assert.equal(secondResult.sha, firstResult.sha, "a no-op rollback must resolve at the current HEAD, not throw");
    assert.equal(secondResult.sha, currentHeadSha(workDir));
    assert.equal(
      readFileSync(path.join(workDir, "config", "eyelash_corne.keymap"), "utf8"),
      "/ { v = <1>; };\n",
    );
  } finally {
    rmSync(workDir, { recursive: true, force: true });
    rmSync(remoteDir, { recursive: true, force: true });
  }
});

test("createBackupTag creates a local tag and pushes it to origin (real remote round-trip)", () => {
  const { workDir, remoteDir } = makeRepoWithRemote();
  try {
    const tagName = createBackupTag(workDir, "my-change");

    assert.match(tagName, /^backup\/.*-my-change$/);

    const localTags = execFileSync("git", ["tag", "--list", tagName], { cwd: workDir, encoding: "utf8" }).trim();
    assert.equal(localTags, tagName);

    // Verify the tag actually landed on the remote, not just locally.
    const remoteTags = execFileSync("git", ["tag", "--list", tagName], { cwd: remoteDir, encoding: "utf8" }).trim();
    assert.equal(remoteTags, tagName, "backup tag must be pushed to origin, not just created locally");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
    rmSync(remoteDir, { recursive: true, force: true });
  }
});

test("createBackupTag throws and cleans up the local tag when the push to origin fails", () => {
  const { workDir, remoteDir } = makeRepoWithRemote();
  try {
    // Simulate an unreachable remote (e.g. network down) without touching
    // any real network -- delete the bare repo backing "origin".
    rmSync(remoteDir, { recursive: true, force: true });

    assert.throws(() => createBackupTag(workDir, "doomed"), /Failed to push backup tag/);

    // No dangling local tag should remain after a failed push -- the tool
    // must abort cleanly before any edit is attempted, not limp forward
    // with a tag that only half-exists.
    const localTags = execFileSync("git", ["tag", "--list", "backup/*"], { cwd: workDir, encoding: "utf8" }).trim();
    assert.equal(localTags, "", "a failed backup tag push must not leave a local tag behind");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("commitAndPush stages, commits, and pushes the given paths to origin (real remote round-trip)", () => {
  const { workDir, remoteDir } = makeRepoWithRemote();
  try {
    writeFileSync(path.join(workDir, "config", "eyelash_corne.keymap"), "/ { v = <3>; };\n");

    const result = commitAndPush(workDir, "edit: bump v", ["config/eyelash_corne.keymap"]);

    assert.equal(result.pushed, true);
    assert.equal(result.committed, true, "a real change must report committed:true");
    assert.equal(result.sha, currentHeadSha(workDir));

    // Verify the commit actually reached the remote, by cloning it fresh.
    const cloneDir = mkdtempSync(path.join(tmpdir(), "git-helpers-clone-"));
    try {
      // -c core.autocrlf=false keeps this checkout deterministic regardless
      // of the host machine's global git config (see note in makeRepoWithRemote).
      execFileSync("git", ["clone", "-q", "-c", "core.autocrlf=false", remoteDir, cloneDir]);
      const remoteHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: cloneDir, encoding: "utf8" }).trim();
      assert.equal(remoteHead, result.sha, "commitAndPush must push HEAD to origin, not just commit locally");
      assert.equal(
        readFileSync(path.join(cloneDir, "config", "eyelash_corne.keymap"), "utf8"),
        "/ { v = <3>; };\n",
      );
    } finally {
      rmSync(cloneDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
    rmSync(remoteDir, { recursive: true, force: true });
  }
});

test("commitAndPush returns pushed:false (without throwing) when origin is unreachable", () => {
  const { workDir, remoteDir } = makeRepoWithRemote();
  try {
    // Simulate an unreachable remote without touching any real network.
    rmSync(remoteDir, { recursive: true, force: true });

    writeFileSync(path.join(workDir, "config", "eyelash_corne.keymap"), "/ { v = <4>; };\n");
    const result = commitAndPush(workDir, "edit: offline change", ["config/eyelash_corne.keymap"]);

    assert.equal(result.pushed, false);
    assert.equal(result.committed, true, "the local commit happened even though the push failed");
    assert.equal(result.sha, currentHeadSha(workDir), "the local commit must still exist even if the push failed");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("commitAndPush never force-pushes: a diverged origin is left intact and the push is reported as failed", () => {
  const { workDir, remoteDir } = makeRepoWithRemote();
  const otherDir = mkdtempSync(path.join(tmpdir(), "git-helpers-other-"));
  try {
    // Put a commit on origin that this working copy has never seen, so the
    // local branch is genuinely diverged and a plain push MUST be rejected
    // as non-fast-forward. This is the scenario where a force-push would
    // silently destroy someone else's already-pushed work -- the exact
    // thing this module promises never to do.
    execFileSync("git", ["clone", "-q", "-c", "core.autocrlf=false", remoteDir, otherDir]);
    execFileSync("git", ["config", "user.email", "other@example.com"], { cwd: otherDir });
    execFileSync("git", ["config", "user.name", "Other"], { cwd: otherDir });
    writeFileSync(path.join(otherDir, "config", "eyelash_corne.keymap"), "/ { v = <42>; };\n");
    execFileSync("git", ["commit", "-q", "-am", "someone else's work"], { cwd: otherDir });
    execFileSync("git", ["push", "-q", "origin", "main"], { cwd: otherDir });

    const originTipBefore = execFileSync("git", ["rev-parse", "main"], {
      cwd: remoteDir,
      encoding: "utf8",
    }).trim();

    // Now make a conflicting local commit and push it through commitAndPush.
    writeFileSync(path.join(workDir, "config", "eyelash_corne.keymap"), "/ { v = <5>; };\n");
    const result = commitAndPush(workDir, "edit: diverged change", ["config/eyelash_corne.keymap"]);

    assert.equal(result.committed, true, "the local commit still happens");
    assert.equal(
      result.pushed,
      false,
      "a non-fast-forward push must be reported as failed, not forced through",
    );

    // The load-bearing assertion: origin is byte-for-byte where the other
    // clone left it. With -f / --force / --force-with-lease this would now
    // be the local commit and "someone else's work" would be unreachable.
    const originTipAfter = execFileSync("git", ["rev-parse", "main"], {
      cwd: remoteDir,
      encoding: "utf8",
    }).trim();
    assert.equal(originTipAfter, originTipBefore, "origin's tip must be completely unchanged");
    assert.notEqual(originTipAfter, result.sha, "the local commit must NOT have landed on origin");

    // And the other clone's commit is still really there, not just its sha.
    const originLog = execFileSync("git", ["log", "--oneline", "main"], {
      cwd: remoteDir,
      encoding: "utf8",
    });
    assert.match(originLog, /someone else's work/, "the other clone's work must survive on origin");
    assert.doesNotMatch(originLog, /edit: diverged change/, "the rejected commit must not be on origin");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
    rmSync(remoteDir, { recursive: true, force: true });
    rmSync(otherDir, { recursive: true, force: true });
  }
});

test("commitAndPush with paths that have no actual changes does not throw, and reports success at the current sha", () => {
  const { workDir, remoteDir } = makeRepoWithRemote();
  try {
    const shaBefore = currentHeadSha(workDir);

    // No edits made to the file -- staging it is a no-op, so `git add` +
    // an unconditional `git commit` would fail with "nothing to commit,
    // working tree clean". Nothing is wrong here, so this must resolve
    // as success rather than throw.
    const result = commitAndPush(workDir, "edit: no-op", ["config/eyelash_corne.keymap"]);

    assert.equal(result.pushed, true, "there is nothing to push, but nothing is wrong either");
    assert.equal(result.committed, false, "a no-op must report committed:false so callers don't claim a build was triggered");
    assert.equal(result.sha, shaBefore, "HEAD must not move when there was nothing to commit");
    assert.equal(result.sha, currentHeadSha(workDir));
  } finally {
    rmSync(workDir, { recursive: true, force: true });
    rmSync(remoteDir, { recursive: true, force: true });
  }
});

test("commitAndPush does not sweep unrelated already-staged content into the commit (pathspec regression)", () => {
  const { workDir, remoteDir } = makeRepoWithRemote();
  try {
    // Simulate a file outside the tool's allowlist that the user happened
    // to already `git add` before running this tool (e.g. an in-progress,
    // unrelated edit to config/west.yml). This must never ride along into
    // a commit that this tool pushes -- that would let unvalidated content
    // reach the real remote and trigger a real CI build the user never
    // saw or approved.
    writeFileSync(path.join(workDir, "unrelated.txt"), "unrelated pre-existing change\n");
    execFileSync("git", ["add", "unrelated.txt"], { cwd: workDir });

    writeFileSync(path.join(workDir, "config", "eyelash_corne.keymap"), "/ { v = <9>; };\n");

    const result = commitAndPush(workDir, "edit: scoped commit", ["config/eyelash_corne.keymap"]);

    assert.equal(result.committed, true);
    const committedPaths = execFileSync(
      "git",
      ["diff-tree", "--no-commit-id", "--name-only", "-r", result.sha],
      { cwd: workDir, encoding: "utf8" },
    ).trim().split("\n").filter(Boolean);

    assert.deepEqual(
      committedPaths,
      ["config/eyelash_corne.keymap"],
      "the commit must contain only the requested path, not the unrelated staged file",
    );

    // The unrelated file's staged addition must survive untouched --
    // neither committed nor discarded, exactly as the user left it.
    const statusAfter = execFileSync("git", ["status", "--porcelain", "--", "unrelated.txt"], {
      cwd: workDir,
      encoding: "utf8",
    }).trim();
    assert.equal(statusAfter, "A  unrelated.txt", "the unrelated staged file must remain staged, untouched by the commit");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
    rmSync(remoteDir, { recursive: true, force: true });
  }
});

test("commitAndPush treats a no-op proposal as committed:false even with unrelated content staged elsewhere (path-scoped emptiness check)", () => {
  const { workDir, remoteDir } = makeRepoWithRemote();
  try {
    // An index-wide "is anything staged?" check would see this and wrongly
    // conclude "something is staged," skipping the no-op early return --
    // which, combined with the pathspec-scoped commit, would then hand
    // `git commit -- config/eyelash_corne.keymap` literally nothing to
    // commit for that path and git would exit non-zero, unhandled, *after*
    // a real backup tag has already been pushed in the real flow.
    writeFileSync(path.join(workDir, "unrelated.txt"), "unrelated pre-existing change\n");
    execFileSync("git", ["add", "unrelated.txt"], { cwd: workDir });

    const shaBefore = currentHeadSha(workDir);

    // No edit to the keymap file itself -- a genuine no-op for the path
    // this call cares about.
    const result = commitAndPush(workDir, "edit: no-op with noise", ["config/eyelash_corne.keymap"]);

    assert.equal(result.committed, false, "the no-op path must be reached even though something unrelated is staged");
    assert.equal(result.pushed, true);
    assert.equal(result.sha, shaBefore, "HEAD must not move");

    const statusAfter = execFileSync("git", ["status", "--porcelain", "--", "unrelated.txt"], {
      cwd: workDir,
      encoding: "utf8",
    }).trim();
    assert.equal(statusAfter, "A  unrelated.txt", "the unrelated staged file must remain untouched");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
    rmSync(remoteDir, { recursive: true, force: true });
  }
});

test("revertConfigToTag does not sweep unrelated already-staged content into the rollback commit (pathspec regression)", () => {
  const { workDir, remoteDir } = makeRepoWithRemote();
  try {
    execFileSync("git", ["tag", "backup/before-change"], { cwd: workDir });
    writeFileSync(path.join(workDir, "config", "eyelash_corne.keymap"), "/ { v = <2>; };\n");
    execFileSync("git", ["commit", "-q", "-am", "a risky change"], { cwd: workDir });

    // Unrelated staged content that must never ride along into (or be
    // mislabeled as part of) a rollback commit -- the rollback path is the
    // user's safety net, so this is worse here than in the normal edit path.
    writeFileSync(path.join(workDir, "unrelated.txt"), "unrelated pre-existing change\n");
    execFileSync("git", ["add", "unrelated.txt"], { cwd: workDir });

    const result = revertConfigToTag(workDir, "backup/before-change");

    const committedPaths = execFileSync(
      "git",
      ["diff-tree", "--no-commit-id", "--name-only", "-r", result.sha],
      { cwd: workDir, encoding: "utf8" },
    ).trim().split("\n").filter(Boolean);
    assert.deepEqual(
      committedPaths,
      ["config/eyelash_corne.keymap"],
      "the rollback commit must contain only the reverted path, not the unrelated staged file",
    );

    const statusAfter = execFileSync("git", ["status", "--porcelain", "--", "unrelated.txt"], {
      cwd: workDir,
      encoding: "utf8",
    }).trim();
    assert.equal(statusAfter, "A  unrelated.txt", "the unrelated staged file must remain staged, untouched by the rollback commit");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
    rmSync(remoteDir, { recursive: true, force: true });
  }
});

test("revertConfigToTag no-op rollback does not throw even with unrelated content staged elsewhere (path-scoped emptiness check)", () => {
  const { workDir, remoteDir } = makeRepoWithRemote();
  try {
    execFileSync("git", ["tag", "backup/before-change"], { cwd: workDir });
    const shaBefore = currentHeadSha(workDir);

    // An index-wide "is anything staged?" check would see this and wrongly
    // conclude the rollback has something to commit.
    writeFileSync(path.join(workDir, "unrelated.txt"), "unrelated pre-existing change\n");
    execFileSync("git", ["add", "unrelated.txt"], { cwd: workDir });

    // The tree already matches the tag -- a genuine no-op rollback.
    const result = revertConfigToTag(workDir, "backup/before-change");

    assert.equal(result.sha, shaBefore, "a no-op rollback must not move HEAD");
    const statusAfter = execFileSync("git", ["status", "--porcelain", "--", "unrelated.txt"], {
      cwd: workDir,
      encoding: "utf8",
    }).trim();
    assert.equal(statusAfter, "A  unrelated.txt", "the unrelated staged file must remain untouched");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
    rmSync(remoteDir, { recursive: true, force: true });
  }
});

test("hasUncommittedChanges is false on a clean tree and true for both unstaged and staged edits to the given paths", () => {
  const { workDir, remoteDir } = makeRepoWithRemote();
  const editable = ["config/eyelash_corne.keymap", "config/eyelash_corne.conf"];
  try {
    assert.equal(hasUncommittedChanges(workDir, editable), false, "a freshly committed tree is clean");

    writeFileSync(path.join(workDir, "config", "eyelash_corne.keymap"), "/ { v = <7>; };\n");
    assert.equal(hasUncommittedChanges(workDir, editable), true, "an unstaged edit counts as uncommitted");

    // `git status --porcelain` reports staged-but-uncommitted content too;
    // staging is not committing, so this must stay true. discardStaged's
    // `git checkout --` would not restore it either.
    execFileSync("git", ["add", "--", "config/eyelash_corne.keymap"], { cwd: workDir });
    assert.equal(hasUncommittedChanges(workDir, editable), true, "a staged-but-uncommitted edit still counts");

    execFileSync("git", ["commit", "-q", "-m", "now committed"], { cwd: workDir });
    assert.equal(hasUncommittedChanges(workDir, editable), false, "committing clears it");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
    rmSync(remoteDir, { recursive: true, force: true });
  }
});

test("hasUncommittedChanges is scoped to the given paths and ignores dirt elsewhere in the repo", () => {
  const { workDir, remoteDir } = makeRepoWithRemote();
  try {
    // Assert on absence: an unscoped `git status --porcelain` would see
    // this and wrongly refuse every edit/rollback run whenever anything
    // unrelated in the repo happened to be dirty.
    writeFileSync(path.join(workDir, "unrelated.txt"), "unrelated dirty content\n");
    execFileSync("git", ["add", "unrelated.txt"], { cwd: workDir });

    assert.equal(
      hasUncommittedChanges(workDir, ["config/eyelash_corne.keymap", "config/eyelash_corne.conf"]),
      false,
      "dirt outside the given paths must not register",
    );
  } finally {
    rmSync(workDir, { recursive: true, force: true });
    rmSync(remoteDir, { recursive: true, force: true });
  }
});

test("listBackupTags returns backup/ tags newest first", () => {
  const { workDir, remoteDir } = makeRepoWithRemote();
  try {
    execFileSync("git", ["tag", "backup/2026-01-01-first"], { cwd: workDir });
    writeFileSync(path.join(workDir, "config", "eyelash_corne.keymap"), "/ { v = <2>; };\n");
    execFileSync("git", ["commit", "-q", "-am", "second change"], { cwd: workDir });
    execFileSync("git", ["tag", "backup/2026-01-02-second"], { cwd: workDir });
    execFileSync("git", ["tag", "not-a-backup-tag"], { cwd: workDir });

    const tags = listBackupTags(workDir);
    assert.deepEqual(tags, ["backup/2026-01-02-second", "backup/2026-01-01-first"]);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
    rmSync(remoteDir, { recursive: true, force: true });
  }
});
