/**
 * Real OpenAI backend. Uses the Responses API (api.openai.com/v1/responses)
 * with a JSON-schema structured output so the model's reply is guaranteed
 * to parse -- no free-text extraction. Requires OPENAI_API_KEY in the
 * environment; never logs the key, never writes it to a file.
 *
 * The model name below (DEFAULT_MODEL) is a fast-moving target external to
 * this codebase. If this backend starts failing with a "model not found"
 * style error, check https://platform.openai.com/docs/models for the
 * current recommended general-purpose model and update the constant --
 * this is the one place that name is declared.
 */
import { ALLOWED_EDIT_PATHS } from "./config.mjs";

const DEFAULT_MODEL = "gpt-5.6";
const RESPONSES_ENDPOINT = "https://api.openai.com/v1/responses";

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    files: {
      type: "array",
      description:
        "One entry per file that needs to change. Only include a file that actually needs to change.",
      items: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "The relative file path, exactly one of the allowed paths.",
          },
          content: {
            type: "string",
            description: "The file's COMPLETE new content.",
          },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
  },
  required: ["files"],
  additionalProperties: false,
};

function systemPrompt() {
  return [
    "You edit exactly two ZMK firmware configuration files for a security-reviewed personal keyboard build (eyelash Corne, OLED lineage).",
    `You may propose new content ONLY for these paths: ${ALLOWED_EDIT_PATHS.join(", ")}.`,
    "Never propose a change to any other path, including boards/, build.yaml, or config/west.yml -- those are permanently out of scope regardless of what is asked.",
    "For every file you change, return its COMPLETE new content, not a diff or a partial excerpt.",
    "Only include a key in `files` for a file that actually needs to change; leave the other one out entirely if it doesn't.",
    "Preserve everything in each file you are not deliberately changing -- comments, formatting, and unrelated settings.",
  ].join(" ");
}

export async function callOpenAI(request, currentFiles) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set in the environment.");
  }

  const userPrompt = [
    `Requested change: ${request}`,
    "",
    "Current file contents:",
    ...Object.entries(currentFiles).map(
      ([relativePath, content]) => `--- ${relativePath} ---\n${content}`,
    ),
  ].join("\n");

  const response = await fetch(RESPONSES_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      input: [
        { role: "system", content: systemPrompt() },
        { role: "user", content: userPrompt },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "firmware_edit",
          schema: RESPONSE_SCHEMA,
          strict: true,
        },
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI API request failed (${response.status}): ${body}`);
  }

  const payload = await response.json();
  const messageItem = payload.output?.find((item) => item.type === "message");
  const refusalItem = messageItem?.content?.find((item) => item.type === "refusal");
  if (refusalItem) {
    throw new Error(`OpenAI refused the request: ${refusalItem.refusal}`);
  }

  const textItem = messageItem?.content?.find((item) => item.type === "output_text");
  const outputText = textItem?.text;
  if (!outputText) {
    throw new Error("OpenAI API response did not include the expected output text.");
  }

  const parsed = JSON.parse(outputText);
  return Object.fromEntries(parsed.files.map((file) => [file.path, file.content]));
}
