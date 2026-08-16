import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  describeModelSelection,
  parseOpenCodeDebugConfig,
  probeEffectiveModel,
  resetEffectiveModelCache
} from "../plugins/opencode-plugin-codex/src/model-guard.js";
import { opencodeRun } from "../plugins/opencode-plugin-codex/src/tools.js";
import { resetOpenCodeDiscoveryCache } from "../plugins/opencode-plugin-codex/src/opencode-cli.js";
import { readEnvelope } from "./helpers/envelope.js";

afterEach(() => {
  resetEffectiveModelCache();
  resetOpenCodeDiscoveryCache();
});

async function withFakeConfigCli<T>(
  body: string,
  run: (bin: string) => Promise<T>
): Promise<T> {
  const binDir = await mkdtemp(join(tmpdir(), "opencode-plugin-codex-config-"));
  try {
    const bin = join(binDir, "fake-opencode.mjs");
    await writeFile(
      bin,
      [
        "#!/usr/bin/env node",
        "if (process.argv[2] === '--version') { console.log('1.18.16'); process.exit(0); }",
        body,
        "let input = '';",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (chunk) => { input += chunk; });",
        "process.stdin.on('end', () => console.log(JSON.stringify({ args: process.argv.slice(2), input })));"
      ].join("\n")
    );
    await chmod(bin, 0o755);
    return await run(bin);
  } finally {
    await rm(binDir, { recursive: true, force: true });
  }
}

const DEBUG_CONFIG_OK =
  "if (process.argv[2] === 'debug' && process.argv[3] === 'config') {" +
  " console.log(JSON.stringify({ model: 'aihubmix/claude-opus-4-6', apiKey: 'sk-secret-must-not-leak'," +
  " agent: { build: { model: 'aihubmix/claude-sonnet-4-6', variant: 'max' }, plan: { model: 'deepseek/deepseek-v4-flash' } } }));" +
  " process.exit(0); }";

describe("parseOpenCodeDebugConfig", () => {
  test("keeps only the four allowlisted model fields", () => {
    const { config, warning } = parseOpenCodeDebugConfig(
      JSON.stringify({
        model: "aihubmix/claude-opus-4-6",
        apiKey: "sk-secret-must-not-leak",
        provider: { aihubmix: { options: { apiKey: "sk-also-secret" } } },
        agent: {
          build: { model: "aihubmix/claude-sonnet-4-6", variant: "max", prompt: "…" },
          plan: { model: "deepseek/deepseek-v4-flash" },
          general: { model: "someone/else" }
        }
      })
    );

    expect(warning).toBeUndefined();
    expect(config).toEqual({
      model: "aihubmix/claude-opus-4-6",
      build: { model: "aihubmix/claude-sonnet-4-6", variant: "max" },
      plan: { model: "deepseek/deepseek-v4-flash" }
    });
    expect(JSON.stringify(config)).not.toContain("sk-");
  });

  test("degrades malformed output to a warning instead of throwing", () => {
    for (const output of ["", "Error: unknown command 'debug'", "{not json"]) {
      const { config, warning } = parseOpenCodeDebugConfig(output);

      expect(config, output).toBeUndefined();
      expect(warning, output).toBeTruthy();
    }
  });

  test("tolerates a banner in front of the JSON object", () => {
    const { config } = parseOpenCodeDebugConfig(
      `resolved config for /tmp/x\n${JSON.stringify({ model: "aihubmix/x" })}`
    );

    expect(config?.model).toBe("aihubmix/x");
  });
});

describe("probeEffectiveModel", () => {
  test("reads the effective configuration and memoises it per bin and cwd", async () => {
    await withFakeConfigCli(DEBUG_CONFIG_OK, async (bin) => {
      const first = await probeEffectiveModel({ opencodeBin: bin, cwd: process.cwd() });
      expect(first.config?.model).toBe("aihubmix/claude-opus-4-6");
      expect(first.warnings).toEqual([]);

      // Deleting the binary proves the second call never spawned it: opencode_check
      // alone ran 471 times in two months, 124 of them in one day.
      await rm(bin, { force: true });
      const second = await probeEffectiveModel({ opencodeBin: bin, cwd: process.cwd() });
      expect(second.config?.model).toBe("aihubmix/claude-opus-4-6");
    });
  });

  test("re-probes after a failed probe instead of remembering the failure", async () => {
    // One `opencode debug config` that exits non-zero used to answer every later
    // probe in this MCP server process, and opencode_transfer reads only the cached
    // configured root model — so every later transfer without an explicit model
    // refused with opencode_model_required until the server restarted.
    await withFakeConfigCli(
      [
        "if (process.argv[2] === 'debug' && process.argv[3] === 'config') {",
        "  const fs = await import('node:fs');",
        "  const marker = process.argv[1] + '.probed';",
        "  if (!fs.existsSync(marker)) { fs.writeFileSync(marker, 'x'); console.error('config store busy'); process.exit(1); }",
        "  console.log(JSON.stringify({ model: 'aihubmix/claude-opus-4-6' }));",
        "  process.exit(0);",
        "}"
      ].join("\n"),
      async (bin) => {
        const failed = await probeEffectiveModel({ opencodeBin: bin, cwd: process.cwd() });
        expect(failed.config).toBeUndefined();
        expect(failed.warnings.join(" ")).toContain("opencode debug config exited 1");

        const retried = await probeEffectiveModel({ opencodeBin: bin, cwd: process.cwd() });
        expect(retried.config?.model).toBe("aihubmix/claude-opus-4-6");
        expect(retried.warnings).toEqual([]);
      }
    );
  });

  test("a CLI without `debug config` degrades to a warning, not a failure", async () => {
    await withFakeConfigCli(
      "if (process.argv[2] === 'debug') { console.error('unknown command'); process.exit(1); }",
      async (bin) => {
        const probe = await probeEffectiveModel({ opencodeBin: bin, cwd: process.cwd() });

        expect(probe.config).toBeUndefined();
        expect(probe.warnings.join(" ")).toContain("opencode debug config exited 1");
      }
    );
  });
});

