#!/usr/bin/env node
import { mkdir, rm } from "node:fs/promises";
import { build } from "esbuild";

const outdir = "plugins/opencode-plugin-codex/dist";

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await build({
  entryPoints: {
    server: "plugins/opencode-plugin-codex/src/server.ts",
    "job-worker": "plugins/opencode-plugin-codex/src/job-worker.ts"
  },
  outdir,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  minify: true,
  legalComments: "none",
  logLevel: "info"
});
