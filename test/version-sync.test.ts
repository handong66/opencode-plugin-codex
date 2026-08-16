import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
// @ts-expect-error - plain ESM helper shared with scripts/validate-plugin.mjs
import { releaseVersionIssues } from "../scripts/lib/release-version.mjs";

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

describe("release version gate", () => {
  test("accepts the local cachebuster while developing, and warns", () => {
    const { errors, warnings } = releaseVersionIssues({
      manifestVersion: "0.2.0+codex.20260710103034",
      packageVersion: "0.2.0",
      releaseTags: [],
      releaseEnv: undefined
    });

    // docs/development.md tells the author to run the cachebuster script, so the
    // development path must stay usable.
    expect(errors).toEqual([]);
    expect(warnings.join(" ")).toContain("drop it before cutting a release tag");
  });

  test("refuses a cachebuster on a tagged release commit", () => {
    // Two sibling plugins shipped as 0.2.1+codex.20260711160539 and
    // 0.1.0+codex.20260710103034 — versions that never matched their package.json.
    const { errors } = releaseVersionIssues({
      manifestVersion: "0.2.0+codex.20260710103034",
      packageVersion: "0.2.0",
      releaseTags: ["v0.2.0"],
      releaseEnv: undefined
    });

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("release commit must not carry the local cachebuster");
  });

  test("refuses it under an explicit release run too", () => {
    const { errors } = releaseVersionIssues({
      manifestVersion: "0.2.0+codex.20260710103034",
      packageVersion: "0.2.0",
      releaseTags: [],
      releaseEnv: "1"
    });

    expect(errors).toHaveLength(1);
  });

  test("still refuses a release core that is not the built version", () => {
    const { errors } = releaseVersionIssues({
      manifestVersion: "0.1.0+codex.20260710103034",
      packageVersion: "0.2.0",
      releaseTags: [],
      releaseEnv: undefined
    });

    expect(errors[0]).toContain("advertises release 0.1.0");
  });
});
