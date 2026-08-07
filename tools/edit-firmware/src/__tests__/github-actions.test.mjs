import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  findLatestRunForHeadSha,
  watchRun,
  downloadRunArtifacts,
  publishRelease,
} from "../github-actions.mjs";

test("findLatestRunForHeadSha builds the correct gh CLI invocation and parses its JSON", () => {
  let capturedArgs = null;
  const fakeExec = (command, args) => {
    capturedArgs = { command, args };
    return JSON.stringify([
      { databaseId: 111, headSha: "deadbeef", status: "completed", conclusion: "success", url: "https://github.com/x/y/actions/runs/111" },
      { databaseId: 110, headSha: "otherSha", status: "completed", conclusion: "success", url: "https://github.com/x/y/actions/runs/110" },
    ]);
  };

  const result = findLatestRunForHeadSha("/repo", "deadbeef", { exec: fakeExec });

  assert.equal(capturedArgs.command, "gh");
  assert.deepEqual(capturedArgs.args.slice(0, 2), ["run", "list"]);
  assert.deepEqual(result, {
    runId: "111",
    status: "completed",
    conclusion: "success",
    url: "https://github.com/x/y/actions/runs/111",
  });
});

test("findLatestRunForHeadSha returns null when no run matches the sha", () => {
  const fakeExec = () => JSON.stringify([{ databaseId: 1, headSha: "unrelated", status: "completed", conclusion: "success", url: "x" }]);
  assert.equal(findLatestRunForHeadSha("/repo", "deadbeef", { exec: fakeExec }), null);
});

test("watchRun polls gh run view until the run is no longer in_progress/queued", () => {
  const responses = [
    JSON.stringify({ status: "in_progress", conclusion: null, url: "https://x/111" }),
    JSON.stringify({ status: "completed", conclusion: "success", url: "https://x/111" }),
  ];
  let callCount = 0;
  const fakeExec = () => responses[Math.min(callCount++, responses.length - 1)];
  const fakeSleep = () => {}; // synchronous no-op, avoids a real delay in the test

  const result = watchRun("/repo", "111", { exec: fakeExec, sleep: fakeSleep });

  assert.deepEqual(result, { conclusion: "success", url: "https://x/111" });
  assert.equal(callCount, 2);
});

test("downloadRunArtifacts returns paths for .uf2 files nested under per-artifact subdirectories", () => {
  const destDir = mkdtempSync(path.join(tmpdir(), "gh-download-test-"));
  try {
    let capturedArgs = null;
    const fakeExec = (command, args) => {
      capturedArgs = { command, args };
      // Mimic `gh run download`'s real layout: each artifact lands in its
      // own subdirectory named after the artifact.
      const artifactDir = path.join(destDir, "eyelash_corne_left-uf2");
      mkdirSync(artifactDir, { recursive: true });
      const block = Buffer.alloc(512);
      block.writeUInt32LE(0x0a324655, 0); // UF2 MagicStart0
      writeFileSync(path.join(artifactDir, "eyelash_corne_left.uf2"), block);
      return "";
    };

    const result = downloadRunArtifacts("/repo", "111", destDir, { exec: fakeExec });

    assert.equal(capturedArgs.command, "gh");
    assert.deepEqual(capturedArgs.args.slice(0, 2), ["run", "download"]);
    assert.deepEqual(result, [
      path.join(destDir, "eyelash_corne_left-uf2", "eyelash_corne_left.uf2"),
    ]);
  } finally {
    rmSync(destDir, { recursive: true, force: true });
  }
});

