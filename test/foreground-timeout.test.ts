import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { opencodeRun } from "../plugins/opencode-plugin-codex/src/tools.js";
import { readEnvelope } from "./helpers/envelope.js";

const dirs: string[] = [];
let previousBin: string | undefined;

afterEach(async () => {
  if (previousBin === undefined) delete process.env.OPENCODE_BIN;
  else process.env.OPENCODE_BIN = previousBin;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/**
 * A CLI that never finishes on its own and answers SIGTERM with a clean exit 0.
 *
 * This is the shape the foreground path could not see: the wall-clock budget is
 * spent and the run is killed, but the process status alone says "success".
 */
async function sigtermTrappingOpenCode(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "opencode-plugin-codex-fg-timeout-"));
  dirs.push(dir);
  const bin = join(dir, "sigterm-trapping-opencode.mjs");
  await writeFile(
    bin,
    [
      "#!/usr/bin/env node",
      "if (process.argv[2] === '--version') { console.log('1.18.16'); process.exit(0); }",
      "console.log(JSON.stringify({ type: 'step_start', sessionID: 'ses_fg_timeout' }));",
      // Stay alive until the budget runs out, then exit cleanly on the signal.
      "const keepAlive = setInterval(() => undefined, 1000);",
      "process.on('SIGTERM', () => { clearInterval(keepAlive); process.exit(0); });"
    ].join("\n")
  );
  await chmod(bin, 0o755);
  previousBin = process.env.OPENCODE_BIN;
  process.env.OPENCODE_BIN = bin;
}

describe("foreground timeout", () => {
  test("a spent budget is a failure even when the CLI exits 0", async () => {
    // The background finalizer puts timedOut ahead of the exit code by design
    // (OC-3.1). The foreground path only read exitCode, so a CLI that traps
    // SIGTERM and exits 0 returned a discarded budget as ok:true with no
    // errorClass — and the caller had nothing telling it the session is resumable.
    await sigtermTrappingOpenCode();

    const response = await opencodeRun({
      cwd: process.cwd(),
      background: false,
      prompt: "foreground timeout probe",
      timeoutMs: 1_200
    });
    const envelope = response.structuredContent as {
      ok: boolean;
      error?: { code: string; retryable: boolean; message: string };
    };
    const result = readEnvelope<{
      exitCode?: number | null;
      errorClass?: string;
      outputSummary?: { resultComplete: boolean; guidance?: string };
    }>(response);

    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe("timeout");
    expect(envelope.error?.retryable).toBe(true);
    expect(result.errorClass).toBe("timeout");
    // The process itself reported success; only the budget knows better.
    expect(result.exitCode).toBe(0);
    expect(result.outputSummary?.resultComplete).toBe(false);
  }, 30_000);
});
