import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ALLOWED_EDIT_PATHS,
  RELEASES_DIR,
  RELEASE_RETENTION_COUNT,
  LOCK_FILE_PATH,
  DEFAULT_LLM_BACKEND,
  BACKUP_TAG_PREFIX,
} from "../config.mjs";

test("ALLOWED_EDIT_PATHS is exactly the two editable config files", () => {
  assert.deepEqual(ALLOWED_EDIT_PATHS, [
    "config/eyelash_corne.keymap",
    "config/eyelash_corne.conf",
  ]);
});

test("ALLOWED_EDIT_PATHS never contains boards/, build.yaml, or west.yml", () => {
  for (const path of ALLOWED_EDIT_PATHS) {
    assert.ok(!path.startsWith("boards/"), `${path} must not be under boards/`);
    assert.notEqual(path, "build.yaml");
    assert.notEqual(path, "config/west.yml");
  }
});

test("retention and defaults are sane", () => {
  assert.equal(RELEASE_RETENTION_COUNT, 10);
  assert.equal(DEFAULT_LLM_BACKEND, "openai");
  assert.equal(BACKUP_TAG_PREFIX, "backup/");
  assert.ok(RELEASES_DIR.includes("releases"));
  assert.ok(LOCK_FILE_PATH.includes(".edit-firmware.lock"));
});