test("downloadRunArtifacts throws when a downloaded .uf2 file fails looksLikeUf2", () => {
  const destDir = mkdtempSync(path.join(tmpdir(), "gh-download-test-"));
  try {
    const fakeExec = () => {
      const artifactDir = path.join(destDir, "eyelash_corne_right-uf2");
      mkdirSync(artifactDir, { recursive: true });
      // Wrong magic number / not block-aligned -- looksLikeUf2 must reject it.
      writeFileSync(path.join(artifactDir, "eyelash_corne_right.uf2"), Buffer.from("not a uf2"));
      return "";
    };

    assert.throws(
      () => downloadRunArtifacts("/repo", "111", destDir, { exec: fakeExec }),
      /does not look like a valid UF2 image/,
    );
  } finally {
    rmSync(destDir, { recursive: true, force: true });
  }
});

test("publishRelease builds the correct gh release create invocation", () => {
  // publishRelease enumerates releaseDir's real contents (there is no
  // injectable fs dependency, matching how the rest of this codebase tests
  // filesystem behavior with real temp dirs -- see checksum.test.mjs and
  // release-store.test.mjs) -- so releaseDir must actually exist on disk.
  const releaseDir = mkdtempSync(path.join(tmpdir(), "gh-publish-test-"));
  try {
    writeFileSync(path.join(releaseDir, "eyelash_corne_left.uf2"), "fake firmware bytes");
    writeFileSync(path.join(releaseDir, "SHA256SUMS.txt"), "deadbeef  eyelash_corne_left.uf2\n");

    let capturedArgs = null;
    const fakeExec = (command, args) => {
      capturedArgs = { command, args };
      return "";
    };

    publishRelease("/repo", "firmware/2026-01-01-x", releaseDir, "Release notes here", {
      exec: fakeExec,
    });

    assert.equal(capturedArgs.command, "gh");
    assert.deepEqual(capturedArgs.args.slice(0, 2), ["release", "create"]);
    assert.ok(capturedArgs.args.includes("firmware/2026-01-01-x"));
    assert.ok(capturedArgs.args.includes(path.join(releaseDir, "eyelash_corne_left.uf2")));
    assert.ok(capturedArgs.args.includes(path.join(releaseDir, "SHA256SUMS.txt")));
    assert.ok(capturedArgs.args.some((arg) => arg.includes("Release notes here")));
    // Omitting targetSha must leave the argv exactly as it was before
    // --target existed -- nothing else in this codebase needs one.
    assert.ok(!capturedArgs.args.includes("--target"), "no --target flag when targetSha is omitted");
  } finally {
    rmSync(releaseDir, { recursive: true, force: true });
  }
});

test("publishRelease pins the Release to targetSha with --target when one is given", () => {
  // Regression guard: the Release used to be created on the pre-change
  // backup tag, so its tag and "source code" links pointed at the commit
  // *before* the change while its attached .uf2 files were built from the
  // commit *after*. --target is what makes gh create the new tag at the
  // commit the firmware actually came from.
  const releaseDir = mkdtempSync(path.join(tmpdir(), "gh-publish-target-test-"));
  try {
    writeFileSync(path.join(releaseDir, "eyelash_corne_left.uf2"), "fake firmware bytes");

    let capturedArgs = null;
    const fakeExec = (command, args) => {
      capturedArgs = { command, args };
      return "";
    };

    publishRelease("/repo", "firmware/2026-01-01-x", releaseDir, "notes", {
      targetSha: "abc1234def5678",
      exec: fakeExec,
    });

    const targetIndex = capturedArgs.args.indexOf("--target");
    assert.notEqual(targetIndex, -1, "--target must be present when targetSha is passed");
    assert.equal(capturedArgs.args[targetIndex + 1], "abc1234def5678", "--target must carry the build commit's sha");

    // The Release must not be created on the backup tag any more.
    assert.ok(
      !capturedArgs.args.some((arg) => typeof arg === "string" && arg.startsWith("backup/")),
      "the Release tag must not be a backup/ tag",
    );
    assert.equal(capturedArgs.args[2], "firmware/2026-01-01-x", "the tag argument is the new firmware/ tag");
  } finally {
    rmSync(releaseDir, { recursive: true, force: true });
  }
});
