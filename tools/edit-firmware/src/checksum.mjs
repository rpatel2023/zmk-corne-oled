/**
 * Checksum and basic UF2-shape verification for downloaded firmware
 * artifacts. The UF2 check is deliberately shallow (magic number + block
 * alignment) -- it exists only to catch an obviously corrupt or truncated
 * download before it's staged as a release, not to fully validate firmware
 * contents.
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

const UF2_MAGIC_START_0 = 0x0a324655;
const UF2_BLOCK_SIZE = 512;

export function sha256File(filePath) {
  const content = readFileSync(filePath);
  return createHash("sha256").update(content).digest("hex");
}

export function looksLikeUf2(filePath) {
  const size = statSync(filePath).size;
  if (size === 0 || size % UF2_BLOCK_SIZE !== 0) return false;
  const handle = readFileSync(filePath);
  const magic = handle.readUInt32LE(0);
  return magic === UF2_MAGIC_START_0;
}
