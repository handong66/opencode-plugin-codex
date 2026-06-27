#!/usr/bin/env node
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { build } from "esbuild";

const outfile = "plugins/opencode-plugin-codex/dist/server.js";

await rm(dirname(outfile), { recursive: true, force: true });
await mkdir(dirname(outfile), { recursive: true });

await build({
  entryPoints: ["plugins/opencode-plugin-codex/src/server.ts"],
  outfile,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  minify: true,
  legalComments: "none",
  logLevel: "info"
});
