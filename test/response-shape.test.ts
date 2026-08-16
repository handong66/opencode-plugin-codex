import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { JobStore } from "../plugins/opencode-plugin-codex/src/job-store.js";
import { opencodeResult, opencodeStatus } from "../plugins/opencode-plugin-codex/src/tools.js";

async function withJob<T>(stdout: string, run: (jobId: string) => Promise<T>): Promise<T> {
  const stateDir = await mkdtemp(join(process.cwd(), ".opencode-plugin-codex-shape-"));
  const previous = process.env.OPENCODE_PLUGIN_STATE_DIR;
  try {
    process.env.OPENCODE_PLUGIN_STATE_DIR = stateDir;
    const store = new JobStore(stateDir);
    const jobId = "job_response_shape";
    await store.ensure();
    await writeFile(store.stdoutPath(jobId), stdout);
    await writeFile(store.stderrPath(jobId), "");
    await store.write({
      id: jobId,
      kind: "run",
      status: "succeeded",
      cwd: process.cwd(),
      command: "opencode",
      args: [],
      createdAt: "2026-08-15T00:00:00.000Z",
      timeoutMs: 600_000,
      exitCode: 0,
      stdoutPath: store.stdoutPath(jobId),
      stderrPath: store.stderrPath(jobId)
    });
    return await run(jobId);
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_PLUGIN_STATE_DIR;
    else process.env.OPENCODE_PLUGIN_STATE_DIR = previous;
    await rm(stateDir, { recursive: true, force: true });
  }
}

describe("response payload duplication", () => {
  test("stops pretty-printing every response", async () => {
    await withJob("", async (jobId) => {
      const response = await opencodeStatus({ jobId });
      const text = response.content[0].text;

      expect(text).not.toContain("\n");
      expect(JSON.parse(text)).toEqual(response.structuredContent);
    });
  });

  test("sends a large payload once, as structuredContent", async () => {
    // 195M characters of the audit window's context pressure was this duplication;
    // the largest single opencode_result payload was 265,570 characters.
    const stdout = `${JSON.stringify({ type: "step_start", sessionID: "ses_big" })}\n${"x".repeat(30_000)}`;

    await withJob(stdout, async (jobId) => {
      const response = await opencodeResult({ jobId, maxChars: 30_000 });
      const text = response.content[0].text;
      const summary = JSON.parse(text) as {
        ok?: boolean;
        structuredContentOnly?: boolean;
        payloadChars?: number;
      };
      const structured = response.structuredContent as { data?: { stdout?: string } };

      expect(summary.structuredContentOnly).toBe(true);
      expect(summary.ok).toBe(true);
      expect(summary.payloadChars).toBeGreaterThan(8_192);
      expect(text.length).toBeLessThan(500);
      // The full payload is still there, exactly once — in data, since 0.2.0.
      expect(structured.data?.stdout).toContain("x".repeat(1_000));
    });
  });

  // The two live smoke scripts are named as pre-release gates in the plugin README
  // but run neither under `npm test` nor under `npm run check`, so nothing else in
  // the suite notices when they drift back to reading `content[0].text` — where a
  // real payload is now only the `structuredContentOnly` pointer.
  test.each(["scripts/smoke-background.mjs", "scripts/live-transfer-smoke.mjs"])(
    "%s reads the payload from structuredContent",
    async (script) => {
      const source = await readFile(join(process.cwd(), script), "utf8");

      expect(source).toContain("result.structuredContent");
      expect(source).not.toMatch(/JSON\.parse\(\s*firstText/);
      expect(source).not.toMatch(/content\?\.\[0\]\?\.text|content\?\.find\(/);
    }
  );
});
