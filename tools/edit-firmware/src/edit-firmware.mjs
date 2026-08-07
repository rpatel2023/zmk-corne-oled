#!/usr/bin/env node
/**
 * Entry point: node src/edit-firmware.mjs "<plain-language request>" [--backend openai|claude]
 *
 * Orchestrates the full guarded flow described in
 * docs/superpowers/specs/2026-08-05-guarded-firmware-edit-tool-design.md:
 * propose -> validate -> confirm -> backup -> commit/push -> build -> release.
 * Nothing survives past the validate step without an explicit "y" from
 * the person running this.
 *
 * The orchestration lives in the exported runGuardedEdit() rather than in
 * main() so the confirm/stage/revert state machine -- the part that decides
 * whether unapproved LLM content is allowed to survive on disk -- can be
 * exercised by real automated tests against a real temp git repo. main() is
 * a thin wrapper: parse argv, resolve the repo root, hold the lock file and
 * the signal handlers, and translate the result into an exit code.
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import {
  ALLOWED_EDIT_PATHS,
  RELEASES_DIR,
  RELEASE_RETENTION_COUNT,
  LOCK_FILE_PATH,
  SECURITY_SENSITIVE_CONF_PREFIXES,
} from "./config.mjs";
import { validateProposedFiles, stageFiles, diffStaged, discardStaged } from "./apply-patch.mjs";
import { findNewSecuritySensitiveConfLines } from "./structural-check.mjs";
import { proposeEdit } from "./llm-backend.mjs";
import { callOpenAI } from "./openai-backend.mjs";
import { callClaude } from "./claude-backend.mjs";
import { createBackupTag, commitAndPush, hasUncommittedChanges } from "./git-helpers.mjs";
import {
  findLatestRunForHeadSha,
  watchRun,
  downloadRunArtifacts,
  publishRelease,
} from "./github-actions.mjs";
import { stageRelease, pruneOldReleases } from "./release-store.mjs";

function repoRoot() {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
}

function slugify(request) {
  return request.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
}

export async function confirm(promptText, { input = process.stdin, output = process.stdout, expectedAnswer = "y" } = {}) {
  const rl = readline.createInterface({ input, output });
  const abortController = new AbortController();
  // readline's raw-mode Ctrl+C key handler checks listenerCount('SIGINT') on
  // the Interface itself (not `process`) -- confirmed against
  // lib/internal/readline/interface.js for the Node version installed here.
  // With zero listeners on the interface, it takes an internal path that
  // rejects the pending question() via a private `kQuestionReject` symbol --
  // present starting Node v20.19.5 / v22.19.0 / v24.18.0, but confirmed
  // ABSENT (by fetching and reading lib/readline/promises.js at each tag)
  // on other current, in-range versions: v20.19.0, v20.19.1, v22.0.0,
  // v22.12.0. On an affected version, a pending question() would never
  // settle at all -- no revert, a stale lock file, a silent exit.
  //
  // Registering a listener here instead makes readline take the
  // `this.emit('SIGINT')` branch, which is identical across every version
  // checked above -- version-independent by construction, unlike the
  // private-symbol path. We then settle the pending question() ourselves
  // through the *public* AbortSignal option on question(), which has also
  // existed unchanged across that same version range (confirmed the same
  // way). Verified directly (not just reasoned about): a standalone script
  // that builds this exact interface+listener+question(signal) shape and
  // calls `rl.emit('SIGINT')` on it -- mirroring exactly what the raw-mode
  // handler's `this.emit('SIGINT')` line does -- resolves cleanly to a
  // decline with no hang, while the same emit on an interface with no
  // listener registered leaves the question permanently pending (proving
  // the listener, not some other implicit mechanism, is what causes the
  // clean settlement).
  rl.on("SIGINT", () => {
    abortController.abort();
    rl.close();
  });
  // EOF/closed stdin (piped input, `< /dev/null`, a non-interactive
  // dispatch) is the other way this prompt can never be answered. Without
  // this listener the pending question() never settles at all: the caller's
  // finally block never runs, the staged content is never reverted, and
  // unapproved LLM-authored content is left sitting in the real config
  // files. Verified directly against Node v24.18.0 -- an interface built
  // over a stream that is .end()ed without an answer hangs forever with
  // only the SIGINT listener registered, and settles as a decline with
  // this one added. No rl.close() call here: 'close' firing means the
  // interface is already closing.
  rl.on("close", () => {
    abortController.abort();
  });
  try {
    const answer = await rl.question(promptText, { signal: abortController.signal });
    return answer.trim().toLowerCase() === expectedAnswer.toLowerCase();
  } catch (error) {
    if (error?.code === "ABORT_ERR" || error?.name === "AbortError") {
      // Ctrl+C or a closed/EOF stdin at the prompt -- treat either exactly
      // like answering "N". This is now the primary, version-independent
      // path; the AbortError catch around the call site in
      // askForApproval() is a second, belt-and-braces layer.
      return false;
    }
    throw error;
  } finally {
    rl.close();
  }
}

/**
 * The real implementations runGuardedEdit uses unless a caller overrides
 * them. Tests substitute only the external/non-deterministic pieces (the
 * LLM call, the prompt, the GitHub calls) and let everything that touches
 * the two editable files run for real against a temp git repo.
 */
