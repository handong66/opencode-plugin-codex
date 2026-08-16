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

  test("no shipped document still demands an explicit model", async () => {
    // The identifier check above cannot see prose, and prose is what Codex reads.
    // OX8 made `model` optional everywhere (server.ts hands opencode_transfer the same
    // optional commonShape.model, and only an unreadable configuration refuses), but the
    // Skill kept the 0.1-era sentence "requires an explicit authorized model" — inside the
    // same file that says `model` is optional two paragraphs earlier. A stale claim here
    // re-creates the pressure toward unverified explicit models that OC-7 exists to remove.
    const documents = [
      join(SKILL_DIR, "SKILL.md"),
      join(SKILL_DIR, "references/failure-routing.md"),
      join(process.cwd(), "README.md"),
      join(process.cwd(), "plugins/opencode-plugin-codex/README.md"),
      join(process.cwd(), "docs/development.md")
    ];
    // Deliberately narrow: "a continuation requires a previously verified model" is the
    // correct, surviving sentence. What must not come back is a claim that some tool
    // demands an explicit model before it will run.
    const demandsAModel =
      /(?:requires?|needs?|must (?:pass|use|supply|provide))\s+an?\s+explicit[^.\n]{0,40}\bmodel\b|\bmodel`?\s+is\s+required\b/i;

    for (const path of documents) {
      const text = await readFile(path, "utf8");
      const offender = text.split("\n").find((line) => demandsAModel.test(line));
      expect(offender, `${path} still demands an explicit model: ${offender ?? ""}`).toBeUndefined();
    }
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
