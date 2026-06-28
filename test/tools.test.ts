import { describe, expect, test } from "vitest";
import { opencodeRun } from "../plugins/opencode-plugin-codex/src/tools.js";

function parseToolResult(result: Awaited<ReturnType<typeof opencodeRun>>) {
  return JSON.parse(result.content[0].text) as {
    ok: boolean;
    exitCode?: number | null;
    stdout?: string;
  };
}

describe("opencodeRun", () => {
  test("passes long prompt text as the run message instead of a file path", async () => {
    const prompt = `LONG_PROMPT_${"x".repeat(5_000)}`;

    const result = parseToolResult(
      await opencodeRun({
        opencodeBin: "/bin/echo",
        cwd: process.cwd(),
        background: false,
        prompt
      })
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain(prompt);
    expect(result.stdout).not.toContain("--file");
  });

  test("keeps explicit file attachments on the --file channel", async () => {
    const result = parseToolResult(
      await opencodeRun({
        opencodeBin: "/bin/echo",
        cwd: process.cwd(),
        background: false,
        prompt: "review this file",
        files: ["README.md"]
      })
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("--file README.md review this file");
  });

  test("rejects prompt-like text passed through files before OpenCode treats it as a path", async () => {
    const promptLikeFile = [
      "Review the implementation below and find the bug.",
      "",
      "This is not a filesystem path; it is task text that belongs in prompt.",
      "x".repeat(300)
    ].join("\n");

    await expect(
      opencodeRun({
        opencodeBin: "/bin/echo",
        cwd: process.cwd(),
        background: false,
        prompt: "review this",
        files: [promptLikeFile]
      })
    ).rejects.toThrow(/files.*filesystem paths.*prompt/i);
  });
});
