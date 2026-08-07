/**
 * Lightweight, dependency-free sanity checks run on LLM-proposed file
 * content before it is ever shown to the owner as "ready to apply." These
 * are NOT a devicetree/Kconfig parser -- they catch obviously broken or
 * truncated output cheaply. The real correctness gate is the actual ZMK/
 * Zephyr build in CI; these checks only avoid wasting a build (or worse,
 * committing garbage) on output that's clearly malformed.
 */
function countChar(content, char) {
  let count = 0;
  for (const ch of content) if (ch === char) count += 1;
  return count;
}

export function checkKeymapStructure(content) {
  if (content.trim().length === 0) {
    return { ok: false, reason: "File content is empty." };
  }
  const openBraces = countChar(content, "{");
  const closeBraces = countChar(content, "}");
  if (openBraces !== closeBraces) {
    return {
      ok: false,
      reason: `Unbalanced curly braces: ${openBraces} "{" vs ${closeBraces} "}".`,
    };
  }
  const openAngles = countChar(content, "<");
  const closeAngles = countChar(content, ">");
  if (openAngles !== closeAngles) {
    return {
      ok: false,
      reason: `Unbalanced angle brackets: ${openAngles} "<" vs ${closeAngles} ">".`,
    };
  }
  const openParens = countChar(content, "(");
  const closeParens = countChar(content, ")");
  if (openParens !== closeParens) {
    return {
      ok: false,
      reason: `Unbalanced parentheses: ${openParens} "(" vs ${closeParens} ")".`,
    };
  }
  return { ok: true, reason: null };
}

const CONF_LINE_PATTERN = /^[A-Za-z0-9_]+=.*$/;

export function checkConfStructure(content) {
  if (content.trim().length === 0) {
    return { ok: false, reason: "File content is empty." };
  }
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "" || line.startsWith("#")) continue;
    if (!CONF_LINE_PATTERN.test(line)) {
      return {
        ok: false,
        reason: `Line ${i + 1} is not a comment, blank line, or KEY=value setting: "${lines[i]}"`,
      };
    }
  }
  return { ok: true, reason: null };
}

export function checkStructureForPath(relativePath, content) {
  if (relativePath.endsWith(".keymap")) return checkKeymapStructure(content);
  if (relativePath.endsWith(".conf")) return checkConfStructure(content);
  return {
    ok: false,
    reason: `Unrecognized file extension for structural check: ${relativePath}`,
  };
}

function parseLiveConfLines(content) {
  const lines = new Set();
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    lines.add(line);
  }
  return lines;
}

/**
 * Returns the proposed .conf lines that (a) match a security-sensitive
 * prefix and (b) are not already present verbatim (same key AND same
 * value) in the current content. This catches both a brand-new sensitive
 * key and a changed value for an already-present sensitive key -- it
 * does NOT flag a sensitive line that's unchanged from the current file.
 */
export function findNewSecuritySensitiveConfLines(currentContent, proposedContent, prefixes) {
  const currentLines = parseLiveConfLines(currentContent);
  const flagged = [];
  for (const rawLine of proposedContent.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    if (currentLines.has(line)) continue;
    const key = line.slice(0, eq);
    if (prefixes.some((prefix) => key.startsWith(prefix))) {
      flagged.push(line);
    }
  }
  return flagged;
}
