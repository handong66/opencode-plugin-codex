import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { isBoundaryError, stateWriteFailed } from "../plugins/opencode-plugin-codex/src/boundary.js";
import { readEnvelope, type ToolErrorShape } from "./helpers/envelope.js";
import { JobStore } from "../plugins/opencode-plugin-codex/src/job-store.js";
import {
  configureWorkspaceRootsProvider,
  opencodeCheck,
  opencodeRun,
  opencodeTransfer
} from "../plugins/opencode-plugin-codex/src/tools.js";
import { resetOpenCodeDiscoveryCache } from "../plugins/opencode-plugin-codex/src/opencode-cli.js";
import { resetEffectiveModelCache } from "../plugins/opencode-plugin-codex/src/model-guard.js";

async function withRoots<T>(roots: string[], run: () => Promise<T>): Promise<T> {
  configureWorkspaceRootsProvider(async () => roots);
  try {
    return await run();
  } finally {
    configureWorkspaceRootsProvider(async () => [process.cwd()]);
  }
}

async function withFakeOpenCode<T>(run: () => Promise<T>): Promise<T> {
  const binDir = await mkdtemp(join(tmpdir(), "opencode-plugin-codex-boundary-bin-"));
  const previous = process.env.OPENCODE_BIN;
  try {
    const bin = join(binDir, "fake-opencode.mjs");
    await writeFile(
      bin,
      [
        "#!/usr/bin/env node",
        "if (process.argv[2] === '--version') { console.log('1.18.16'); process.exit(0); }",
        "if (process.argv[2] === 'debug') { console.log(JSON.stringify({ model: 'aihubmix/claude-opus-4-6' })); process.exit(0); }",
        "console.log(JSON.stringify({ args: process.argv.slice(2) }));"
      ].join("\n")
    );
    await chmod(bin, 0o755);
    process.env.OPENCODE_BIN = bin;
    resetOpenCodeDiscoveryCache();
    resetEffectiveModelCache();
    return await run();
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_BIN;
    else process.env.OPENCODE_BIN = previous;
    resetOpenCodeDiscoveryCache();
    resetEffectiveModelCache();
    await rm(binDir, { recursive: true, force: true });
  }
}

/**
 * A tool refusal is a returned envelope; a direct JobStore call still throws, since
 * it is below the MCP surface. Both carry the same code and `retryable`.
 */
async function boundaryOf(run: () => Promise<unknown>): Promise<ToolErrorShape> {
  let value: unknown;
  try {
    value = await run();
  } catch (error) {
    if (isBoundaryError(error)) {
      return { code: error.code, message: error.message, retryable: error.retryable, details: error.details };
    }
    throw error;
  }
  const envelope = (value as { structuredContent?: { ok?: boolean; error?: ToolErrorShape } })?.structuredContent;
  if (envelope?.ok === false && envelope.error) return envelope.error;
  throw new Error(`Expected a boundary refusal, got ${JSON.stringify(value).slice(0, 300)}`);
}

