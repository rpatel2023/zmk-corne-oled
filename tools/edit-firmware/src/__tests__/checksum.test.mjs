import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sha256File, looksLikeUf2 } from "../checksum.mjs";

test("sha256File matches a hash computed independently", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "checksum-test-"));
  try {
    const filePath = path.join(dir, "sample.bin");
    const content = Buffer.from("hello firmware");
    writeFileSync(filePath, content);
    const expected = createHash("sha256").update(content).digest("hex");
    assert.equal(sha256File(filePath), expected);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("looksLikeUf2 accepts a file with the correct magic number and block size", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "checksum-test-"));
  try {
    const filePath = path.join(dir, "firmware.uf2");
    const block = Buffer.alloc(512);
    block.writeUInt32LE(0x0a324655, 0); // UF2 MagicStart0
    writeFileSync(filePath, block);
    assert.equal(looksLikeUf2(filePath), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("looksLikeUf2 rejects a file with the wrong magic number", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "checksum-test-"));
  try {
    const filePath = path.join(dir, "not-firmware.bin");
    writeFileSync(filePath, Buffer.alloc(512));
    assert.equal(looksLikeUf2(filePath), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("looksLikeUf2 rejects a file that isn't a multiple of the 512-byte block size", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "checksum-test-"));
  try {
    const filePath = path.join(dir, "truncated.uf2");
    const block = Buffer.alloc(300);
    block.writeUInt32LE(0x0a324655, 0);
    writeFileSync(filePath, block);
    assert.equal(looksLikeUf2(filePath), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
