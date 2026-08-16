import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { opencodeRun } from "../plugins/opencode-plugin-codex/src/tools.js";

const dirs: string[] = [];
let previousBin: string | undefined;

afterEach(async () => {
  if (previousBin === undefined) delete process.env.OPENCODE_BIN;
  else process.env.OPENCODE_BIN = previousBin;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A foreground run whose answer is buried under a very large stream. */
async function verboseOpenCode(streamChars: number): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "opencode-plugin-codex-verbose-"));
  dirs.push(dir);
  const bin = join(dir, "verbose-opencode.mjs");
  await writeFile(
    bin,
    [
      "#!/usr/bin/env node",
      "if (process.argv[2] === '--version') { console.log('1.18.16'); process.exit(0); }",
      "process.stdin.resume();",
      "process.stdin.on('data', () => undefined);",
      "process.stdin.on('end', () => {",
      "  console.log(JSON.stringify({ type: 'step_start', sessionID: 'ses_verbose' }));",
      `  console.log(JSON.stringify({ type: 'tool_use', sessionID: 'ses_verbose', part: { type: 'tool', tool: 'read', state: { input: { filePath: '/repo/huge.bin' }, output: 'z'.repeat(${streamChars}) } } }));`,
      "  console.log(JSON.stringify({ type: 'text', sessionID: 'ses_verbose', part: { type: 'text', text: 'Findings: the answer survives truncation.' } }));",
      "  console.log(JSON.stringify({ type: 'step_finish', sessionID: 'ses_verbose', part: { type: 'step-finish', reason: 'stop' } }));",
      // No process.exit(): it would drop the pending pipe writes and truncate the
      // stream at the source rather than at the boundary under test.
      "});"
    ].join("\n")
  );
  await chmod(bin, 0o755);
  previousBin = process.env.OPENCODE_BIN;
  process.env.OPENCODE_BIN = bin;
}

describe("foreground response bounds", () => {
  test("returns a bounded tail and says it truncated", async () => {
    // The foreground path used to return up to 1,000,000 characters per stream while
    // a background job returned 20,000; the largest measured payload was 1,341,598.
    await verboseOpenCode(300_000);

    const result = (
      await opencodeRun({ cwd: process.cwd(), background: false, prompt: "verbose probe" })
    ).structuredContent as {
      stdout?: string;
      stdoutTruncated?: boolean;
      outputSummary?: { resultComplete: boolean; finalText?: string };
    };

    expect(result.stdout).toHaveLength(20_000);
    expect(result.stdoutTruncated).toBe(true);
    // Diagnosis is unaffected: the summary still reads the complete buffer.
    expect(result.outputSummary?.resultComplete).toBe(true);
    expect(result.outputSummary?.finalText).toBe("Findings: the answer survives truncation.");
  }, 20_000);

  test("leaves a small response whole", async () => {
    await verboseOpenCode(10);

    const result = (
      await opencodeRun({ cwd: process.cwd(), background: false, prompt: "small probe" })
    ).structuredContent as { stdout?: string; stdoutTruncated?: boolean };

    expect(result.stdoutTruncated).toBe(false);
    expect(result.stdout).toContain("step_finish");
  }, 20_000);
});
