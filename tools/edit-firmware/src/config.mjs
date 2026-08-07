/**
 * Shared constants for the guarded firmware edit tool. Every other module
 * imports paths and limits from here rather than re-declaring them, so
 * there is exactly one place that defines "what this tool is allowed to
 * touch."
 */
export const ALLOWED_EDIT_PATHS = [
  "config/eyelash_corne.keymap",
  "config/eyelash_corne.conf",
];

/**
 * Prefixes of Kconfig keys treated as security-sensitive: a proposed
 * `.conf` change touching one of these gets a loud warning and a stronger
 * confirmation phrase before it can be applied (see
 * findNewSecuritySensitiveConfLines in structural-check.mjs). This is a
 * starting point, not an exhaustive enumeration of every ZMK/Zephyr Kconfig
 * symbol -- broad category prefixes are the point, and false positives here
 * are harmless since this is a warning, not a block.
 */
export const SECURITY_SENSITIVE_CONF_PREFIXES = [
  "CONFIG_ZMK_USB_LOGGING",
  "CONFIG_LOG",
  "CONFIG_SHELL",
  "CONFIG_BT_",
  "CONFIG_ZMK_BLE_",
  "CONFIG_ZMK_USB_",
];

export const RELEASES_DIR = "tools/edit-firmware/releases";
export const RELEASE_RETENTION_COUNT = 10;
export const LOCK_FILE_PATH = "tools/edit-firmware/.edit-firmware.lock";
export const DEFAULT_LLM_BACKEND = "openai";
export const BACKUP_TAG_PREFIX = "backup/";
export const BUILD_WORKFLOW_FILE = "build.yml";
