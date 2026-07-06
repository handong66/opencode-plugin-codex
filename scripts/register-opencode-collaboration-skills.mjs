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
const includeSecurity = process.env.OPENCODE_REGISTER_SECURITY_SKILLS === "1";
const strict = process.env.OPENCODE_REGISTER_STRICT === "1";

const directCodexSkillDirs = [
  {
    group: "collaboration",
    dir: join(codexHome, "skills/codex-opencode-collaboration"),
  },
  {
    group: "pua",
    dir: join(codexHome, "pua/skills/pua"),
  },
  {
    group: "frontend",
    dir: join(codexHome, "skills/playwright"),
  },
];

const defaultDiscoverableCodexSkills = [
  { group: "frontend", name: "frontend-testing-debugging" },
  { group: "web-best-practices", name: "react-best-practices" },
  { group: "web-best-practices", name: "supabase-postgres-best-practices" },
  { group: "documents", name: "documents" },
  { group: "documents", name: "pdf" },
  { group: "documents", name: "Spreadsheets" },
];

const securityCodexSkills = [
  { group: "security", name: "security-diff-scan" },
  { group: "security", name: "threat-model" },
  { group: "security", name: "validation" },
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

function skillSearchRoots() {
  return [
    join(codexHome, "skills"),
    join(codexHome, "pua", "skills"),
    join(codexHome, "plugins", "cache"),
  ];
}

function findCodexSkillDirByName(name) {
  const matches = [];
  const roots = skillSearchRoots().filter((root) => existsSync(root));
  const rootDepths = new Map(roots.map((root) => [root, root.split("/").length]));
  const stack = [...roots];

  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    const skillMd = join(current, "SKILL.md");
    if (existsSync(skillMd) && readSkillName(skillMd) === name) {
      matches.push(current);
      continue;
    }

    const currentRoot = roots.find((root) => current === root || current.startsWith(`${root}/`));
    const maxDepth = currentRoot ? rootDepths.get(currentRoot) + 8 : undefined;
    if (maxDepth !== undefined && current.split("/").length >= maxDepth) continue;

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      stack.push(join(current, entry.name));
    }
  }

  return matches.sort().at(-1) ?? null;
}

function collectCodexSkillDirs() {
  const discoverable = [
    ...defaultDiscoverableCodexSkills,
    ...(includeSecurity ? securityCodexSkills : []),
  ];
  const discovered = discoverable.map((skill) => ({
    group: skill.group,
    dir: findCodexSkillDirByName(skill.name) ?? join(codexHome, "missing", skill.name),
  }));
  return [...directCodexSkillDirs, ...discovered];
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

const candidates = [...(includeSuperpowers ? collectSuperpowersSkillDirs() : []), ...collectCodexSkillDirs()];
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
      skippedSecurity: includeSecurity
        ? false
        : "default; set OPENCODE_REGISTER_SECURITY_SKILLS=1 only for explicit OpenCode security-scan workflows",
      skippedSuperpowers: includeSuperpowers
        ? false
        : "default; set OPENCODE_REGISTER_SUPERPOWERS=1 only if OpenCode is not already loading Superpowers"
    },
    null,
    2
  )
);
