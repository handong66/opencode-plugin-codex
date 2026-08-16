import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

// The manifest, the package and the MCP serverInfo are three separate copies of one number.
// They disagreed for the whole 0.1 era (package.json 0.1.0 vs plugin.json 0.1.0+codex.20260710103034),
// so a caller pinning by version could not tell which tool contract it had. These tests are the pin.
// The manifest may append a local cachebuster (+codex.<timestamp>) but never a different release.

const repoRoot = process.cwd();
const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { version: string };
const pluginManifest = JSON.parse(
  readFileSync(join(repoRoot, "plugins/opencode-plugin-codex/.codex-plugin/plugin.json"), "utf8")
) as { version: string };
const serverSource = readFileSync(join(repoRoot, "plugins/opencode-plugin-codex/src/server.ts"), "utf8");

function serverInfoVersion(): string {
  const match = /name:\s*"opencode-plugin-codex",[\s\S]{0,400}?version:\s*"([^"]+)"/.exec(serverSource);
  if (!match) throw new Error("could not find the McpServer serverInfo version in src/server.ts");
  return match[1];
}

describe("version sync", () => {
  test("package.json is plain semver", () => {
    expect(packageJson.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("the plugin manifest advertises the release that was built", () => {
    const [release, cachebuster] = pluginManifest.version.split("+");
    expect(release).toBe(packageJson.version);
    if (cachebuster !== undefined) expect(cachebuster).toMatch(/^codex\.\d{8,}$/);
  });

  test("the MCP serverInfo reports the same version", () => {
    expect(serverInfoVersion()).toBe(packageJson.version);
  });

  test("the breaking timeoutMs floor is not published under a 0.1.x version", () => {
    // 0.1.x accepted any positive timeoutMs; since OC-1 the wire refuses 1..9999.
    expect(packageJson.version).not.toMatch(/^0\.1\./);
  });
});
