import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { stripAnsi } from "../plugins/opencode-plugin-codex/src/ansi.js";
import { parseListOutput, resetCheckCache } from "../plugins/opencode-plugin-codex/src/check-cache.js";
import { opencodeCheck, opencodeRun } from "../plugins/opencode-plugin-codex/src/tools.js";
import { resetOpenCodeDiscoveryCache } from "../plugins/opencode-plugin-codex/src/opencode-cli.js";
import { resetEffectiveModelCache } from "../plugins/opencode-plugin-codex/src/model-guard.js";
import { readEnvelope, refusalOf } from "./helpers/envelope.js";

const ESC = String.fromCharCode(27);

afterEach(() => {
  resetCheckCache();
  resetOpenCodeDiscoveryCache();
  resetEffectiveModelCache();
});

type CheckResult = {
  ok: boolean;
  version?: string;
  providers?: string[];
  providerIds?: string[];
  providersRaw?: string;
  cache?: { providersCachedAt?: string; providersCacheHit?: boolean };
};

async function withCountingCli<T>(run: (context: { counts: string }) => Promise<T>): Promise<T> {
  const binDir = await mkdtemp(join(tmpdir(), "opencode-plugin-codex-check-"));
  const previousBin = process.env.OPENCODE_BIN;
  const previousCounts = process.env.FAKE_CHECK_COUNTS;
  try {
    const counts = join(binDir, "invocations.log");
    await writeFile(counts, "");
    const bin = join(binDir, "fake-opencode.mjs");
    await writeFile(
      bin,
      [
        "#!/usr/bin/env node",
        "import { appendFileSync } from 'node:fs';",
        "appendFileSync(process.env.FAKE_CHECK_COUNTS, process.argv.slice(2).join(' ') + '\\n');",
        "if (process.argv[2] === '--version') { console.log('1.18.16'); process.exit(0); }",
        "if (process.argv[2] === 'debug') { console.log(JSON.stringify({ model: 'aihubmix/x' })); process.exit(0); }",
        "if (process.argv[2] === 'providers') {",
        "  const esc = String.fromCharCode(27);",
        "  console.log(esc + '[1mProviders' + esc + '[0m');",
        "  console.log('  ' + esc + '[32maihubmix' + esc + '[0m  AIHubMix gateway');",
        "  console.log('  deepseek  DeepSeek');",
        "  process.exit(0);",
        "}",
        "console.log('{}');"
      ].join("\n")
    );
    await chmod(bin, 0o755);
    process.env.OPENCODE_BIN = bin;
    process.env.FAKE_CHECK_COUNTS = counts;
    resetCheckCache();
    resetOpenCodeDiscoveryCache();
    resetEffectiveModelCache();
    return await run({ counts });
  } finally {
    if (previousBin === undefined) delete process.env.OPENCODE_BIN;
    else process.env.OPENCODE_BIN = previousBin;
    if (previousCounts === undefined) delete process.env.FAKE_CHECK_COUNTS;
    else process.env.FAKE_CHECK_COUNTS = previousCounts;
    await rm(binDir, { recursive: true, force: true });
  }
}

describe("stripAnsi and parseListOutput", () => {
  test("removes the escapes the CLI writes even when piped", () => {
    const coloured = `${ESC}[1mProviders${ESC}[0m\n  ${ESC}[32maihubmix${ESC}[0m  AIHubMix`;

    expect(stripAnsi(coloured)).toBe("Providers\n  aihubmix  AIHubMix");
  });

  test("returns lines and ids without inventing structure", () => {
    const { lines, ids } = parseListOutput(
      `${ESC}[1mProviders${ESC}[0m\n\n  - aihubmix  AIHubMix gateway\n  - deepseek  DeepSeek\n`
    );

    expect(lines).toEqual(["Providers", "aihubmix  AIHubMix gateway", "deepseek  DeepSeek"]);
    expect(ids).toEqual(["Providers", "aihubmix", "deepseek"]);
  });
});

