// tools/edit-firmware/src/__tests__/edit-firmware.test.mjs
//
// Coverage for the confirm/stage/revert state machine -- the part of this
// tool that decides whether unapproved, LLM-authored content is allowed to
// survive on disk. The single invariant every test here asserts is: after
// runGuardedEdit returns, on ANY exit path short of an explicit "y", the
// two editable files match their pre-run committed content exactly.
//
// Following this project's convention (git-helpers.test.mjs, apply-patch
// .test.mjs), everything that touches those files -- staging, diffing,
// reverting -- runs for real against a real `git init` temp repo. Only the
// non-deterministic/external pieces are faked: the LLM call, the
// confirmation prompt, and the GitHub calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { runGuardedEdit, confirm } from "../edit-firmware.mjs";

const KEYMAP = "config/eyelash_corne.keymap";
const CONF = "config/eyelash_corne.conf";
const BASELINE = {
  [KEYMAP]: "/ { keymap { compatible = \"zmk,keymap\"; }; };\n",
  [CONF]: "CONFIG_ZMK_SLEEP=y\n",
};
// Structurally valid replacement content -- must pass validateProposedFiles
// or the run would stop before ever staging anything.
const PROPOSED = {
  [KEYMAP]: "/ { keymap { compatible = \"zmk,keymap\"; label = \"X\"; }; };\n",
  [CONF]: "CONFIG_ZMK_SLEEP=n\n",
};

function makeRepo() {
  const workDir = mkdtempSync(path.join(tmpdir(), "edit-firmware-work-"));
  const git = (...args) => execFileSync("git", args, { cwd: workDir, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  // These tests assert on exact file content, so checkout-time line-ending
  // normalization must be off regardless of the host's global git config.
  git("config", "core.autocrlf", "false");

  mkdirSync(path.join(workDir, "config"), { recursive: true });
  for (const [rel, content] of Object.entries(BASELINE)) {
    writeFileSync(path.join(workDir, rel), content);
  }
  git("add", "-A");
  git("commit", "-q", "-m", "baseline");
  return workDir;
}

/** The core invariant: nothing unapproved survived anywhere on disk. */
function assertWorkingTreeMatchesBaseline(workDir, message) {
  for (const [rel, content] of Object.entries(BASELINE)) {
    assert.equal(readFileSync(path.join(workDir, rel), "utf8"), content, `${message} (${rel})`);
  }
  // Assert on absence as well as content: git itself must see a clean tree,
  // which also catches content left staged in the index.
  const status = execFileSync("git", ["status", "--porcelain", "--", ...Object.keys(BASELINE)], {
    cwd: workDir,
    encoding: "utf8",
  }).trim();
  assert.equal(status, "", `${message} -- git must report a clean tree, got: ${status}`);
}

function headSha(workDir) {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: workDir, encoding: "utf8" }).trim();
}

/**
 * Fakes for the external pieces only. Anything not overridden here (
 * stageFiles, diffStaged, discardStaged, hasUncommittedChanges) runs for
 * real against the temp repo.
 */
function makeDeps(overrides = {}) {
  const calls = { createBackupTag: 0, commitAndPush: 0, publishRelease: 0 };
  const deps = {
    proposeEdit: async () => ({ files: { ...PROPOSED }, backend: "fake" }),
    confirm: async () => false,
    createBackupTag: () => {
      calls.createBackupTag++;
      return "backup/fake-tag";
    },
    commitAndPush: () => {
      calls.commitAndPush++;
      throw new Error("commitAndPush must not be reached in this scenario");
    },
    publishRelease: () => {
      calls.publishRelease++;
    },
    findLatestRunForHeadSha: () => null,
    watchRun: () => ({ conclusion: "success", url: "https://x/1" }),
    downloadRunArtifacts: () => [],
    stageRelease: () => "",
    pruneOldReleases: () => {},
    sleep: async () => {}, // no real delay in the build-wait loop
    log: () => {}, // keep the test output readable
    error: () => {},
    ...overrides,
  };
  return { deps, calls };
}