describe("describeModelSelection", () => {
  test("omitting model reports the configured source and no warning", () => {
    const { modelSelection, warnings } = describeModelSelection({
      probe: { config: { model: "aihubmix/claude-opus-4-6" }, warnings: [] }
    });

    expect(modelSelection.source).toBe("opencode_config");
    expect(modelSelection.requested).toBeUndefined();
    expect(modelSelection.configured).toBe("aihubmix/claude-opus-4-6");
    expect(warnings).toEqual([]);
  });

  test("an explicit model that differs from the configured default warns", () => {
    const { modelSelection, warnings } = describeModelSelection({
      requested: "aihubmix/claude-opus-4-6-think",
      probe: { config: { model: "aihubmix/claude-opus-4-6" }, warnings: [] }
    });

    expect(modelSelection.source).toBe("explicit");
    expect(modelSelection.requested).toBe("aihubmix/claude-opus-4-6-think");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("overrides the OpenCode configured default");
    // Deliberately advisory: 13 explicit-model jobs were refused with a 403, but a
    // refusal here would be the plugin guessing at authorization.
    expect(warnings[0]).toContain("not proof of authorization");
  });

  test("an explicit model equal to the configured default does not warn", () => {
    const { warnings } = describeModelSelection({
      requested: "aihubmix/claude-opus-4-6",
      probe: { config: { model: "aihubmix/claude-opus-4-6" }, warnings: [] }
    });

    expect(warnings).toEqual([]);
  });

  test("an unreadable configuration still reports the source", () => {
    const { modelSelection, warnings } = describeModelSelection({
      requested: "aihubmix/x",
      probe: { warnings: ["opencode debug config exited 1; the effective model configuration is unknown."] }
    });

    expect(modelSelection.source).toBe("explicit");
    expect(modelSelection.configUnavailable).toBe(true);
    expect(warnings).toHaveLength(1);
  });
});

describe("execution tools report which model decided the call", () => {
  test("an omitted model passes no --model, reports opencode_config, and spawns no probe", async () => {
    await withFakeConfigCli(DEBUG_CONFIG_OK, async (bin) => {
      const previous = process.env.OPENCODE_BIN;
      process.env.OPENCODE_BIN = bin;
      try {
        const response = readEnvelope<{
          stdout?: string;
          warnings: string[];
          modelSelection: { source: string; configured?: string };
        }>(await opencodeRun({ cwd: process.cwd(), background: false, prompt: "model guard probe" }));
        const invocation = JSON.parse((response.stdout ?? "").trim()) as { args: string[] };

        expect(invocation.args).not.toContain("--model");
        expect(response.modelSelection.source).toBe("opencode_config");
        // Nothing to compare, so the submit path stays free of an extra CLI process:
        // 943 of 1,051 recorded jobs took exactly this path.
        expect(response.modelSelection.configured).toBeUndefined();
        expect(response.warnings.join(" ")).not.toContain("modelSelection:");
      } finally {
        if (previous === undefined) delete process.env.OPENCODE_BIN;
        else process.env.OPENCODE_BIN = previous;
      }
    });
  });

  test("an explicit differing model still runs, but says so", async () => {
    await withFakeConfigCli(DEBUG_CONFIG_OK, async (bin) => {
      const previous = process.env.OPENCODE_BIN;
      process.env.OPENCODE_BIN = bin;
      try {
        const response = readEnvelope<{
          ok: boolean;
          stdout?: string;
          warnings: string[];
          modelSelection: { source: string; requested?: string; configured?: string };
        }>(
          await opencodeRun({
            cwd: process.cwd(),
            background: false,
            prompt: "model override probe",
            model: "deepseek/deepseek-v4-flash"
          })
        );
        const invocation = JSON.parse((response.stdout ?? "").trim()) as { args: string[] };

        expect(response.ok).toBe(true);
        expect(invocation.args).toContain("--model");
        expect(response.modelSelection.source).toBe("explicit");
        expect(response.modelSelection.requested).toBe("deepseek/deepseek-v4-flash");
        expect(response.warnings.some((warning) => warning.includes("overrides the OpenCode configured default"))).toBe(
          true
        );
      } finally {
        if (previous === undefined) delete process.env.OPENCODE_BIN;
        else process.env.OPENCODE_BIN = previous;
      }
    });
  });
});
