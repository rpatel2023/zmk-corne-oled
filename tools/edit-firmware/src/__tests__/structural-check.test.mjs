import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkKeymapStructure,
  checkConfStructure,
  checkStructureForPath,
  findNewSecuritySensitiveConfLines,
} from "../structural-check.mjs";

const SENSITIVE_PREFIXES = ["CONFIG_BT_", "CONFIG_ZMK_BLE_", "CONFIG_ZMK_USB_", "CONFIG_LOG", "CONFIG_SHELL"];

test("checkKeymapStructure accepts balanced braces and angle brackets", () => {
  const content = `
/ {
    keymap {
        compatible = "zmk,keymap";
        default_layer {
            bindings = <&kp A &kp B>;
        };
    };
};
`;
  assert.deepEqual(checkKeymapStructure(content), { ok: true, reason: null });
});

test("checkKeymapStructure rejects unbalanced braces", () => {
  const content = "/ { keymap { bindings = <&kp A>; };";
  const result = checkKeymapStructure(content);
  assert.equal(result.ok, false);
  assert.match(result.reason, /brace/i);
});

test("checkKeymapStructure rejects unbalanced angle brackets", () => {
  const content = "/ { keymap { bindings = <&kp A; }; };";
  const result = checkKeymapStructure(content);
  assert.equal(result.ok, false);
  assert.match(result.reason, /angle bracket/i);
});

test("checkKeymapStructure rejects empty content", () => {
  const result = checkKeymapStructure("");
  assert.equal(result.ok, false);
  assert.match(result.reason, /empty/i);
});

test("checkConfStructure accepts KEY=value lines, blank lines, and comments", () => {
  const content = [
    "# a comment",
    "",
    "CONFIG_ZMK_SLEEP=y",
    "CONFIG_ZMK_IDLE_SLEEP_TIMEOUT=3600000",
    "",
  ].join("\n");
  assert.deepEqual(checkConfStructure(content), { ok: true, reason: null });
});

test("checkConfStructure rejects a line that isn't a comment, blank, or KEY=value", () => {
  const content = "CONFIG_ZMK_SLEEP=y\nthis is not a config line\n";
  const result = checkConfStructure(content);
  assert.equal(result.ok, false);
  assert.match(result.reason, /line 2/i);
});

test("checkConfStructure rejects empty content", () => {
  const result = checkConfStructure("");
  assert.equal(result.ok, false);
  assert.match(result.reason, /empty/i);
});

test("checkStructureForPath dispatches by extension", () => {
  assert.equal(
    checkStructureForPath("config/eyelash_corne.conf", "CONFIG_ZMK_SLEEP=y\n").ok,
    true,
  );
  assert.equal(
    checkStructureForPath("config/eyelash_corne.keymap", "/ {};").ok,
    true,
  );
});

test("checkStructureForPath rejects an unrecognized extension defensively", () => {
  const result = checkStructureForPath("config/eyelash_corne.json", "{}");
  assert.equal(result.ok, false);
  assert.match(result.reason, /unrecognized/i);
});

test("findNewSecuritySensitiveConfLines flags a brand-new key matching a sensitive prefix", () => {
  const current = "CONFIG_ZMK_SLEEP=y\n";
  const proposed = "CONFIG_ZMK_SLEEP=y\nCONFIG_BT_CTLR_TX_PWR_PLUS_8=y\n";
  const flagged = findNewSecuritySensitiveConfLines(current, proposed, SENSITIVE_PREFIXES);
  assert.deepEqual(flagged, ["CONFIG_BT_CTLR_TX_PWR_PLUS_8=y"]);
});

test("findNewSecuritySensitiveConfLines flags a changed value for an already-present sensitive key", () => {
  const current = "CONFIG_ZMK_USB_LOGGING=n\n";
  const proposed = "CONFIG_ZMK_USB_LOGGING=y\n";
  const flagged = findNewSecuritySensitiveConfLines(current, proposed, SENSITIVE_PREFIXES);
  assert.deepEqual(flagged, ["CONFIG_ZMK_USB_LOGGING=y"]);
});

test("findNewSecuritySensitiveConfLines does not flag a sensitive line unchanged from current content", () => {
  const current = "CONFIG_LOG=y\nCONFIG_ZMK_SLEEP=y\n";
  const proposed = "CONFIG_LOG=y\nCONFIG_ZMK_SLEEP=n\n";
  const flagged = findNewSecuritySensitiveConfLines(current, proposed, SENSITIVE_PREFIXES);
  assert.deepEqual(flagged, [], "the unchanged CONFIG_LOG=y line must not be flagged");
});

test("findNewSecuritySensitiveConfLines does not flag a new key that matches no sensitive prefix", () => {
  const current = "CONFIG_ZMK_SLEEP=y\n";
  const proposed = "CONFIG_ZMK_SLEEP=y\nCONFIG_ZMK_IDLE_SLEEP_TIMEOUT=3600000\n";
  const flagged = findNewSecuritySensitiveConfLines(current, proposed, SENSITIVE_PREFIXES);
  assert.deepEqual(flagged, []);
});

test("findNewSecuritySensitiveConfLines ignores comments and blank lines in either input", () => {
  const current = ["# CONFIG_BT_CTLR_TX_PWR_PLUS_8=y", "", "CONFIG_ZMK_SLEEP=y"].join("\n");
  const proposed = [
    "# a new comment mentioning CONFIG_BT_ should not count",
    "",
    "CONFIG_ZMK_SLEEP=y",
    "   ",
    "CONFIG_BT_CTLR_TX_PWR_PLUS_8=y",
  ].join("\n");
  const flagged = findNewSecuritySensitiveConfLines(current, proposed, SENSITIVE_PREFIXES);
  assert.deepEqual(
    flagged,
    ["CONFIG_BT_CTLR_TX_PWR_PLUS_8=y"],
    "the commented-out current line must not count as already-present, and blank/comment proposed lines must not become candidates",
  );
});
