#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";

const root = resolve("plugins/opencode-plugin-codex");
const manifestPath = join(root, ".codex-plugin", "plugin.json");
const mcpPath = join(root, ".mcp.json");
const skillPath = join(root, "skills", "opencode", "SKILL.md");
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

const manifest = readJson(manifestPath);
for (const field of ["name", "version", "description", "skills", "mcpServers"]) {
  requireString(manifest, field);
}
if (manifest.name !== "opencode-plugin-codex") errors.push("plugin name must be opencode-plugin-codex");
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(manifest.version ?? "")) {
  errors.push("plugin version must be semver");
}
if (manifest.skills !== "./skills/") errors.push("skills must point to ./skills/");
if (manifest.mcpServers !== "./.mcp.json") errors.push("mcpServers must point to ./.mcp.json");
if (!manifest.interface?.defaultPrompt?.length) errors.push("interface.defaultPrompt is required");

const mcp = readJson(mcpPath);
const server = mcp.mcpServers?.["opencode-plugin-codex"];
if (!server) errors.push(".mcp.json must define opencode-plugin-codex server");
if (server?.command !== "node") errors.push("MCP server command must be node");
if (!server?.args?.includes("./dist/server.js")) errors.push("MCP server must launch ./dist/server.js");

const skill = existsSync(skillPath) ? readFileSync(skillPath, "utf8") : "";
if (!skill.startsWith("---\n")) errors.push("skill must start with YAML frontmatter");
if (!skill.includes("name: opencode")) errors.push("skill frontmatter must name opencode");

if (errors.length) {
  console.error("Plugin validation failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Plugin validation passed: ${root}`);
