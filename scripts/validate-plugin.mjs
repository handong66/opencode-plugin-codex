#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, join } from "node:path";
import { releaseVersionIssues } from "./lib/release-version.mjs";

const root = resolve("plugins/opencode-plugin-codex");
const manifestPath = join(root, ".codex-plugin", "plugin.json");
const mcpPath = join(root, ".mcp.json");
const skillPath = join(root, "skills", "opencode", "SKILL.md");
const serverBundlePath = join(root, "dist", "server.js");
const workerBundlePath = join(root, "dist", "job-worker.js");
const errors = [];

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    errors.push(`${path}: ${error.message}`);
    return {};
  }
}

function requireString(object, field) {
  if (typeof object[field] !== "string" || object[field].trim() === "") {
    errors.push(`plugin.json requires non-empty ${field}`);
  }
}

if (!existsSync(manifestPath)) errors.push("missing .codex-plugin/plugin.json");
if (!existsSync(mcpPath)) errors.push("missing .mcp.json");
if (!existsSync(skillPath)) errors.push("missing skills/opencode/SKILL.md");
if (!existsSync(serverBundlePath)) errors.push("missing dist/server.js; run npm run build");
if (!existsSync(workerBundlePath)) errors.push("missing dist/job-worker.js; run npm run build");

const manifest = readJson(manifestPath);
for (const field of ["name", "version", "description", "skills", "mcpServers"]) {
  requireString(manifest, field);
}
if (manifest.name !== "opencode-plugin-codex") errors.push("plugin name must be opencode-plugin-codex");
/** Tags pointing at HEAD: a release commit is one that is about to be tagged. */
function tagsPointingAtHead() {
  try {
    return execFileSync("git", ["tag", "--points-at", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split("\n")
      .map((tag) => tag.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

const packageVersion = readJson(resolve("package.json")).version;
const versionIssues = releaseVersionIssues({
  manifestVersion: manifest.version,
  packageVersion,
  releaseTags: tagsPointingAtHead(),
  releaseEnv: process.env.OPENCODE_PLUGIN_RELEASE
});
errors.push(...versionIssues.errors);
for (const warning of versionIssues.warnings) console.warn(warning);
if (manifest.skills !== "./skills/") errors.push("skills must point to ./skills/");
if (manifest.mcpServers !== "./.mcp.json") errors.push("mcpServers must point to ./.mcp.json");
if (!manifest.interface?.defaultPrompt?.length) errors.push("interface.defaultPrompt is required");
for (const field of ["displayName", "shortDescription", "longDescription", "developerName", "category"]) {
  if (typeof manifest.interface?.[field] !== "string" || !manifest.interface[field].trim()) {
    errors.push(`plugin.json requires non-empty interface.${field}`);
  }
}
if (typeof manifest.author?.name !== "string" || !manifest.author.name.trim()) {
  errors.push("plugin.json requires non-empty author.name");
}
if (JSON.stringify(manifest).includes("[TODO:")) errors.push("plugin.json must not contain TODO placeholders");

const mcp = readJson(mcpPath);
const server = mcp.mcpServers?.["opencode-plugin-codex"];
if (!server) errors.push(".mcp.json must define opencode-plugin-codex server");
if (server?.command !== "node") errors.push("MCP server command must be node");
if (!server?.args?.includes("./dist/server.js")) errors.push("MCP server must launch ./dist/server.js");
if (!server?.env_vars?.includes("OPENCODE_WORKSPACE_ROOTS")) {
  errors.push("MCP server must pass OPENCODE_WORKSPACE_ROOTS to support explicit ephemeral workspace roots");
}

const skill = existsSync(skillPath) ? readFileSync(skillPath, "utf8") : "";
if (!skill.startsWith("---\n")) errors.push("skill must start with YAML frontmatter");
if (!skill.includes("name: opencode")) errors.push("skill frontmatter must name opencode");

if (errors.length) {
  console.error("Plugin validation failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Repository plugin validation passed: ${root} (run the current plugin-creator validator as the release authority)`);
