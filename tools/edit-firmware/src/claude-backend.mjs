/**
 * Fallback LLM backend: shells out to the Claude Code CLI in non-
 * interactive mode. Used automatically when OPENAI_API_KEY is unset or
 * the OpenAI call fails, or explicitly via --backend claude. Requires no
 * API key -- it uses whatever Claude Code auth is already configured on
 * this machine.
 *
 * `claude -p ... --output-format json` is a documented, stable Claude
 * Code CLI scripting feature (confirmed via `claude --help` and a live
 * call against Claude Code 2.1.220): the top-level JSON object has an
 * `is_error` boolean, a `subtype` field ("success" on success), and a
 * `result` field holding the model's final text reply. If the installed
 * CLI version has changed this shape, run `claude --help` locally and a
 * trivial `claude -p "hi" --output-format json` to confirm before
 * changing this file.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ALLOWED_EDIT_PATHS } from "./config.mjs";

const execFileAsync = promisify(execFile);

function buildPrompt(request, currentFiles) {
  const fileBlocks = Object.entries(currentFiles)
    .map(([relativePath, content]) => `--- ${relativePath} ---\n${content}`)
    .join("\n");

  return [
    `You edit exactly two ZMK firmware configuration files for a security-reviewed personal keyboard build (eyelash Corne, OLED lineage).`,
    `You may propose new content ONLY for these paths: ${ALLOWED_EDIT_PATHS.join(", ")}. Never propose a change to boards/, build.yaml, or config/west.yml.`,
    `Requested change: ${request}`,
    "",
    "Current file contents:",
    fileBlocks,
    "",
    'Respond with ONLY a JSON object of the exact shape {"files": {"<relative path>": "<complete new file content>"}} -- one key per file that actually needs to change, complete content (never a diff or excerpt), no other text before or after the JSON. Do not wrap the JSON in a markdown code fence.',
  ].join("\n");
}

/**
 * Extract a JSON object from the model's result text. Despite the prompt
 * asking for bare JSON, models sometimes wrap the reply in a ```json
 * fenced code block -- strip that if present before parsing so a
 * stylistic quirk doesn't turn into a hard failure.
 */
function extractJson(resultText) {
  const trimmed = resultText.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenced ? fenced[1] : trimmed;
}

export async function callClaude(request, currentFiles) {
  const prompt = buildPrompt(request, currentFiles);
  const { stdout } = await execFileAsync(
    "claude",
    ["-p", prompt, "--output-format", "json"],
    { maxBuffer: 10 * 1024 * 1024 },
  );

  const outer = JSON.parse(stdout);
  if (outer.is_error || (outer.subtype && outer.subtype !== "success")) {
    throw new Error(`claude -p did not succeed: ${outer.subtype ?? "is_error=true"}`);
  }
  const resultText = outer.result;
  if (!resultText) {
    throw new Error("claude -p response did not include a result field.");
  }

  const parsed = JSON.parse(extractJson(resultText));
  if (!parsed.files || typeof parsed.files !== "object") {
    throw new Error("claude -p response JSON did not include a files object.");
  }
  return parsed.files;
}
