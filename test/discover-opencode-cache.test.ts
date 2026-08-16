import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  describeDiscoveryFailure,
  discoverOpenCode,
  resetOpenCodeDiscoveryCache
} from "../plugins/opencode-plugin-codex/src/opencode-cli.js";

const dirs: string[] = [];

async function fakeBin(script: (paths: { probeLog: string }) => string): Promise<{ bin: string; probeLog: string }> {
  const dir = await mkdtemp(join(tmpdir(), "opencode-plugin-codex-discovery-"));
  dirs.push(dir);
  const bin = join(dir, "opencode");
  const probeLog = join(dir, "probes.log");
  await writeFile(bin, script({ probeLog }));
  await chmod(bin, 0o755);
  await writeFile(probeLog, "");
  return { bin, probeLog };
}

/** PATH is emptied so the probe cannot reach a real CLI; use shell builtins only. */
function countingVersionScript({ probeLog }: { probeLog: string }): string {
  return ["#!/bin/sh", `printf 'probe\\n' >> ${probeLog}`, "printf '1.18.16\\n'"].join("\n");
}

afterEach(async () => {
  resetOpenCodeDiscoveryCache();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("explicit binaries are trusted", () => {
  test("uses a configured binary that cannot answer --version", async () => {
    // opencode_check reported the CLI available at 05:05:22 and opencode_run
    // reported it missing 27 seconds later, listing the caller's own path.
    const { bin } = await fakeBin(() => "#!/bin/sh\nexit 1\n");

    const result = await discoverOpenCode({ opencodeBin: bin, env: { PATH: "" } });

    expect(result.ok).toBe(true);
    expect(result.bin).toBe(bin);
    expect(result.source).toBe("explicit");
    expect(result.version).toBeUndefined();
    expect(result.errors.join(" ")).toContain("--version exited 1");
  });

  test("still reports the version when the probe works", async () => {
    const { bin } = await fakeBin(countingVersionScript);

    const result = await discoverOpenCode({ opencodeBin: bin, env: { PATH: "" } });

    expect(result.version).toBe("1.18.16");
    expect(result.source).toBe("explicit");
  });

  test("does not silently serve a configured path that is not there", async () => {
    // The machine may still have a real CLI on a fallback path; what must not happen
    // is answering with the configured path, or hiding that it was unusable.
    const missing = join(tmpdir(), "definitely-missing-opencode");
    const result = await discoverOpenCode({ opencodeBin: missing, env: { PATH: "" } });

    expect(result.bin).not.toBe(missing);
    expect(result.errors.join(" ")).toContain("explicitly configured");
  });
});

describe("discovery memo", () => {
  test("probes once per process instead of once per call", async () => {
    const { bin, probeLog } = await fakeBin(countingVersionScript);
    const env = { PATH: "" };

    await discoverOpenCode({ opencodeBin: bin, env });
    const second = await discoverOpenCode({ opencodeBin: bin, env });

    expect(second.source).toBe("cache");
    expect(second.bin).toBe(bin);
    expect((await readFile(probeLog, "utf8")).trim().split("\n")).toHaveLength(1);
  });

  test("re-probes when the remembered binary is gone", async () => {
    const { bin } = await fakeBin(countingVersionScript);
    const env = { PATH: "" };

    const first = await discoverOpenCode({ opencodeBin: bin, env });
    expect(first.bin).toBe(bin);
    await rm(bin, { force: true });
    const afterRemoval = await discoverOpenCode({ opencodeBin: bin, env });

    // The memo must not keep serving a binary that no longer exists.
    expect(afterRemoval.bin).not.toBe(bin);
    expect(afterRemoval.source).not.toBe("cache");
  });

  test("never remembers a failure", async () => {
    const missing = join(tmpdir(), "not-installed-yet-opencode");
    const env = { PATH: "" };
    await discoverOpenCode({ opencodeBin: missing, env });

    const { bin } = await fakeBin(countingVersionScript);
    const afterInstall = await discoverOpenCode({ opencodeBin: bin, env });

    expect(afterInstall.ok).toBe(true);
    expect(afterInstall.bin).toBe(bin);
  });

  test("force re-probes even when the answer is remembered", async () => {
    const { bin, probeLog } = await fakeBin(countingVersionScript);
    const env = { PATH: "" };

    await discoverOpenCode({ opencodeBin: bin, env });
    const forced = await discoverOpenCode({ opencodeBin: bin, env, force: true });

    expect(forced.source).toBe("explicit");
    expect((await readFile(probeLog, "utf8")).trim().split("\n")).toHaveLength(2);
  });
});

describe("failure diagnostics", () => {
  test("reports why, not just where", async () => {
    const result = await discoverOpenCode({ env: { PATH: "", HOME: await mkdtemp(join(tmpdir(), "empty-home-")) } });
    const message = describeDiscoveryFailure(result);

    expect(result.errorCode).toBe("cli_not_found");
    expect(message).toContain("cli_not_found");
    expect(message).toContain("Tried:");
    expect(message).toContain("Reasons:");
  });

  test("separates a probe timeout from a missing CLI", async () => {
    const result = {
      ok: false,
      tried: ["/usr/local/bin/opencode"],
      errors: ["/usr/local/bin/opencode: --version exited null (probe timed out): "],
      errorCode: "cli_probe_timeout" as const
    };

    expect(describeDiscoveryFailure(result)).toContain("cli_probe_timeout");
    expect(describeDiscoveryFailure(result)).not.toContain("not found (cli_not_found)");
  });
});