const DEFAULT_DEPS = {
  hasUncommittedChanges,
  stageFiles,
  diffStaged,
  discardStaged,
  confirm,
  proposeEdit: (request, currentFiles, options) =>
    proposeEdit(request, currentFiles, { ...options, callOpenAI, callClaude }),
  createBackupTag,
  commitAndPush,
  findLatestRunForHeadSha,
  watchRun,
  downloadRunArtifacts,
  publishRelease,
  stageRelease,
  pruneOldReleases,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log: (...args) => console.log(...args),
  error: (...args) => console.error(...args),
  // main() supplies this to wire the same revert into its signal handlers.
  registerCleanup: undefined,
};

/**
 * Tracks whether LLM-proposed content is currently sitting *unapproved* in
 * the real working tree, and knows how to take it back out again.
 *
 * `staged` becomes true the moment the proposed content is written into the
 * real working tree; `approved` becomes true only once the person running
 * this has typed "y". Anything that ends the run while staged is true and
 * approved is false -- a decline, a thrown error, Ctrl+C, a closed stdin --
 * must leave the working tree exactly as it was.
 */
function createStagingGuard(root, deps) {
  const state = { staged: false, approved: false, changedPaths: [] };
  const revertUnapprovedStagedContent = () => {
    if (!state.staged || state.approved) return;
    try {
      deps.discardStaged(root, state.changedPaths);
      state.staged = false;
    } catch (revertError) {
      deps.error(`Failed to revert unapproved changes: ${revertError.message}`);
    }
  };
  return { state, revertUnapprovedStagedContent };
}

/** Ask the LLM for a proposal and structurally validate it. */
async function proposeAndValidate(root, request, options, deps) {
  const currentFiles = Object.fromEntries(
    ALLOWED_EDIT_PATHS.map((relativePath) => [
      relativePath,
      readFileSync(path.join(root, relativePath), "utf8"),
    ]),
  );

  deps.log(`Asking the LLM backend to propose a change for: "${request}"`);
  const proposal = await deps.proposeEdit(request, currentFiles, { backend: options.backend });
  deps.log(`Backend used: ${proposal.backend}`);

  const validation = validateProposedFiles(proposal.files);
  if (!validation.ok) {
    deps.error("Proposed change was rejected:");
    for (const reason of validation.reasons) deps.error(`  - ${reason}`);
    return null;
  }

  const confPath = ALLOWED_EDIT_PATHS.find((p) => p.endsWith(".conf"));
  const flaggedLines =
    confPath && proposal.files[confPath] !== undefined
      ? findNewSecuritySensitiveConfLines(currentFiles[confPath] ?? "", proposal.files[confPath], SECURITY_SENSITIVE_CONF_PREFIXES)
      : [];
  return { ...proposal, flaggedLines };
}

/** Write the proposed content into the real working tree and show the diff. */
function stageProposal(root, proposal, guard, deps) {
  // `staged`/`changedPaths` are set *before* calling stageFiles, not
  // after it returns. stageFiles writes each proposed path with a
  // separate writeFileSync in a loop -- if a later path's write throws
  // (a file lock from an editor/AV scanner, disk full, ...), an earlier
  // path may already have unapproved content sitting on disk while
  // stageFiles itself never returns. Setting these flags first means the
  // finally block's revert still fires and covers every proposed path,
  // including one whose write never actually happened -- discardStaged's
  // `git checkout --` tolerates a path with no modification.
  guard.state.changedPaths = Object.keys(proposal.files);
  guard.state.staged = true;
  deps.stageFiles(root, proposal.files);
  deps.log("\nProposed change:\n");
  deps.log(deps.diffStaged(root, guard.state.changedPaths));
}