describe("opencode_check caching", () => {
  test("runs the CLI once per process and reports the cache", async () => {
    await withCountingCli(async ({ counts }) => {
      const first = readEnvelope<CheckResult>(await opencodeCheck({ cwd: process.cwd() }));
      const second = readEnvelope<CheckResult>(await opencodeCheck({ cwd: process.cwd() }));

      expect(first.ok).toBe(true);
      expect(first.cache?.providersCacheHit).toBe(false);
      expect(second.cache?.providersCacheHit).toBe(true);
      expect(second.cache?.providersCachedAt).toBe(first.cache?.providersCachedAt);

      // 471 recorded calls, 124 in one day, each re-running discovery and the listing.
      const invocations = (await readFile(counts, "utf8")).split("\n").filter(Boolean);
      expect(invocations.filter((line) => line.startsWith("providers"))).toHaveLength(1);
    });
  });

  test("force re-reads after the user changes their setup", async () => {
    await withCountingCli(async ({ counts }) => {
      await opencodeCheck({ cwd: process.cwd() });
      const forced = readEnvelope<CheckResult>(await opencodeCheck({ cwd: process.cwd(), force: true }));

      expect(forced.cache?.providersCacheHit).toBe(false);
      const invocations = (await readFile(counts, "utf8")).split("\n").filter(Boolean);
      expect(invocations.filter((line) => line.startsWith("providers"))).toHaveLength(2);
    });
  });

  test("returns parsed provider ids with no escape sequences left in the payload", async () => {
    await withCountingCli(async () => {
      const result = readEnvelope<CheckResult>(await opencodeCheck({ cwd: process.cwd() }));

      expect(result.providerIds).toContain("aihubmix");
      expect(result.providerIds).toContain("deepseek");
      expect(JSON.stringify(result)).not.toContain(ESC);
      expect(result.providersRaw).not.toContain(ESC);
    });
  });
});

describe("provider id spelling", () => {
  test("fails fast on a case mismatch against the enumerated providers", async () => {
    await withCountingCli(async () => {
      // The list has to have been enumerated first; nothing is spawned for this check.
      await opencodeCheck({ cwd: process.cwd() });

      const error = await refusalOf(() =>
        opencodeRun({
          cwd: process.cwd(),
          background: false,
          prompt: "case mismatch probe",
          model: "AIHubMix/deep-deepseek-v4-pro"
        })
      );

      // AIHubMix/... ran five jobs and succeeded zero times; aihubmix/... ran 62 and
      // succeeded 50. The id is never rewritten silently — that was rejected.
      expect(error.code).toBe("model_not_found");
      expect(error.retryable).toBe(false);
      expect(error.message).toContain('"aihubmix"');
      expect(error.message).toContain("aihubmix/deep-deepseek-v4-pro");
      expect((error.details as { knownProviders: string[] }).knownProviders).toContain("aihubmix");
    });
  });

  test("says nothing about a provider that simply is not in the listing", async () => {
    await withCountingCli(async () => {
      await opencodeCheck({ cwd: process.cwd() });

      const response = readEnvelope<{ ok: boolean }>(
        await opencodeRun({
          cwd: process.cwd(),
          background: false,
          prompt: "unknown provider probe",
          model: "brandnew/model-1"
        })
      );

      // A provider configured since the last listing is not the plugin's business to
      // refuse; only the proven case-mismatch failure is.
      expect(response.ok).toBe(true);
    });
  });

  test("stays silent when no listing has been taken in this process", async () => {
    await withCountingCli(async () => {
      const response = readEnvelope<{ ok: boolean }>(
        await opencodeRun({
          cwd: process.cwd(),
          background: false,
          prompt: "no listing probe",
          model: "AIHubMix/deep-deepseek-v4-pro"
        })
      );

      expect(response.ok).toBe(true);
    });
  });
});
