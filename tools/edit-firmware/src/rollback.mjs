#!/usr/bin/env node
/**
 * Entry point: node src/rollback.mjs --list
 *             node src/rollback.mjs --to <backup-tag>
 *
 * Independent of edit-firmware.mjs -- does not call any LLM and does not
 * trigger a new build. --to restores the source to a prior tag (as a new
 * commit, never a destructive reset) and points at that backup's already-
 * built release folder, if one exists.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { ALLOWED_EDIT_PATHS, RELEASES_DIR } from "./config.mjs";
import { listBackupTags, revertConfigToTag, hasUncommittedChanges } from "./git-helpers.mjs";
import { listReleases } from "./release-store.mjs";

function repoRoot() {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
}

function releaseIdForTag(releases, tagName) {
  // Release folder names are "<timestamp>-<short-sha>"; a backup tag name
  // is "backup/<timestamp>-<slug>". Both timestamps come from
  // `new Date().toISOString().replace(/[:.]/g, "-")`, which always produces
  // a fixed-length 24-character string ("YYYY-MM-DDTHH-mm-ss-sssZ"). Fixed-
  // width ISO-8601 fields sort and compare correctly as plain strings, so
  // the first 24 characters of each name are directly, lexically
  // comparable as real timestamps -- there's no guaranteed direct name
  // match beyond that, so this is a best-effort hint (closest release at
  // or after the tag's own moment), not a strict guarantee.
  //
  // An earlier version of this function only compared the first "-"-split
  // segment, which -- because the timestamp's own date portion (YYYY-MM-DD)
  // contains hyphens -- collapsed to just the year (e.g. "2026"). That
  // matched the newest release from the same *year* regardless of month or
  // day, silently pointing at the wrong build whenever multiple backup tags
  // and releases existed across different months of the same year.
  //
  // The *correct* match for a given backup tag is the release built
  // immediately after it: an edit run always creates the backup tag first
  // and only then commits/builds, so that run's own release is the
  // closest one with a timestamp >= the tag's -- not just any later
  // release. A tempting-looking fix that instead does
  // `releases.find(id => id.slice(0, 24) >= tagTimestamp)` directly on
  // this newest-first array is still wrong: it stops at the *newest*
  // release satisfying `>=`, which is the wrong answer the moment more
  // than one tag/release pair exists -- e.g. tags from January and July
  // with releases from February and August would still match the January
  // tag to the August release, because August also satisfies `>= January`
  // and is examined first (verified concretely before rejecting this
  // approach -- see the Task 12 fix report). Scanning from the OLDEST end
  // instead and returning the first (smallest-timestamp) release that
  // still qualifies correctly pairs January with February and July with
  // August.
  const tagTimestamp = tagName.split("/")[1]?.slice(0, 24);
  if (!tagTimestamp) return null;
  for (let i = releases.length - 1; i >= 0; i--) {
    if (releases[i].slice(0, 24) >= tagTimestamp) return releases[i];
  }
  return null;
}

function main() {
  const args = process.argv.slice(2);
  const root = repoRoot();
  const releasesDir = path.join(root, RELEASES_DIR);

  if (args[0] === "--list") {
    const tags = listBackupTags(root);
    const releases = listReleases(releasesDir);
    if (tags.length === 0) {
      console.log("No backup tags found.");
      return;
    }
    console.log("Backup tags (newest first):\n");
    for (const tag of tags) {
      const matchedRelease = releaseIdForTag(releases, tag);
      console.log(`  ${tag}${matchedRelease ? `  (release: ${matchedRelease})` : "  (no local release folder found)"}`);
    }
    return;
  }

  if (args[0] === "--to" && args[1]) {
    const tagName = args[1];
    const tags = listBackupTags(root);
    if (!tags.includes(tagName)) {
      console.error(`"${tagName}" is not a known backup tag. Run --list to see available tags.`);
      process.exitCode = 1;
      return;
    }
    // revertConfigToTag's `git checkout <tag> -- <paths>` overwrites the
    // editable files unconditionally. Uncommitted work in them has no
    // recovery path whatsoever -- no stash entry, no reflog entry, nothing
    // in the object DB -- so it must be committed or stashed before the
    // rollback runs. edit-firmware.mjs guards its own flow the same way.
    if (hasUncommittedChanges(root, ALLOWED_EDIT_PATHS)) {
      console.error(
        `You have uncommitted changes to ${ALLOWED_EDIT_PATHS.join(" or ")} -- commit or stash them first, then re-run rollback.`,
      );
      process.exitCode = 1;
      return;
    }
    const result = revertConfigToTag(root, tagName);
    console.log(`Source restored to ${tagName} as new commit ${result.sha}. Push this yourself when ready: git push origin HEAD`);

    const releases = listReleases(releasesDir);
    const matchedRelease = releaseIdForTag(releases, tagName);
    if (matchedRelease) {
      console.log(`A previously built release for around this point exists at: ${path.join(releasesDir, matchedRelease)}`);
      console.log("You can flash that firmware directly without waiting for a new build, if you trust it still matches this source state.");
    } else {
      console.log("No local release folder was found for this backup point. Push the reverted commit and let build.yml produce fresh firmware.");
    }
    return;
  }

  console.error("Usage: node src/rollback.mjs --list\n       node src/rollback.mjs --to <backup-tag>");
  process.exitCode = 1;
}

main();
