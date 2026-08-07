/**
 * Backend-agnostic orchestration for proposing a firmware config edit.
 * This module has no knowledge of how OpenAI or Claude are actually
 * called -- callOpenAI/callClaude are required parameters, always
 * supplied by the caller (edit-firmware.mjs passes the real
 * implementations from openai-backend.mjs/claude-backend.mjs; tests pass
 * fakes). That keeps this file fully unit-testable without spending API
 * credit or requiring Claude Code to be installed, and avoids this file
 * depending on two files (openai-backend.mjs, claude-backend.mjs) that
 * are implemented in later tasks.
 */
import { DEFAULT_LLM_BACKEND } from "./config.mjs";

export async function proposeEdit(request, currentFiles, options = {}) {
  const backend = options.backend ?? DEFAULT_LLM_BACKEND;
  const { callOpenAI, callClaude } = options;
  if (typeof callOpenAI !== "function" || typeof callClaude !== "function") {
    throw new Error("proposeEdit requires both options.callOpenAI and options.callClaude functions.");
  }

  if (backend === "claude") {
    const files = await callClaude(request, currentFiles);
    return { files, backend: "claude" };
  }

  try {
    const files = await callOpenAI(request, currentFiles);
    return { files, backend: "openai" };
  } catch (openaiError) {
    console.error(`OpenAI backend failed (${openaiError.message}); falling back to claude -p.`);
    try {
      const files = await callClaude(request, currentFiles);
      return { files, backend: "claude" };
    } catch (claudeError) {
      throw new Error(
        `Both LLM backends failed. OpenAI: ${openaiError.message}. Claude: ${claudeError.message}.`,
      );
    }
  }
}
