# Guarded Firmware Edit Tool

Turns a plain-language keymap change request into a reviewed, committed,
built, checksummed, and GitHub-Released firmware artifact for this
repository. Ported 2026-08-07 from `rpatel2023/zmk-corne-hardened`; design doc:
`zmk-corne-hardened:docs/superpowers/specs/2026-08-05-guarded-firmware-edit-tool-design.md`.

## Prerequisites

- `git` and the `gh` CLI, authenticated (`gh auth status`).
- Either `OPENAI_API_KEY` in your environment (default backend), or Claude
  Code installed and authenticated (`--backend claude`, or automatic
  fallback if the OpenAI call fails).

## Usage

```bash
cd tools/edit-firmware
node src/edit-firmware.mjs "make the triple-tap on td_esc_nav toggle the numbers layer"
```

You'll see the proposed diff and a `[y/N]` prompt. Nothing is written,
committed, or built until you type `y`.

On success you'll get a release folder with checksummed `.uf2` files and
flashing instructions. **Flashing itself is always manual** — this tool
never touches the physical keyboard.

## What this tool will never touch

`boards/` (hardware definitions), root `build.yaml` (build matrix —
this is where `CONFIG_ZMK_STUDIO_LOCKING` lives), and `config/west.yml`
(the pinned dependency manifest). Only `config/eyelash_corne.keymap` and
`config/eyelash_corne.conf` are ever proposed for change.

## Rollback

```bash
node src/rollback.mjs --list
node src/rollback.mjs --to <backup-tag>
```

Restores the two editable files to a prior backup point as a new commit
(never rewrites history, never force-pushes) and points you at that
backup's already-built firmware if one was retained locally.

## Security warning on sensitive .conf changes

Before showing the `[y/N]` prompt, the tool compares the proposed
`config/eyelash_corne.conf` content against the current file. If a new or
changed line's key matches a security-relevant prefix (the list lives in
`SECURITY_SENSITIVE_CONF_PREFIXES` in `src/config.mjs` — things like
`CONFIG_BT_`, `CONFIG_ZMK_BLE_`, `CONFIG_ZMK_USB_`, `CONFIG_LOG`, and
`CONFIG_SHELL`), it prints a warning listing the flagged lines and
requires typing `yes-security` instead of `y` to proceed. A sensitive
line that's unchanged from the current file is not flagged — only a
brand-new key, or an existing key with a changed value, trips it.

This is not a correctness or semantic check, and it is not a hard block —
it's a visibility aid on top of the same manual diff review that gates
every change. Typing `yes-security` applies the change exactly as typing
`y` would for a non-flagged one; there is no scenario where this feature
refuses to let an approved change through.

## Tests

```bash
npm test
```

Runs the automated suite (pure logic: validation, checksums, release
staging, rollback git mechanics). The real OpenAI/`claude -p` calls and
real `gh` orchestration are intentionally not part of this suite — see
"Manually verified" tasks in the implementation plan for why, and how
they were verified.
