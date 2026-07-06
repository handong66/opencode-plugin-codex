#!/usr/bin/env node
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const home = homedir();
const configSkillsDir = join(home, ".config", "opencode", "skills");
const openCodePackageCacheRoot = join(home, ".cache", "opencode", "packages");
const codexHome = join(home, ".codex");
const includeSuperpowers = process.env.OPENCODE_REGISTER_SUPERPOWERS === "1";
const strict = process.env.OPENCODE_REGISTER_STRICT === "1";

const codexSkillDirs = [
  {
    group: "collaboration",
    dir: join(codexHome, "skills/codex-opencode-collaboration"),
  },
  {
    group: "pua",
    dir: join(codexHome, "pua/skills/pua"),
  },
  {
    group: "security",
    dir: join(
      codexHome,
      "plugins/cache/openai-curated-remote/codex-security/0.1.10/skills/security-diff-scan",
    ),
  },
  {
    group: "security",
    dir: join(codexHome, "plugins/cache/openai-curated-remote/codex-security/0.1.10/skills/threat-model"),
  },
  {
    group: "security",
    dir: join(codexHome, "plugins/cache/openai-curated-remote/codex-security/0.1.10/skills/validation"),
  },
  {
    group: "frontend",
    dir: join(codexHome, "skills/playwright"),
  },
  {
    group: "frontend",
    dir: join(codexHome, "plugins/cache/openai-curated/build-web-apps/d6169bef/skills/frontend-testing-debugging"),
  },
  {
    group: "web-best-practices",
    dir: join(codexHome, "plugins/cache/openai-curated/build-web-apps/d6169bef/skills/react-best-practices"),
  },
  {
    group: "web-best-practices",
    dir: join(codexHome, "plugins/cache/openai-curated/build-web-apps/d6169bef/skills/supabase-best-practices"),
  },
  {
    group: "documents",
    dir: join(codexHome, "plugins/cache/openai-primary-runtime/documents/26.630.12135/skills/documents"),
  },
  {
    group: "documents",
    dir: join(codexHome, "plugins/cache/openai-primary-runtime/pdf/26.630.12135/skills/pdf"),
  },
  {
    group: "documents",
    dir: join(codexHome, "plugins/cache/openai-primary-runtime/spreadsheets/26.630.12135/skills/spreadsheets"),
  },
];

function findSuperpowersSkillsDir() {
  if (!existsSync(openCodePackageCacheRoot)) return null;

  const stack = [openCodePackageCacheRoot];
  const matches = [];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = join(current, entry.name);
      if (!entry.isDirectory()) continue;
      if (entry.name === "node_modules") {
        const candidate = join(fullPath, "superpowers", "skills");
        if (existsSync(candidate)) matches.push(candidate);
      }
      if (fullPath.split("/").length - openCodePackageCacheRoot.split("/").length < 6) {
        stack.push(fullPath);
      }
    }
  }

  return matches.sort().at(-1) ?? null;
}

function readSkillName(skillMd) {
  const content = readFileSync(skillMd, "utf8");
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const nameLine = match[1].split(/\r?\n/).find((line) => line.startsWith("name:"));
  return nameLine?.slice("name:".length).trim().replace(/^["']|["']$/g, "") || null;
}

function collectSuperpowersSkillDirs() {
  const sourceSkillsDir = process.env.SUPERPOWERS_SKILLS_DIR
    ? resolve(process.env.SUPERPOWERS_SKILLS_DIR)
    : findSuperpowersSkillsDir();

  if (!sourceSkillsDir || !existsSync(sourceSkillsDir)) {
    throw new Error("Could not find installed Superpowers skills directory.");
  }

  const dirs = [];
  for (const entry of readdirSync(sourceSkillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    dirs.push({ group: "superpowers", dir: join(sourceSkillsDir, entry.name) });
  }
  return dirs;
}

function describeTarget(skillDir) {
  const skillMd = join(skillDir, "SKILL.md");
  if (!existsSync(skillMd)) {
    return { error: `${skillDir}: missing SKILL.md` };
  }
  const name = readSkillName(skillMd);
  if (!name) {
    return { error: `${skillDir}: missing name in SKILL.md frontmatter` };
  }
  return { name, skillMd };
}

function pathOrSymlinkExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function isSameTarget(linkPath, sourceDir) {
  try {
    return realpathSync(linkPath) === realpathSync(sourceDir);
  } catch {
    return resolve(dirname(linkPath), readlinkSync(linkPath)) === sourceDir;
  }
}

mkdirSync(configSkillsDir, { recursive: true });

const candidates = [...(includeSuperpowers ? collectSuperpowersSkillDirs() : []), ...codexSkillDirs];
const linked = [];
const already = [];
const conflicts = [];
const missing = [];

for (const candidate of candidates) {
  if (!existsSync(candidate.dir)) {
    missing.push(`${candidate.group}: ${candidate.dir}`);
    continue;
  }

  const target = describeTarget(candidate.dir);
  if (target.error) {
    conflicts.push(target.error);
    continue;
  }

  const targetDir = join(configSkillsDir, target.name);
  if (pathOrSymlinkExists(targetDir)) {
    const stat = lstatSync(targetDir);
    if (stat.isSymbolicLink() && isSameTarget(targetDir, candidate.dir)) {
      already.push({ group: candidate.group, name: target.name });
      continue;
    }
    conflicts.push(`${target.name}: target exists and does not point at ${candidate.dir}`);
    continue;
  }

  symlinkSync(candidate.dir, targetDir, "dir");
  linked.push({ group: candidate.group, name: target.name });
}

if (strict && (missing.length || conflicts.length)) {
  if (missing.length) {
    console.error("Missing skill source directories:");
    for (const item of missing) console.error(`- ${item}`);
  }
  if (conflicts.length) {
    console.error("Refusing to continue because of conflicts:");
    for (const conflict of conflicts) console.error(`- ${conflict}`);
  }
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      configSkillsDir,
      linked,
      already,
      missing,
      skippedConflicts: conflicts,
      skippedSuperpowers: includeSuperpowers
        ? false
        : "default; set OPENCODE_REGISTER_SUPERPOWERS=1 only if OpenCode is not already loading Superpowers"
    },
    null,
    2
  )
);