test("declining at the prompt leaves both editable files exactly as committed", async () => {
  const workDir = makeRepo();
  try {
    const { deps, calls } = makeDeps({ confirm: async () => false });

    const result = await runGuardedEdit(workDir, "make a change", {}, deps);

    assert.equal(result.status, "declined");
    assert.equal(result.exitCode, 0);
    assertWorkingTreeMatchesBaseline(workDir, "a decline must revert everything");
    // Assert on absence: nothing irreversible was even attempted.
    assert.equal(calls.createBackupTag, 0, "a decline must never push a backup tag");
    assert.equal(calls.commitAndPush, 0, "a decline must never commit");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("a confirm() that throws a non-abort error still reverts, and the error propagates", async () => {
  const workDir = makeRepo();
  try {
    const boom = new Error("terminal exploded");
    const { deps, calls } = makeDeps({
      confirm: async () => {
        throw boom;
      },
    });

    await assert.rejects(
      () => runGuardedEdit(workDir, "make a change", {}, deps),
      /terminal exploded/,
      "a non-abort error must propagate, not be swallowed into a silent success",
    );

    assertWorkingTreeMatchesBaseline(workDir, "a thrown confirm must still revert");
    assert.equal(calls.createBackupTag, 0);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("a confirm() aborted mid-prompt (Ctrl+C / closed stdin shape) is treated as a decline and reverts", async () => {
  const workDir = makeRepo();
  try {
    // The AbortError shape confirm() produces when its AbortSignal fires.
    // Exercises askForApproval's belt-and-braces catch, complementing the
    // real-stream test below which exercises confirm()'s own listener.
    const abortError = new Error("The operation was aborted");
    abortError.code = "ABORT_ERR";
    abortError.name = "AbortError";
    const { deps, calls } = makeDeps({
      confirm: async () => {
        throw abortError;
      },
    });

    const result = await runGuardedEdit(workDir, "make a change", {}, deps);

    assert.equal(result.status, "declined");
    assertWorkingTreeMatchesBaseline(workDir, "an aborted prompt must revert");
    assert.equal(calls.createBackupTag, 0, "an aborted prompt must never push a backup tag");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("a failing createBackupTag reverts both files and creates no commit", async () => {
  const workDir = makeRepo();
  try {
    const shaBefore = headSha(workDir);
    const { deps, calls } = makeDeps({
      confirm: async () => true, // approved, so the pipeline is actually entered
      createBackupTag: () => {
        calls.createBackupTag++;
        throw new Error('Failed to push backup tag "backup/x" to origin');
      },
    });

    const result = await runGuardedEdit(workDir, "make a change", {}, deps);

    assert.equal(result.status, "backup-failed");
    assert.equal(result.exitCode, 1);
    assert.equal(calls.createBackupTag, 1, "the backup attempt really happened");
    // The critical part: approval was given, but with no backup to recover
    // from the approval is withdrawn and the tree goes back to baseline.
    assertWorkingTreeMatchesBaseline(workDir, "a failed backup must revert despite approval");
    assert.equal(headSha(workDir), shaBefore, "no commit may exist without a backup tag");
    assert.equal(calls.commitAndPush, 0, "commitAndPush must never run after a failed backup");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("a stageFiles that throws mid-loop reverts every proposed path, including the one never written", async () => {
  const workDir = makeRepo();
  try {
    // Mimic a real partial failure: the first path is genuinely written to
    // disk, then the second write throws (file lock, AV scanner, disk full)
    // and stageFiles never returns. The revert must still cover BOTH paths
    // -- the one holding unapproved content, and the untouched one.
    const { deps, calls } = makeDeps({
      confirm: async () => {
        throw new Error("confirm must never be reached when staging failed");
      },
      stageFiles: (root, files) => {
        const [firstPath] = Object.keys(files);
        writeFileSync(path.join(root, firstPath), files[firstPath], "utf8");
        throw new Error("EBUSY: resource busy or locked");
      },
    });

    await assert.rejects(
      () => runGuardedEdit(workDir, "make a change", {}, deps),
      /EBUSY/,
      "the staging failure must surface, not be silently swallowed",
    );

    assertWorkingTreeMatchesBaseline(
      workDir,
      "a mid-loop staging failure must revert every proposed path",
    );
    assert.equal(calls.createBackupTag, 0);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("runGuardedEdit refuses up front when the editable files already have uncommitted changes", async () => {
  const workDir = makeRepo();
  try {
    // Pre-existing work with no commit behind it -- discardStaged's
    // `git checkout --` could not restore it, so the run must refuse
    // before it ever writes.
    const usersOwnWork = "/ { keymap { compatible = \"zmk,keymap\"; label = \"MINE\"; }; };\n";
    writeFileSync(path.join(workDir, KEYMAP), usersOwnWork);

    let proposeCalled = false;
    const { deps } = makeDeps({
      proposeEdit: async () => {
        proposeCalled = true;
        return { files: { ...PROPOSED }, backend: "fake" };
      },
    });

    const result = await runGuardedEdit(workDir, "make a change", {}, deps);

    assert.equal(result.status, "dirty-tree");
    assert.equal(result.exitCode, 1);
    assert.equal(proposeCalled, false, "must refuse before spending an LLM call");
    assert.equal(
      readFileSync(path.join(workDir, KEYMAP), "utf8"),
      usersOwnWork,
      "the user's own uncommitted work must be left exactly as they had it",
    );
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("a structurally invalid proposal is rejected without writing anything to the working tree", async () => {
  const workDir = makeRepo();
  try {
    let stageCalled = false;
    const { deps } = makeDeps({
      // Unbalanced braces -- checkKeymapStructure must reject this.
      proposeEdit: async () => ({ files: { [KEYMAP]: "/ { keymap { \n" }, backend: "fake" }),
      stageFiles: () => {
        stageCalled = true;
      },
    });

    const result = await runGuardedEdit(workDir, "make a change", {}, deps);

    assert.equal(result.status, "proposal-rejected");
    assert.equal(result.exitCode, 1);
    assert.equal(stageCalled, false, "a rejected proposal must never reach the working tree");
    assertWorkingTreeMatchesBaseline(workDir, "a rejected proposal must leave the tree untouched");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("a proposal touching a path outside the allowlist is rejected and never written", async () => {
  const workDir = makeRepo();
  try {
    let stageCalled = false;
    const { deps } = makeDeps({
      proposeEdit: async () => ({
        files: { ".github/workflows/build.yml": "on: push\n" },
        backend: "fake",
      }),
      stageFiles: () => {
        stageCalled = true;
      },
    });

    const result = await runGuardedEdit(workDir, "make a change", {}, deps);

    assert.equal(result.status, "proposal-rejected");
    assert.equal(stageCalled, false, "a non-allowlisted path must never be written");
    assertWorkingTreeMatchesBaseline(workDir, "tree untouched after an out-of-allowlist proposal");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("approving really does stage the proposed content -- the revert tests are not passing vacuously", async () => {
  const workDir = makeRepo();
  try {
    // Calibration. Every test above asserts the tree came back to baseline;
    // this one proves the content genuinely reached disk in the first place,
    // so "matches baseline" means "written then reverted", not "never
    // written at all".
    let contentOnDiskAtPromptTime = null;
    const { deps } = makeDeps({
      confirm: async () => {
        contentOnDiskAtPromptTime = readFileSync(path.join(workDir, KEYMAP), "utf8");
        return false;
      },
    });

    await runGuardedEdit(workDir, "make a change", {}, deps);

    assert.equal(
      contentOnDiskAtPromptTime,
      PROPOSED[KEYMAP],
      "the proposed content must actually be on disk when the prompt is shown",
    );
    assertWorkingTreeMatchesBaseline(workDir, "and must be gone again afterwards");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("registerCleanup hands the caller a revert that undoes staged content (the signal-handler path)", async () => {
  const workDir = makeRepo();
  try {
    // main() wires this same function into its SIGINT/SIGTERM handlers, so
    // this proves what Ctrl+C mid-prompt would actually do.
    let revert = null;
    const { deps } = makeDeps({
      registerCleanup: (fn) => {
        revert = fn;
      },
      confirm: async () => {
        assert.equal(
          readFileSync(path.join(workDir, KEYMAP), "utf8"),
          PROPOSED[KEYMAP],
          "precondition: unapproved content is on disk at prompt time",
        );
        revert(); // simulate the signal handler firing mid-prompt
        assertWorkingTreeMatchesBaseline(workDir, "the signal-handler revert must clean up immediately");
        return false;
      },
    });

    await runGuardedEdit(workDir, "make a change", {}, deps);

    assert.equal(typeof revert, "function", "registerCleanup must be called with the revert");
    assertWorkingTreeMatchesBaseline(workDir, "and the tree stays clean afterwards");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

// --- security warning on sensitive .conf changes ------------------------
//
// askForApproval() branches on proposal.flaggedLines (computed in
// proposeAndValidate() via findNewSecuritySensitiveConfLines): a flagged
// .conf change must request the stronger "yes-security" phrase instead of
// the default "y", while an unflagged change must behave exactly as before.

const FLAGGED_CONF = "CONFIG_ZMK_SLEEP=n\nCONFIG_BT_CTLR_TX_PWR_PLUS_8=y\n";

test("a proposal that trips the security denylist makes confirm() receive the yes-security expectedAnswer", async () => {
  const workDir = makeRepo();
  try {
    let capturedOptions = "not called";
    const { deps } = makeDeps({
      proposeEdit: async () => ({ files: { [CONF]: FLAGGED_CONF }, backend: "fake" }),
      confirm: async (promptText, options) => {
        capturedOptions = options;
        return false;
      },
    });

    await runGuardedEdit(workDir, "enable something sensitive", {}, deps);

    assert.notEqual(capturedOptions, "not called", "confirm() must actually have been called");
    assert.equal(
      capturedOptions?.expectedAnswer,
      "yes-security",
      "a flagged .conf change must request the stronger confirmation phrase",
    );
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("declining the yes-security prompt on a flagged change reverts the working tree to baseline", async () => {
  const workDir = makeRepo();
  try {
    const { deps, calls } = makeDeps({
      proposeEdit: async () => ({ files: { [CONF]: FLAGGED_CONF }, backend: "fake" }),
      confirm: async () => false, // simulates typing anything other than "yes-security"
    });

    const result = await runGuardedEdit(workDir, "enable something sensitive", {}, deps);

    assert.equal(result.status, "declined");
    assert.equal(result.exitCode, 0);
    assertWorkingTreeMatchesBaseline(workDir, "declining a flagged change must revert everything");
    assert.equal(calls.createBackupTag, 0, "a decline on the flagged path must never push a backup tag");
    assert.equal(calls.commitAndPush, 0, "a decline on the flagged path must never commit");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("a proposal that does NOT trip the security denylist leaves confirm() on the default y behavior", async () => {
  const workDir = makeRepo();
  try {
    let capturedOptions = "not called";
    const { deps } = makeDeps({
      // .conf change present but with no sensitive-prefix key, and a
      // keymap-only change is covered implicitly since PROPOSED (the
      // default from makeDeps' proposeEdit) also only touches non-sensitive
      // content -- this override makes the "no sensitive key" case explicit.
      proposeEdit: async () => ({
        files: { [CONF]: "CONFIG_ZMK_IDLE_SLEEP_TIMEOUT=3600000\n" },
        backend: "fake",
      }),
      confirm: async (promptText, options) => {
        capturedOptions = options;
        return false;
      },
    });

    await runGuardedEdit(workDir, "change idle sleep timeout", {}, deps);

    assert.notEqual(capturedOptions, "not called", "confirm() must actually have been called");
    assert.equal(
      capturedOptions?.expectedAnswer,
      undefined,
      "an unflagged change must not override expectedAnswer, leaving confirm()'s default \"y\" behavior in place",
    );
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

// --- confirm() itself, over real streams -------------------------------
//
// These drive the real readline interface rather than a faked confirm(), so
// they prove the actual 'close' listener works -- the Fix 1 code path.

function confirmOverStream() {
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume(); // drain the prompt text so nothing blocks on backpressure
  return { input, output, promise: confirm("Apply this change? [y/N] ", { input, output }) };
}

test("confirm() resolves to false promptly when stdin closes with no answer (EOF), rather than hanging", async () => {
  const { input, promise } = confirmOverStream();

  // Close the input without ever writing an answer -- exactly what
  // `< /dev/null`, a pipe that ends, or a non-interactive dispatch does.
  // Before the 'close' listener existed, the pending question() never
  // settled at all: the caller's finally never ran and unapproved content
  // stayed on disk. Verified on Node v24.18.0 that this hangs forever
  // without that listener.
  input.end();

  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("confirm() hung on a closed stdin -- Fix 1 regressed")), 5_000).unref(),
  );

  assert.equal(await Promise.race([promise, timeout]), false, "EOF must be treated as a decline");
});

test("confirm() returns true only for an explicit y, and false for anything else", async () => {
  for (const [answer, expected] of [
    ["y\n", true],
    ["Y\n", true],
    ["  y  \n", true],
    ["n\n", false],
    ["\n", false],
    ["yes\n", false], // deliberately strict: only a bare "y" approves
    ["yeah sure\n", false],
  ]) {
    const { input, promise } = confirmOverStream();
    input.write(answer);
    assert.equal(await promise, expected, `answer ${JSON.stringify(answer)} should give ${expected}`);
    input.end();
  }
});
