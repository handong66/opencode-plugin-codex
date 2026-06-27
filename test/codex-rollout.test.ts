import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { parseCodexRolloutJsonl } from "../plugins/opencode-plugin-codex/src/codex-rollout.js";

describe("parseCodexRolloutJsonl", () => {
  test("extracts visible user and assistant messages while filtering developer and tool output", () => {
    const jsonl = readFileSync("test/fixtures/codex-rollout-minimal.jsonl", "utf8");

    const transcript = parseCodexRolloutJsonl(jsonl);

    expect(transcript).toEqual([
      { role: "user", text: "Build the plugin." },
      { role: "assistant", text: "I will inspect the repository." },
      { role: "user", text: "Continue in OpenCode." }
    ]);
  });
});