/**
 * Prompt for the confirmation that gates every irreversible step below.
 * Normally that's a bare "y"; if the proposal touched a security-sensitive
 * `.conf` setting (see SECURITY_SENSITIVE_CONF_PREFIXES), this is a soft
 * warning with extra friction -- not a hard block -- so it instead requires
 * typing "yes-security" to make the change impossible to approve by reflex.
 */
async function askForApproval(proposal, deps) {
  if (proposal.flaggedLines.length > 0) {
    deps.error("\n⚠️  SECURITY WARNING ⚠️");
    deps.error("This change adds or changes security-relevant settings not present in the current config:");
    for (const line of proposal.flaggedLines) deps.error(`  - ${line}`);
    deps.error("These can change your keyboard's security posture (e.g. USB/BLE/logging exposure). Review the diff above carefully.");
    deps.log(
      '\nTyping "yes-security" will: push a backup tag, commit and push this change, trigger a firmware build, and (if it succeeds) publish a GitHub Release.',
    );
    try {
      // confirm() registers its own interface-level 'SIGINT' and 'close'
      // listeners and settles both Ctrl+C and a closed/EOF stdin as a
      // decline internally, on every Node version in range (see the
      // comment inside confirm() for why that's the primary mechanism now,
      // not this catch). This catch remains as a second, belt-and-braces
      // layer in case an AbortError of this shape ever surfaces some other
      // way.
      return await deps.confirm('Type "yes-security" to apply anyway, or anything else to cancel: ', { expectedAnswer: "yes-security" });
    } catch (error) {
      if (error?.code === "ABORT_ERR" || error?.name === "AbortError") return false;
      throw error;
    }
  }
  deps.log(
    "\nAnswering y will: push a backup tag, commit and push this change, trigger a firmware build, and (if it succeeds) publish a GitHub Release.",
  );
  try {
    // confirm() registers its own interface-level 'SIGINT' and 'close'
    // listeners and settles both Ctrl+C and a closed/EOF stdin as a decline
    // internally, on every Node version in range (see the comment inside
    // confirm() for why that's the primary mechanism now, not this catch).
    // This catch remains as a second, belt-and-braces layer in case an
    // AbortError of this shape ever surfaces some other way.
    return await deps.confirm("Apply this change? [y/N] ");
  } catch (error) {
    if (error?.code === "ABORT_ERR" || error?.name === "AbortError") {
      return false;
    }
    throw error;
  }
}

/** Revert and report after the user (or a closed stdin) said no. */
function reportDecline(guard, deps) {
  guard.revertUnapprovedStagedContent();
  if (guard.state.staged) {
    // The revert itself failed (already logged above) -- do not claim
    // "nothing was written" when the proposed content is still sitting
    // in the working tree.
    deps.error(
      `The change is still staged in the working tree because reverting it failed. Manually run: git checkout -- ${guard.state.changedPaths.join(" ")}`,
    );
    return { exitCode: 1, status: "declined-revert-failed" };
  }
  deps.log("Discarded. Nothing was written.");
  return { exitCode: 0, status: "declined" };
}

/**
 * Push the pre-change backup tag. Returns null (after reverting) if the tag
 * could not be pushed -- there would be nothing to recover from.
 */
function createBackup(root, request, guard, deps) {
  deps.log("Creating and pushing a backup tag before committing this change...");
  try {
    const backupTag = deps.createBackupTag(root, slugify(request));
    deps.log(`Backup tag pushed: ${backupTag}`);
    return backupTag;
  } catch (backupError) {
    // No commit exists yet -- the working tree only has the
    // staged-but-uncommitted proposed content. Revert it so nothing is
    // left half-applied when no backup exists to recover from.
    guard.state.approved = false;
    guard.revertUnapprovedStagedContent();
    if (guard.state.staged) {
      // The revert itself failed (already logged by
      // revertUnapprovedStagedContent above) -- do not claim the working
      // tree was reverted when it wasn't.
      deps.error(
        `${backupError.message} Additionally, reverting the working tree failed -- the change is still staged. Manually run: git checkout -- ${guard.state.changedPaths.join(" ")}`,
      );
    } else {
      deps.error(`${backupError.message} The working tree has been reverted -- no edit was committed.`);
    }
    return null;
  }
}

/** Poll for the workflow run that the pushed commit triggered. */
async function waitForRun(root, sha, deps) {
  deps.log("Waiting for the triggered build to start...");
  let run = null;
  for (let attempt = 0; attempt < 12 && !run; attempt++) {
    await deps.sleep(5_000);
    run = deps.findLatestRunForHeadSha(root, sha);
  }
  return run;
}

