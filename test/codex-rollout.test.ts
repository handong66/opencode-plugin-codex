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

  test("prefers current visible event messages over injected response items", () => {
    const fixture = readFileSync("test/fixtures/codex-rollout-current-visible.jsonl", "utf8");

    expect(parseCodexRolloutJsonl(fixture)).toEqual([
      { role: "user", text: "Visible user request" },
      { role: "assistant", text: "Visible assistant response" }
    ]);
  });
});
