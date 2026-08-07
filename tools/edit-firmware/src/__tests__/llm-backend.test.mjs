import { test } from "node:test";
import assert from "node:assert/strict";
import { proposeEdit } from "../llm-backend.mjs";

const CURRENT_FILES = {
  "config/eyelash_corne.keymap": "/ { v = <1>; };\n",
  "config/eyelash_corne.conf": "CONFIG_ZMK_SLEEP=y\n",
};

test("proposeEdit calls the OpenAI backend by default and returns its result", async () => {
  let receivedRequest = null;
  const fakeOpenAI = async (request, files) => {
    receivedRequest = { request, files };
    return { "config/eyelash_corne.keymap": "/ { v = <2>; };\n" };
  };
  const fakeClaude = async () => {
    throw new Error("should not be called");
  };

  const result = await proposeEdit("bump v to 2", CURRENT_FILES, {
    callOpenAI: fakeOpenAI,
    callClaude: fakeClaude,
  });

  assert.equal(result.backend, "openai");
  assert.deepEqual(result.files, { "config/eyelash_corne.keymap": "/ { v = <2>; };\n" });
  assert.equal(receivedRequest.request, "bump v to 2");
  assert.deepEqual(receivedRequest.files, CURRENT_FILES);
});

test("proposeEdit falls back to claude when the OpenAI call throws", async () => {
  const fakeOpenAI = async () => {
    throw new Error("no API key configured");
  };
  const fakeClaude = async () => ({
    "config/eyelash_corne.conf": "CONFIG_ZMK_SLEEP=n\n",
  });

  const result = await proposeEdit("disable sleep", CURRENT_FILES, {
    callOpenAI: fakeOpenAI,
    callClaude: fakeClaude,
  });

  assert.equal(result.backend, "claude");
  assert.deepEqual(result.files, { "config/eyelash_corne.conf": "CONFIG_ZMK_SLEEP=n\n" });
});

test("proposeEdit uses claude directly when --backend claude is requested, never calling OpenAI", async () => {
  const fakeOpenAI = async () => {
    throw new Error("should not be called");
  };
  const fakeClaude = async () => ({ "config/eyelash_corne.conf": "CONFIG_ZMK_SLEEP=n\n" });

  const result = await proposeEdit("disable sleep", CURRENT_FILES, {
    backend: "claude",
    callOpenAI: fakeOpenAI,
    callClaude: fakeClaude,
  });

  assert.equal(result.backend, "claude");
});

test("proposeEdit throws a clear error when both backends fail", async () => {
  const fakeOpenAI = async () => {
    throw new Error("openai down");
  };
  const fakeClaude = async () => {
    throw new Error("claude down");
  };

  await assert.rejects(
    () => proposeEdit("anything", CURRENT_FILES, { callOpenAI: fakeOpenAI, callClaude: fakeClaude }),
    /openai down.*claude down|claude down.*openai down/s,
  );
});