describe("workspace boundary refusals carry a code and the roots", () => {
  test("an out-of-bounds cwd names the available roots and why a new worktree is rejected", async () => {
    const outside = await mkdtemp(join(tmpdir(), "opencode-plugin-codex-outside-"));
    try {
      const error = await withRoots([process.cwd()], () =>
        boundaryOf(() => opencodeRun({ cwd: outside, prompt: "boundary probe" }))
      );

      expect(error.code).toBe("workspace_out_of_bounds");
      expect(error.retryable).toBe(false);
      // Three of the four recorded refusals named a worktree that ran jobs normally
      // the next day, once Codex's per-call workspace metadata caught up.
      expect(error.message).toContain(process.cwd());
      expect(error.message).toContain("per-call Codex workspace roots");
      expect((error.details as { roots: string[] }).roots).toContain(process.cwd());
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("no workspace root at all is workspace_unavailable, and execution still refuses", async () => {
    const error = await withRoots([], () => boundaryOf(() => opencodeRun({ prompt: "boundary probe" })));

    expect(error.code).toBe("workspace_unavailable");
    expect(error.message).toContain("opencode_check");
  });
});

describe("opencode_check degrades instead of failing whole", () => {
  test("reports CLI and effective-model diagnostics with no workspace root", async () => {
    await withFakeOpenCode(async () => {
      const response = readEnvelope<{
        ok: boolean;
        version?: string;
        workspace: { ok: boolean; error?: { code: string; retryable: boolean } };
        effectiveModel?: { model?: string };
        providersRaw?: string;
        warnings: string[];
      }>(await withRoots([], () => opencodeCheck({})));

      // Four recorded missing-root refusals hid the CLI diagnostics behind a bare
      // exception — exactly when the caller was most tempted to bypass the plugin.
      expect(response.ok).toBe(true);
      expect(response.version).toBe("1.18.16");
      expect(response.workspace.ok).toBe(false);
      expect(response.workspace.error?.code).toBe("workspace_unavailable");
      expect(response.effectiveModel?.model).toBe("aihubmix/claude-opus-4-6");
      // Provider listing needs a workspace; it is skipped, not faked.
      expect(response.providersRaw).toBeUndefined();
      expect(response.warnings.join(" ")).toContain("Do not fall back to a raw");
    });
  });

  test("reports the resolved workspace when a root is available", async () => {
    await withFakeOpenCode(async () => {
      const response = readEnvelope<{ workspace: { ok: boolean; cwd?: string } }>(
        await withRoots([process.cwd()], () => opencodeCheck({}))
      );

      expect(response.workspace.ok).toBe(true);
      expect(response.workspace.cwd).toBe(process.cwd());
    });
  });
});

describe("attachment and rollout refusals say what a legal value is", () => {
  test("an attachment outside cwd names cwd and both remedies", async () => {
    const outside = await mkdtemp(join(tmpdir(), "opencode-plugin-codex-attach-"));
    try {
      const stray = join(outside, "notes.md");
      await writeFile(stray, "context");
      // The old message repeated verbatim six times in a month and never said this.
      const error = await boundaryOf(() =>
        opencodeRun({ cwd: process.cwd(), prompt: "attachment probe", files: [stray] })
      );

      expect(error.code).toBe("file_attachment_invalid");
      expect(error.message).toContain(`Attachments must resolve inside cwd (${process.cwd()})`);
      expect(error.message).toContain("Copy the file into the workspace, or inline its contents in prompt.");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("a Codex private path in the prompt is private_path_blocked", async () => {
    const error = await boundaryOf(() =>
      opencodeRun({ cwd: process.cwd(), prompt: "read ~/.codex/config.toml and summarise" })
    );

    expect(error.code).toBe("private_path_blocked");
    expect(error.retryable).toBe(false);
  });

  test("says where it matched instead of rejecting a long prompt in silence", async () => {
    // 28 recorded rejections across seven projects, none of which said which span
    // matched — so a 250,000-character prompt could only be rebuilt, never edited.
    const prompt = [
      "A".repeat(1_000),
      "Before reviewing, read /Users/example/.codex/skills/pua/SKILL.md and follow it.",
      "B".repeat(1_000)
    ].join(" ");

    const error = await boundaryOf(() => opencodeRun({ cwd: process.cwd(), prompt }));
    const details = error.details as { hits: { preview: string; index: number }[]; promptChars: number };

    expect(error.code).toBe("private_path_blocked");
    expect(details.hits[0].index).toBeGreaterThan(900);
    expect(details.hits[0].preview).toContain("/Users/example/.codex/skills");
    expect(details.hits[0].preview.length).toBeLessThan(200);
    expect(details.promptChars).toBe(prompt.length);
    expect(error.message).toContain("First match at character");
  });

  test("masks the running user's home directory in that preview", async () => {
    const home = homedir();
    const error = await boundaryOf(() =>
      opencodeRun({ cwd: process.cwd(), prompt: `please read ${home}/.codex/config.toml first` })
    );
    const details = error.details as { hits: { preview: string }[] };

    // The preview goes back into the transcript; it should not carry an absolute
    // path to the running user's home.
    expect(details.hits[0].preview).toContain("~/.codex/config.toml");
    expect(details.hits[0].preview).not.toContain(home);
  });

  test("a rollout file outside the allowed roots is rollout_invalid", async () => {
    const outside = await mkdtemp(join(tmpdir(), "opencode-plugin-codex-rollout-"));
    try {
      const stray = join(outside, "rollout.jsonl");
      await writeFile(stray, "{}\n");
      const error = await boundaryOf(() =>
        opencodeTransfer({ cwd: process.cwd(), model: "aihubmix/x", rolloutFile: stray })
      );

      expect(error.code).toBe("rollout_invalid");
      expect(error.message).toContain("Allowed roots:");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe("state writes", () => {
  test("a failed job-record write names the state directory instead of a bare errno", async () => {
    const parent = await mkdtemp(join(tmpdir(), "opencode-plugin-codex-state-"));
    const stateDir = join(parent, "state");
    try {
      // Simulate the recorded ENOSPC: the state directory cannot be written at all.
      await chmod(parent, 0o500);
      const store = new JobStore(stateDir);
      const error = await boundaryOf(() =>
        store.write({
          id: "job_state_write",
          kind: "run",
          status: "queued",
          cwd: process.cwd(),
          command: "opencode",
          args: [],
          createdAt: new Date().toISOString(),
          timeoutMs: 600_000,
          stdoutPath: "",
          stderrPath: ""
        })
      );

      expect(error.code).toBe("state_write_failed");
      expect(error.message).toContain(stateDir);
      expect(error.message).toContain("OPENCODE_PLUGIN_STATE_DIR");
    } finally {
      await chmod(parent, 0o700).catch(() => undefined);
      await rm(parent, { recursive: true, force: true });
    }
  });

  test("stateWriteFailed keeps the underlying errno", () => {
    const enospc = Object.assign(new Error("no space left on device"), { code: "ENOSPC" });

    const error = stateWriteFailed(enospc, "/state");

    expect(error.message).toContain("ENOSPC");
    expect((error.details as { errno?: string }).errno).toBe("ENOSPC");
  });
});
