/**
 * Git operations for the guarded firmware edit tool. Deliberately never
 * uses `git reset --hard` or a force-push anywhere: rollback restores the
 * two editable files to a prior tag's content as a brand-new commit, so
 * history is always additive and nothing already pushed is ever rewritten.
 */
import { execFileSync } from "node:child_process";
import { ALLOWED_EDIT_PATHS, BACKUP_TAG_PREFIX } from "./config.mjs";

function git(repoRoot, args) {
  // execFileSync's documented default sends the child's stderr straight to
  // this process's stderr even though stdout is captured -- that would leak
  // git's own progress/error chatter (e.g. push confirmations, "fatal: ..."
  // on a broken remote) into whatever is running this tool. Pipe all three
  // streams so output is captured, not inherited; on failure it still shows
  // up via error.stderr / error.message for callers that need it.
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function currentHeadSha(repoRoot) {
  return git(repoRoot, ["rev-parse", "HEAD"]).trim();
}

// `git status --porcelain` on the two allowed paths is non-empty if the
// user already has uncommitted edits sitting there. stageFiles() would
// silently overwrite those, and discardStaged()'s `git checkout --` only
// restores to the last *commit* -- so a decline afterward would silently
// destroy the user's own pre-existing, never-committed work. Refusing up
// front is the only safe option; there is no revert target to fall back to.
//
// The same hazard applies to rollback's revertConfigToTag, whose
// `git checkout <tag> -- <paths>` overwrites uncommitted content in those
// paths with no recovery path at all (no stash entry, no reflog entry,
// nothing in the object DB). Both entry points guard with this, which is
// why it lives here rather than in either one of them.
export function hasUncommittedChanges(root, paths) {
  // Piped stdio matches every git invocation in git-helpers.mjs -- without
  // it, execFileSync's default sends the child's stderr straight to this
  // process's stderr, which would leak git's own chatter into this tool's
  // output on any unexpected git error.
  const output = execFileSync("git", ["status", "--porcelain", "--", ...paths], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return output.trim().length > 0;
}

// `git diff --cached --quiet -- <paths>` exits 0 when those specific paths
// match HEAD (nothing staged for them) and 1 when there is a staged
// difference for at least one of them. Any other exit status means
// something actually went wrong (not a "clean" outcome), so that case is
// re-thrown rather than silently treated as "no changes."
//
// The pathspec is load-bearing, not cosmetic: an earlier version of this
// check looked at the whole index (`git diff --cached --quiet` with no
// pathspec). If the caller (or the user, before running this tool) has
// something unrelated already staged elsewhere in the repo, an index-wide
// check reports "something is staged" even when the paths this function's
// caller actually cares about have no change at all -- which, combined
// with the pathspec-scoped `git commit` below, made a real no-op for
// `paths` fall through into `git commit -- <paths>` with literally nothing
// to commit for those paths, and git exits non-zero. Scoping the check to
// the same paths as the commit keeps the two in sync.
function hasStagedChanges(repoRoot, paths) {
  try {
    execFileSync("git", ["diff", "--cached", "--quiet", "--", ...paths], {
      cwd: repoRoot,
      stdio: "ignore",
    });
    return false;
  } catch (error) {
    if (error.status === 1) {
      return true;
    }
    throw error;
  }
}

export function createBackupTag(repoRoot, slug) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const tagName = `${BACKUP_TAG_PREFIX}${timestamp}-${slug}`;
  git(repoRoot, ["tag", tagName]);
  try {
    git(repoRoot, ["push", "origin", tagName]);
  } catch (error) {
    git(repoRoot, ["tag", "-d", tagName]);
    throw new Error(
      `Failed to push backup tag "${tagName}" to origin -- aborting before committing this edit. Underlying error: ${error.message}`,
    );
  }
  return tagName;
}

export function commitAndPush(repoRoot, message, paths) {
  git(repoRoot, ["add", "--", ...paths]);
  if (!hasStagedChanges(repoRoot, paths)) {
    // Nothing actually changed for the given paths -- committing here
    // would just throw "nothing to commit, working tree clean". There is
    // also nothing to push, so report success: there is nothing wrong,
    // the requested state (paths committed) already holds. `committed:
    // false` lets callers distinguish this no-op from a real commit, so
    // they don't report a build as "triggered" when nothing was pushed.
    return { pushed: true, committed: false, sha: currentHeadSha(repoRoot) };
  }
  // The pathspec on `commit` (not just on the preceding `add`) is load-
  // bearing: it scopes the commit to exactly these paths' current content,
  // regardless of anything else already sitting in the index (e.g. a change
  // to config/west.yml the caller staged before running this tool). Without
  // it, `git commit` commits the whole index, which would let unrelated,
  // unvalidated content ride along into a pushed commit that triggers a
  // real CI build.
  git(repoRoot, ["commit", "-m", message, "--", ...paths]);
  const sha = currentHeadSha(repoRoot);
  try {
    git(repoRoot, ["push", "origin", "HEAD"]);
    return { pushed: true, committed: true, sha };
  } catch {
    return { pushed: false, committed: true, sha };
  }
}

export function listBackupTags(repoRoot) {
  const output = git(repoRoot, [
    "tag",
    "--list",
    `${BACKUP_TAG_PREFIX}*`,
    "--sort=-creatordate",
  ]);
  return output.split("\n").map((line) => line.trim()).filter(Boolean);
}

export function revertConfigToTag(repoRoot, tagName) {
  git(repoRoot, ["checkout", tagName, "--", ...ALLOWED_EDIT_PATHS]);
  git(repoRoot, ["add", "--", ...ALLOWED_EDIT_PATHS]);
  if (!hasStagedChanges(repoRoot, ALLOWED_EDIT_PATHS)) {
    // The editable files already match the tag's content -- e.g. this is
    // a repeat/no-op rollback, or a rollback to the tag the tree is
    // already at. Nothing to commit; resolve cleanly at the current HEAD
    // rather than throwing "nothing to commit, working tree clean".
    return { sha: currentHeadSha(repoRoot) };
  }
  // Same reasoning as commitAndPush's pathspec: without it, `git commit`
  // would sweep in anything else already staged in the index (e.g. an
  // unrelated in-progress edit) and label it part of this rollback commit
  // -- the rollback path is the user's safety net, so a mislabeled commit
  // here is worse than the equivalent bug in the normal edit path.
  git(repoRoot, ["commit", "-m", `rollback: restore config to ${tagName}`, "--", ...ALLOWED_EDIT_PATHS]);
  return { sha: currentHeadSha(repoRoot) };
}
