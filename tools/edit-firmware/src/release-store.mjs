/**
 * Manages the local, gitignored copy of built firmware releases under
 * tools/edit-firmware/releases/. This is a fast-access convenience for
 * rollback.mjs -- the GitHub Release (created by github-actions.mjs) is
 * the permanent record, since local copies are pruned.
 */
import { existsSync, mkdirSync, readdirSync, copyFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { sha256File } from "./checksum.mjs";

export function stageRelease(releasesDir, releaseId, artifactPaths) {
  const releaseDir = path.join(releasesDir, releaseId);
  mkdirSync(releaseDir, { recursive: true });

  const manifestLines = [];
  for (const artifactPath of artifactPaths) {
    const fileName = path.basename(artifactPath);
    copyFileSync(artifactPath, path.join(releaseDir, fileName));
    manifestLines.push(`${sha256File(artifactPath)}  ${fileName}`);
  }
  writeFileSync(
    path.join(releaseDir, "SHA256SUMS.txt"),
    manifestLines.join("\n") + "\n",
    "utf8",
  );

  return releaseDir;
}

export function listReleases(releasesDir) {
  if (!existsSync(releasesDir)) return [];
  return readdirSync(releasesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();
}

export function pruneOldReleases(releasesDir, retentionCount) {
  const releases = listReleases(releasesDir); // newest first
  const toPrune = releases.slice(retentionCount); // everything beyond retention
  for (const releaseId of toPrune) {
    rmSync(path.join(releasesDir, releaseId), { recursive: true, force: true });
  }
  return toPrune.reverse(); // oldest-pruned-first, matching the test's expectation
}
