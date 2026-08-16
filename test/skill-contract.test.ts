import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const SRC_DIR = join(process.cwd(), "plugins/opencode-plugin-codex/src");
const SKILL_DIR = join(process.cwd(), "plugins/opencode-plugin-codex/skills/opencode");

/**
 * Words that read like identifiers in prose but name nothing in the code.
 * Everything else in backticks has to exist, which is the point of the check.
 */
const PROSE_TOKENS = new Set([
  "opencode",
  "codex",
  "codex-opencode-collaboration",
  "npm",
  "node",
  "test/skill-contract.test.ts",
  "AGENTS.md",
  "CLAUDE.md",
  "SKILL.md"
]);

async function readSourceText(): Promise<string> {
  const files = await readdir(SRC_DIR);
  const contents = await Promise.all(
    files.filter((file) => file.endsWith(".ts")).map((file) => readFile(join(SRC_DIR, file), "utf8"))
  );
  return contents.join("\n");
}

async function readSkillTexts(): Promise<{ path: string; text: string }[]> {
  const referenceDir = join(SKILL_DIR, "references");
  const references = await readdir(referenceDir);
  return await Promise.all(
    [join(SKILL_DIR, "SKILL.md"), ...references.map((file) => join(referenceDir, file))].map(async (path) => ({
      path,
      text: await readFile(path, "utf8")
    }))
  );
}

/** Backticked tokens that look like a code identifier or a dotted field path. */
function identifierTokens(markdown: string): string[] {
  const tokens = new Set<string>();
  for (const match of markdown.matchAll(/`([^`\n]+)`/g)) {
    const raw = match[1].trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(raw)) continue;
    if (PROSE_TOKENS.has(raw)) continue;
    for (const part of raw.split(".")) {
      if (part.length >= 4 && !PROSE_TOKENS.has(part)) tokens.add(part);
    }
  }
  return [...tokens];
}

describe("the shipped Skill cannot drift away from the code", () => {
  test("every error code and result field it names exists in src", async () => {
    // The previous release declared an out-of-repo Skill as its orchestration
    // authority with nothing checking the two against each other; that is the
    // mechanism behind the timeout dogma, and it would bite the new error codes,
    // the `view` parameter and the typed envelope in exactly the same way.
    const source = await readSourceText();

    for (const { path, text } of await readSkillTexts()) {
      for (const token of identifierTokens(text)) {
        expect(source.includes(token), `${path} names \`${token}\`, which no longer exists in src/`).toBe(true);
      }
    }
  });

  test("the vendored failure routing reference ships with the plugin", async () => {
    const references = await readdir(join(SKILL_DIR, "references"));

    expect(references).toContain("failure-routing.md");
  });

  test("it names every failure class the code can produce", async () => {
    const routing = await readFile(join(SKILL_DIR, "references/failure-routing.md"), "utf8");
    const errorClasses = [
      "timeout",
      "stalled",
      "quota_exhausted",
      "auth_required",
      "model_unauthorized",
      "model_not_found",
      "rate_limited",
      "network_error",
      "terminated",
      "opencode_failed",
      "worker_unavailable",
      "spawn_error",
      "stdin_error",
      "unknown",
      "cancelled"
    ];
    const boundaryCodes = [
      "workspace_unavailable",
      "workspace_out_of_bounds",
      "file_attachment_invalid",
      "private_path_blocked",
      "rollout_invalid",
      "state_write_failed",
      "cli_not_found",
      "cli_probe_timeout"
    ];

    for (const code of [...errorClasses, ...boundaryCodes]) {
      expect(routing, code).toContain(code);
    }
  });
});
