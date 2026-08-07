/**
 * Wraps the `gh` CLI (already authenticated on this machine) for
 * triggering/watching the existing build workflow and publishing a
 * GitHub Release. Every function accepts an injectable `exec` (and, for
 * watchRun, `sleep`) so the argument-building and response-parsing logic
 * is unit-testable without a real network call -- see Global Constraints
 * for why the real `gh` calls themselves are only manually verified.
 */
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { looksLikeUf2 } from "./checksum.mjs";
import { BUILD_WORKFLOW_FILE } from "./config.mjs";

function defaultExec(command, args, options) {
  return execFileSync(command, args, { encoding: "utf8", ...options });
}

// watchRun's documented return type is a plain object, not a Promise --
// Task 11 calls it without await -- so the default polling delay has to
// actually block rather than hand back a pending promise nobody awaits.
// Atomics.wait on a scratch Int32Array is Node's supported way to block
// the calling thread for a fixed duration outside a Worker.
function defaultSleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function findLatestRunForHeadSha(repoRoot, headSha, { exec = defaultExec } = {}) {
  const output = exec(
    "gh",
    [
      "run",
      "list",
      "--workflow",
      BUILD_WORKFLOW_FILE,
      "--json",
      "databaseId,headSha,status,conclusion,url",
      "--limit",
      "20",
    ],
    { cwd: repoRoot },
  );

  const runs = JSON.parse(output);
  const match = runs.find((run) => run.headSha === headSha);
  if (!match) return null;
  return {
    runId: String(match.databaseId),
    status: match.status,
    conclusion: match.conclusion,
    url: match.url,
  };
}

const IN_PROGRESS_STATUSES = new Set(["queued", "in_progress", "requested", "waiting"]);

export function watchRun(repoRoot, runId, { exec = defaultExec, sleep = defaultSleep } = {}) {
  for (;;) {
    const output = exec("gh", ["run", "view", runId, "--json", "status,conclusion,url"], {
      cwd: repoRoot,
    });
    const info = JSON.parse(output);
    if (!IN_PROGRESS_STATUSES.has(info.status)) {
      return { conclusion: info.conclusion, url: info.url };
    }
    sleep(10_000);
  }
}

export function downloadRunArtifacts(repoRoot, runId, destDir, { exec = defaultExec } = {}) {
  exec("gh", ["run", "download", runId, "--dir", destDir], { cwd: repoRoot });
  const downloaded = [];
  for (const entry of readdirSync(destDir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".uf2")) continue;
    // `gh run download` nests each artifact under its own subdirectory, so
    // the file's real location comes from parentPath. `entry.path` is the
    // older alias for the same thing (now `undefined` on current Node) --
    // kept as a fallback only for older runtimes that still populate it.
    const filePath = path.join(entry.parentPath ?? entry.path ?? destDir, entry.name);
    if (!looksLikeUf2(filePath)) {
      throw new Error(`Downloaded artifact "${filePath}" does not look like a valid UF2 image.`);
    }
    downloaded.push(filePath);
  }
  if (downloaded.length === 0) {
    throw new Error(`No .uf2 artifacts found in the downloaded run ${runId}.`);
  }
  return downloaded;
}

// `targetSha` pins the Release to a specific commit via `gh`'s --target,
// which creates the tag at that ref when it doesn't already exist. Without
// it, `gh release create <tag>` against an *existing* tag publishes the
// Release on that tag's commit -- so a Release tagged with the pre-change
// backup tag would point its tag and "source code" links at the revision
// *before* the change, while the .uf2 files attached to it were built from
// the revision *after*. Optional so the no-target call shape still works
// for any caller that genuinely wants tag-defined placement.
export function publishRelease(
  repoRoot,
  tagName,
  releaseDir,
  notes,
  { targetSha, exec = defaultExec } = {},
) {
  const assetPaths = readdirSync(releaseDir).map((name) => path.join(releaseDir, name));
  const args = ["release", "create", tagName, ...assetPaths, "--title", tagName, "--notes", notes];
  if (targetSha) {
    args.push("--target", targetSha);
  }
  exec("gh", args, { cwd: repoRoot });
}
