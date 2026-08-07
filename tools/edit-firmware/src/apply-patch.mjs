/**
 * The safety gate between an LLM's proposed file content and the real
 * working tree. Nothing here ever executes what it validates -- it only
 * decides whether a proposal is even eligible to be shown to the owner as
 * "ready to apply."
 *
 * Design note: earlier drafts of this tool planned to apply an LLM-
 * generated unified diff. That was changed during implementation planning
 * to "the LLM returns complete new file content" -- see the plan's
 * "Deviation from the approved spec" section. This module writes that
 * content directly into the real working tree (already a git checkout)
 * and uses `git diff`/`git checkout --` for display and discard, rather
 * than parsing and applying a patch format itself.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { ALLOWED_EDIT_PATHS } from "./config.mjs";
import { checkStructureForPath } from "./structural-check.mjs";

export function validateProposedFiles(proposedFiles) {
  const reasons = [];
  const paths = Object.keys(proposedFiles);

  if (paths.length === 0) {
    return { ok: false, reasons: ["No files were proposed."] };
  }

  for (const relativePath of paths) {
    if (!ALLOWED_EDIT_PATHS.includes(relativePath)) {
      reasons.push(
        `"${relativePath}" is not an editable path. Only ${ALLOWED_EDIT_PATHS.join(", ")} may be changed by this tool.`,
      );
      continue;
    }
    const content = proposedFiles[relativePath];
    if (typeof content !== "string") {
      reasons.push(`"${relativePath}" content must be a string, got ${typeof content}.`);
      continue;
    }
    const structural = checkStructureForPath(relativePath, content);
    if (!structural.ok) {
      reasons.push(`"${relativePath}" failed its structural check: ${structural.reason}`);
    }
  }

  return { ok: reasons.length === 0, reasons };
}

export function stageFiles(repoRoot, proposedFiles) {
  for (const [relativePath, content] of Object.entries(proposedFiles)) {
    writeFileSync(path.join(repoRoot, relativePath), content, "utf8");
  }
}

export function diffStaged(repoRoot, paths) {
  return execFileSync("git", ["diff", "--", ...paths], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

export function discardStaged(repoRoot, paths) {
  execFileSync("git", ["checkout", "--", ...paths], { cwd: repoRoot });
}
