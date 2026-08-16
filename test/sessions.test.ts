import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { opencodeSessions } from "../plugins/opencode-plugin-codex/src/tools.js";
import { resetOpenCodeDiscoveryCache } from "../plugins/opencode-plugin-codex/src/opencode-cli.js";
import { readEnvelope, refusalOf } from "./helpers/envelope.js";

type SessionsData = {
  ok: boolean;
  warnings: string[];
  sessions: { id: string; title?: string; directory?: string; updatedAt?: string }[];
  returned: number;
  scanned: number;
  filteredToWorkspaceRoots: boolean;
};

afterEach(() => {
  resetOpenCodeDiscoveryCache();
});

/** The shape `opencode session list --format json` returns on CLI 1.18.16. */
const SESSIONS = [
  {
    id: "ses_here",
    title: "Default-model guard design review",
    updated: 1_786_731_897_007,
    created: 1_786_731_824_465,
    projectId: "1c82",
    directory: "CWD_PLACEHOLDER"
  },
  {
    id: "ses_elsewhere",
    title: "Another project entirely",
    updated: 1_786_731_000_000,
    created: 1_786_730_000_000,
    projectId: "9f01",
    directory: "/somewhere/else"
  }
];

async function withSessionCli<T>(body: string, run: () => Promise<T>): Promise<T> {
  const binDir = await mkdtemp(join(tmpdir(), "opencode-plugin-codex-sessions-"));
  const previous = process.env.OPENCODE_BIN;
  try {
    const bin = join(binDir, "fake-opencode.mjs");
    await writeFile(
      bin,
      [
        "#!/usr/bin/env node",
        "if (process.argv[2] === '--version') { console.log('1.18.16'); process.exit(0); }",
        body
      ].join("\n")
    );
    await chmod(bin, 0o755);
    process.env.OPENCODE_BIN = bin;
    resetOpenCodeDiscoveryCache();
    return await run();
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_BIN;
    else process.env.OPENCODE_BIN = previous;
    resetOpenCodeDiscoveryCache();
    await rm(binDir, { recursive: true, force: true });
  }
}

function listBody(sessions: unknown): string {
  return `if (process.argv[2] === 'session') { console.log(${JSON.stringify(
    JSON.stringify(sessions)
  )}); process.exit(0); }`;
}

describe("opencode_sessions", () => {
  test("returns the sessions that ran inside the workspace and hides the rest", async () => {
    const sessions = JSON.parse(JSON.stringify(SESSIONS).replace("CWD_PLACEHOLDER", process.cwd()));

    await withSessionCli(listBody(sessions), async () => {
      const result = readEnvelope<SessionsData>(await opencodeSessions({ cwd: process.cwd() }));

      // 287 timed-out jobs kept no session id and no surviving log; without this the
      // only way back to your own work was a raw CLI call.
      expect(result.ok).toBe(true);
      expect(result.sessions.map((session) => session.id)).toEqual(["ses_here"]);
      expect(result.sessions[0].title).toBe("Default-model guard design review");
      expect(result.sessions[0].updatedAt).toBe(new Date(1_786_731_897_007).toISOString());
      expect(result.scanned).toBe(2);
      expect(result.filteredToWorkspaceRoots).toBe(true);
      expect(result.warnings).toEqual([]);
    });
  });

  test("includeAllDirectories opts into sessions from other projects", async () => {
    const sessions = JSON.parse(JSON.stringify(SESSIONS).replace("CWD_PLACEHOLDER", process.cwd()));

    await withSessionCli(listBody(sessions), async () => {
      const result = readEnvelope<SessionsData>(
        await opencodeSessions({ cwd: process.cwd(), includeAllDirectories: true })
      );

      expect(result.sessions.map((session) => session.id)).toEqual(["ses_here", "ses_elsewhere"]);
      expect(result.filteredToWorkspaceRoots).toBe(false);
    });
  });

  test("says so when every recent session belongs to another project", async () => {
    await withSessionCli(listBody([SESSIONS[1]]), async () => {
      const result = readEnvelope<SessionsData>(await opencodeSessions({ cwd: process.cwd() }));

      expect(result.sessions).toEqual([]);
      expect(result.warnings.join(" ")).toContain("includeAllDirectories:true");
    });
  });

  test("honours limit", async () => {
    const many = Array.from({ length: 5 }, (_, index) => ({
      id: `ses_${index}`,
      title: `session ${index}`,
      updated: 1_786_731_000_000 + index,
      created: 1_786_730_000_000,
      directory: process.cwd()
    }));

    await withSessionCli(listBody(many), async () => {
      const result = readEnvelope<SessionsData>(await opencodeSessions({ cwd: process.cwd(), limit: 2 }));

      expect(result.sessions).toHaveLength(2);
      expect(result.returned).toBe(2);
      expect(result.scanned).toBe(5);
    });
  });

  test("reports a failing listing as a typed error instead of an empty list", async () => {
    await withSessionCli(
      "if (process.argv[2] === 'session') { console.error('database is locked'); process.exit(1); }",
      async () => {
        const error = await refusalOf(() => opencodeSessions({ cwd: process.cwd() }));

        expect(error.code).toBe("session_listing_failed");
        expect(error.retryable).toBe(true);
        expect(error.message).toContain("database is locked");
      }
    );
  });
});