/** Download the built artifacts, stage them locally, and publish a Release. */
function publishBuiltFirmware(root, request, run, commitResult, backupTag, deps) {
  try {
    const downloadDir = mkdtempSync(path.join(tmpdir(), "edit-firmware-artifacts-"));
    const artifactPaths = deps.downloadRunArtifacts(root, run.runId, downloadDir);

    const releaseId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${commitResult.sha.slice(0, 7)}`;
    const releasesDir = path.join(root, RELEASES_DIR);
    const releaseDir = deps.stageRelease(releasesDir, releaseId, artifactPaths);
    deps.pruneOldReleases(releasesDir, RELEASE_RETENTION_COUNT);

    // The Release gets its own new tag pinned to the commit the firmware
    // was actually built from. Publishing it on `backupTag` instead put
    // the Release on the pre-change commit -- its tag and "source code"
    // links pointed at the revision *before* the change, contradicting
    // the .uf2 files attached to it. The rollback instructions in the
    // notes still reference backupTag: rolling back should go to the
    // pre-change state, which is exactly what that tag is for.
    deps.publishRelease(
      root,
      `firmware/${releaseId}`,
      releaseDir,
      `Firmware built from commit ${commitResult.sha} for request: ${request}\n\nRollback: node tools/edit-firmware/src/rollback.mjs --to ${backupTag}`,
      { targetSha: commitResult.sha },
    );

    const manifest = readFileSync(path.join(releaseDir, "SHA256SUMS.txt"), "utf8");
    deps.log("\nFirmware ready.\n");
    deps.log(`Release folder: ${releaseDir}`);
    deps.log(`Checksums:\n${manifest}`);
    deps.log(
      "To flash: put each half in bootloader mode in turn, then copy the matching .uf2 file onto the drive that appears. This step is manual -- nothing here touches the keyboard.",
    );
    return { exitCode: 0, status: "released", releaseDir };
  } catch (postBuildError) {
    deps.error(
      `The build succeeded but something went wrong staging the release: ${postBuildError.message}\n` +
        `The firmware exists in CI -- download it manually from ${run.url}, or re-run this tool once the issue is fixed.`,
    );
    return { exitCode: 1, status: "release-staging-failed" };
  }
}

/** Everything downstream of the "y": backup, commit, push, build, release. */
async function runApprovedPipeline(root, request, guard, deps) {
  const backupTag = createBackup(root, request, guard, deps);
  if (!backupTag) return { exitCode: 1, status: "backup-failed" };

  const commitResult = deps.commitAndPush(root, `firmware: ${request}`, guard.state.changedPaths);
  if (!commitResult.pushed) {
    deps.error(
      `Change was committed locally (${commitResult.sha}) but the push failed. The backup tag is already safe on origin. Retry "git push" manually, or re-run this tool once network/auth is fixed.`,
    );
    return { exitCode: 1, status: "push-failed" };
  }
  if (!commitResult.committed) {
    deps.log("Nothing changed -- the proposed content matched what's already there. No commit, no build.");
    return { exitCode: 0, status: "no-op" };
  }
  deps.log(`Pushed commit ${commitResult.sha}. This triggers build.yml automatically.`);

  const run = await waitForRun(root, commitResult.sha, deps);
  if (!run) {
    deps.error(
      `Could not find a triggered workflow run for commit ${commitResult.sha}. Check https://github.com/rpatel2023/zmk-eyelash-corne/actions manually.`,
    );
    return { exitCode: 1, status: "no-run-found" };
  }

  deps.log(`Watching run: ${run.url}`);
  const finished = await deps.watchRun(root, run.runId);
  if (finished.conclusion !== "success") {
    deps.error(
      `Build finished with conclusion "${finished.conclusion}". Nothing was flashed. See ${finished.url}. Your last good release is untouched.`,
    );
    return { exitCode: 1, status: "build-failed" };
  }

  deps.log("Build succeeded. Downloading artifacts...");
  return publishBuiltFirmware(root, request, run, commitResult, backupTag, deps);
}

/**
 * The guarded edit state machine, from the dirty-tree precondition through
 * to the published Release.
 *
 * Returns an outcome object rather than setting process.exitCode directly,
 * so a test can drive it without poisoning the test runner's own exit code.
 * The finally block is the load-bearing invariant: on *every* exit path --
 * decline, thrown error, closed stdin, failed backup, a stageFiles that
 * threw mid-loop -- unapproved content is taken back out of the working
 * tree before this function returns.
 *
 * @param {string} root Absolute path to the repo checkout to operate on.
 * @param {string} request The plain-language change request.
 * @param {{backend?: string}} options Backend selection.
 * @param {object} overrides Dependency overrides; see DEFAULT_DEPS.
 * @returns {Promise<{exitCode: number, status: string}>} Run outcome.
 */
