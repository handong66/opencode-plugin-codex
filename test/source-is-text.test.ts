import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

// src/model-guard.ts shipped with a raw U+0000 inside a template literal (the probe
// cache-key separator). Git classifies any blob containing a NUL byte as binary, so
// that whole module rendered as "Binary files ... differ": review, `git log -p`,
// `git blame -L`, patch export/apply and `git diff --check` were all blind on it, and
// any tool that normalises control characters could have silently changed a cache key.
// Control bytes belong in escapes, never as literal bytes in a text source.

const repoRoot = process.cwd();
const SCANNED_DIRS = [
  "plugins/opencode-plugin-codex/src",
  "plugins/opencode-plugin-codex/dist",
  "plugins/opencode-plugin-codex/skills",
  "plugins/opencode-plugin-codex/.codex-plugin",
  "test",
  "scripts",
  "docs",
  ".github"
];
const SCANNED_ROOT_FILES = ["README.md", "CHANGELOG.md", "package.json", "tsconfig.json"];
const TEXT_EXTENSIONS = [".ts", ".mjs", ".js", ".json", ".md", ".yml", ".yaml"];

function collect(dir: string, into: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // an optional directory (dist before a build) is not a failure here
  }
  for (const entry of entries) {
    if (entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collect(full, into);
    } else if (TEXT_EXTENSIONS.some((ext) => entry.endsWith(ext))) {
      into.push(full);
    }
  }
}

function scannedFiles(): string[] {
  const files: string[] = [];
  for (const dir of SCANNED_DIRS) collect(join(repoRoot, dir), files);
  for (const file of SCANNED_ROOT_FILES) files.push(join(repoRoot, file));
  return files;
}

describe("tracked text sources stay text", () => {
  test("the scan actually covers the module that regressed", () => {
    const files = scannedFiles();
    expect(files.length).toBeGreaterThan(30);
    expect(files.some((file) => file.endsWith("src/model-guard.ts"))).toBe(true);
  });

  test("no source, doc or build artifact contains a NUL byte", () => {
    const binary = scannedFiles().filter((file) => readFileSync(file).includes(0));
    // Naming the offenders matters more than the count: the failure is invisible in a diff.
    expect(binary.map((file) => file.slice(repoRoot.length + 1))).toEqual([]);
  });
});
