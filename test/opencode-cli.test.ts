import { describe, expect, test } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcess } from "../plugins/opencode-plugin-codex/src/opencode-cli.js";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForGrandchildPid(path: string, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await readFile(path, "utf8").catch(() => "");
    const pid = Number(value);
    if (Number.isSafeInteger(pid) && pid > 1) return pid;
    await delay(25);
  }
  throw new Error(`Grandchild did not publish its pid within ${timeoutMs}ms.`);
}

async function isProcessAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }

  // A minimal Docker init may leave an orphan as a zombie briefly. It cannot run
  // any more work, so treat that Linux-only state as exited while it is reaped.
  if (process.platform === "linux") {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
    const state = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
    if (state === "Z") return false;
  }
  return true;
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (await isProcessAlive(pid)) {
    if (Date.now() >= deadline) {
      throw new Error(`Grandchild ${pid} was still alive after ${timeoutMs}ms.`);
    }
    await delay(25);
  }
}

describe("runProcess output bounds", () => {
  test("retains only a bounded tail for oversized stdout", async () => {
    const result = await runProcess(
      process.execPath,
      ["-e", "process.stdout.write('x'.repeat(200_000))"],
      { maxOutputChars: 1_000 }
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toHaveLength(1_000);
    expect(result.stdoutTruncated).toBe(true);
  });

  test("kills the foreground process group when timeoutMs expires", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opencode-plugin-codex-timeout-tree-"));
    const pidFile = join(dir, "grandchild.pid");
    const parent = join(dir, "parent.mjs");
    let grandchildPid: number | undefined;
    let grandchildExited = false;
    try {
      await writeFile(
        parent,
        [
          "import { spawn } from 'node:child_process';",
          "import { writeFileSync } from 'node:fs';",
          "const grandchild = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => undefined); setInterval(() => undefined, 1000)\"], { stdio: 'ignore' });",
          "writeFileSync(process.env.PID_FILE, String(grandchild.pid));",
          "setInterval(() => undefined, 1000);"
        ].join("\n")
      );

      const resultPromise = runProcess(process.execPath, [parent], {
        env: { PID_FILE: pidFile },
        timeoutMs: 3_000
      });
      grandchildPid = await waitForGrandchildPid(pidFile, 2_000);
      const result = await resultPromise;

      expect(result.timedOut).toBe(true);
      await waitForProcessExit(grandchildPid, 4_000);
      grandchildExited = true;
    } finally {
      if (!grandchildExited && grandchildPid && (await isProcessAlive(grandchildPid))) {
        process.kill(grandchildPid, "SIGKILL");
        await waitForProcessExit(grandchildPid, 1_000).catch(() => undefined);
      }
      await rm(dir, { recursive: true, force: true });
    }
  }, 12_000);
});
