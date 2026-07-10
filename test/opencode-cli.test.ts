import { describe, expect, test } from "vitest";
import { runProcess } from "../plugins/opencode-plugin-codex/src/opencode-cli.js";

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
    const marker = join(dir, "late-marker.txt");
    const parent = join(dir, "parent.mjs");
    try {
      await writeFile(
        parent,
        [
          "import { spawn } from 'node:child_process';",
          "spawn(process.execPath, ['-e', \"setTimeout(() => require('node:fs').writeFileSync(process.env.MARKER, 'late'), 200)\"], { stdio: 'ignore' });",
          "setInterval(() => undefined, 1000);"
        ].join("\n")
      );

      const result = await runProcess(process.execPath, [parent], {
        env: { MARKER: marker },
        timeoutMs: 50
      });
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(result.timedOut).toBe(true);
      expect(existsSync(marker)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
