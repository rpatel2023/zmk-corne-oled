import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { stageRelease, pruneOldReleases, listReleases } from "../release-store.mjs";

function withTempReleasesDir(run) {
  const dir = mkdtempSync(path.join(tmpdir(), "release-store-test-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("stageRelease copies artifacts and writes a checksum manifest", () => {
  withTempReleasesDir((releasesDir) => {
    const sourceDir = mkdtempSync(path.join(tmpdir(), "artifacts-"));
    const artifactPath = path.join(sourceDir, "eyelash_corne_left.uf2");
    writeFileSync(artifactPath, "fake firmware bytes");

    const releaseDir = stageRelease(releasesDir, "20260805T120000Z-abc1234", [artifactPath]);

    assert.ok(existsSync(path.join(releaseDir, "eyelash_corne_left.uf2")));
    const manifest = readFileSync(path.join(releaseDir, "SHA256SUMS.txt"), "utf8");
    assert.match(manifest, /eyelash_corne_left\.uf2/);
    assert.match(manifest, /^[0-9a-f]{64} {2}eyelash_corne_left\.uf2$/m);

    rmSync(sourceDir, { recursive: true, force: true });
  });
});

test("listReleases returns release directory names newest first", () => {
  withTempReleasesDir((releasesDir) => {
    mkdirSync(path.join(releasesDir, "20260101T000000Z-aaa1111"));
    mkdirSync(path.join(releasesDir, "20260805T000000Z-bbb2222"));
    mkdirSync(path.join(releasesDir, "20260301T000000Z-ccc3333"));

    assert.deepEqual(listReleases(releasesDir), [
      "20260805T000000Z-bbb2222",
      "20260301T000000Z-ccc3333",
      "20260101T000000Z-aaa1111",
    ]);
  });
});

test("listReleases returns an empty array when the releases directory doesn't exist yet", () => {
  withTempReleasesDir((releasesDir) => {
    assert.deepEqual(listReleases(path.join(releasesDir, "does-not-exist")), []);
  });
});

test("pruneOldReleases removes everything beyond the retention count, oldest first", () => {
  withTempReleasesDir((releasesDir) => {
    mkdirSync(path.join(releasesDir, "20260101T000000Z-a"));
    mkdirSync(path.join(releasesDir, "20260201T000000Z-b"));
    mkdirSync(path.join(releasesDir, "20260301T000000Z-c"));

    const pruned = pruneOldReleases(releasesDir, 2);

    assert.deepEqual(pruned, ["20260101T000000Z-a"]);
    assert.deepEqual(listReleases(releasesDir), [
      "20260301T000000Z-c",
      "20260201T000000Z-b",
    ]);
  });
});
