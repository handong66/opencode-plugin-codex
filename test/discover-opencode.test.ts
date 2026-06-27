import { mkdirSync, writeFileSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";
import { discoverOpenCode } from "../plugins/opencode-plugin-codex/src/opencode-cli.js";

describe("discoverOpenCode", () => {
  test("prefers explicit opencode binary path and reads its version", async () => {
    const dir = join(tmpdir(), `opencode-plugin-codex-test-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const bin = join(dir, "opencode");
    writeFileSync(bin, "#!/bin/sh\nprintf '9.9.9\\n'\n");
    await chmod(bin, 0o755);

    const result = await discoverOpenCode({ opencodeBin: bin, env: { PATH: "" } });

    expect(result.ok).toBe(true);
    expect(result.bin).toBe(bin);
    expect(result.version).toBe("9.9.9");
  });
});