export async function runGuardedEdit(root, request, options = {}, overrides = {}) {
  const deps = { ...DEFAULT_DEPS, ...overrides };
  const guard = createStagingGuard(root, deps);
  deps.registerCleanup?.(guard.revertUnapprovedStagedContent);

  try {
    if (deps.hasUncommittedChanges(root, ALLOWED_EDIT_PATHS)) {
      deps.error(
        `You have uncommitted changes to ${ALLOWED_EDIT_PATHS.join(" or ")} already -- commit or stash them first, then re-run this tool.`,
      );
      return { exitCode: 1, status: "dirty-tree" };
    }

    const proposal = await proposeAndValidate(root, request, options, deps);
    if (!proposal) return { exitCode: 1, status: "proposal-rejected" };

    stageProposal(root, proposal, guard, deps);

    if (!(await askForApproval(proposal, deps))) return reportDecline(guard, deps);
    guard.state.approved = true;

    return await runApprovedPipeline(root, request, guard, deps);
  } finally {
    guard.revertUnapprovedStagedContent();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const backendFlagIndex = args.indexOf("--backend");
  const backend = backendFlagIndex >= 0 ? args[backendFlagIndex + 1] : undefined;
  const request = (backendFlagIndex >= 0 ? args.slice(0, backendFlagIndex) : args).join(" ").trim();

  if (!request) {
    console.error('Usage: node src/edit-firmware.mjs "<plain-language request>" [--backend openai|claude]');
    process.exitCode = 1;
    return;
  }

  const root = repoRoot();
  const lockPath = path.join(root, LOCK_FILE_PATH);
  if (existsSync(lockPath)) {
    console.error(`Another edit-firmware run appears to be in progress (${lockPath} exists). If you're sure it isn't, delete that file and retry.`);
    process.exitCode = 1;
    return;
  }

  // Refuse up front rather than spending an API call and writing proposed
  // content into the working tree in a context where the [y/N] approval
  // can never be given. confirm()'s 'close' listener makes a non-TTY run
  // fail safe (it declines and reverts), but failing *early* is better
  // still: no LLM spend, no working-tree write, no lock file to clean up.
  // Deliberately placed before writeFileSync(lockPath) below for that
  // last reason.
  if (!process.stdin.isTTY) {
    console.error("edit-firmware requires an interactive terminal -- the [y/N] confirmation cannot be given without one.");
    process.exitCode = 1;
    return;
  }

  // Node does not run pending try/finally blocks on SIGINT/SIGTERM unless a
  // handler is registered -- without this, Ctrl+C at the "[y/N]" prompt
  // (the single most natural way to say "no" to something alarming) would
  // terminate the process immediately and skip the finally blocks below,
  // leaving unapproved LLM content sitting in the real config files.
  let revertUnapprovedStagedContent = () => {};
  let shuttingDown = false;
  const cleanupAndExit = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`\nReceived ${signal}; cleaning up before exit...`);
    revertUnapprovedStagedContent();
    if (existsSync(lockPath)) {
      try {
        unlinkSync(lockPath);
      } catch {
        // Best-effort: a signal-time failure to remove the lock is
        // reported to the operator via the stale-lock message on next run,
        // not swallowed silently, but is not itself fatal here.
        console.error(`Could not remove lock file ${lockPath}; you may need to delete it manually before the next run.`);
      }
    }
    process.exit(130);
  };
  process.on("SIGINT", () => cleanupAndExit("SIGINT"));
  process.on("SIGTERM", () => cleanupAndExit("SIGTERM"));

  writeFileSync(lockPath, String(process.pid), "utf8");

  try {
    const result = await runGuardedEdit(root, request, { backend }, {
      registerCleanup: (revert) => {
        revertUnapprovedStagedContent = revert;
      },
    });
    process.exitCode = result.exitCode;
  } finally {
    unlinkSync(lockPath);
  }
}

// Only run the CLI when this file is the process entry point, so importing
// runGuardedEdit/confirm from a test does not kick off a real edit run.
// pathToFileURL (not a hand-built `file://` + path string) is what makes
// this correct on Windows, where argv[1] is a drive-letter path with
// backslashes that does not concatenate into a valid file URL.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
}
