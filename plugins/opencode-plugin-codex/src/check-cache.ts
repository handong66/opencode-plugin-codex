import { runOpenCode } from "./opencode-cli.js";
import { stripAnsi } from "./ansi.js";

/**
 * `opencode_check` ran 471 times in two months — 124 of them on 2026-08-12 alone —
 * and 456 returned the same thing: the same binary, the same version, the same
 * provider banner. Every one of those re-walked the discovery candidates and re-ran
 * `opencode providers list`, and each response carried raw ANSI escapes.
 *
 * The cache lives for the MCP server process. There is no TTL: the answer changes
 * when the user edits their OpenCode configuration or installs a CLI, neither of
 * which a timer can predict, so `force: true` is the escape hatch and the response
 * says when the cached answer was taken.
 */
export type ProviderListing = {
  /** Cleaned lines of the CLI's own output: ANSI escapes removed, blanks dropped. */
  lines: string[];
  /** Provider ids parsed out of those lines, in the CLI's own spelling. */
  ids: string[];
  exitCode: number | null;
  raw: string;
  cachedAt: string;
};

export type CachedProviders = ProviderListing & { cacheHit: boolean };

/**
 * A provider id, not a provider's display name.
 *
 * `opencode providers list` (1.18.16) prints a credentials banner of display names:
 *
 *     ┌  Credentials ~/.local/share/opencode/auth.json
 *     ●  AIHubMix api
 *     ●  DeepSeek api
 *     └  2 credentials
 *
 * The ids there are `aihubmix` and `deepseek`. Accepting any first token as an id
 * made "2" a provider in that output, and on a format that drops the bullet it
 * would make "AIHubMix" one — which is worse than useless downstream, because the
 * case guard would then refuse `aihubmix/...` and demand the spelling that ran five
 * jobs and succeeded zero times. Ids are lowercase, so only a lowercase,
 * letter-initial token is claimed as one. Nothing is ever lowercased to fit: a
 * display name is simply not reported as an id.
 */
const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9._-]+$/;

/** Box-drawing and bullet glyphs the CLI uses to draw its list. */
const LIST_DECORATION = /^[\s│├└┌┐┘─◇◆●○▪•*-]+/u;

/**
 * Turn CLI list output into lines and ids.
 *
 * Deliberately shallow: the lines are the CLI's own, with escapes removed, and an
 * id is only taken from a line whose first token already looks like an id. Guessing
 * more structure than the CLI documents is how a caller ends up trusting a parse
 * that silently goes empty on the next release.
 */
export function parseListOutput(raw: string): { lines: string[]; ids: string[] } {
  const lines = stripAnsi(raw)
    .split(/\r?\n/)
    .map((line) => line.replace(LIST_DECORATION, "").trim())
    .filter((line) => line.length > 0);
  const ids: string[] = [];
  for (const line of lines) {
    const token = line.split(/\s+/)[0];
    if (token && PROVIDER_ID_PATTERN.test(token) && !ids.includes(token)) ids.push(token);
  }
  return { lines, ids };
}

type CacheKey = string;

const providerCache = new Map<CacheKey, ProviderListing>();
const modelCache = new Map<CacheKey, ProviderListing>();
const MAX_CACHE_ENTRIES = 32;

/** Exposed for tests and for `opencode_check`'s explicit refresh. */
export function resetCheckCache(): void {
  providerCache.clear();
  modelCache.clear();
}

/**
 * The provider ids `opencode_check` last enumerated in this process, if any.
 *
 * Used to fail an obviously misspelled provider fast instead of spending a job on
 * it: `AIHubMix/...` ran five jobs and succeeded zero times, while `aihubmix/...`
 * ran 62 and succeeded 50. Nothing is ever rewritten silently.
 */
export function knownProviderIds(): string[] {
  const ids = new Set<string>();
  for (const listing of providerCache.values()) for (const id of listing.ids) ids.add(id);
  return [...ids];
}

async function cachedListing(
  cache: Map<CacheKey, ProviderListing>,
  key: CacheKey,
  force: boolean | undefined,
  run: () => Promise<{ stdout: string; stderr: string; exitCode: number | null }>
): Promise<CachedProviders> {
  if (!force) {
    const hit = cache.get(key);
    if (hit) return { ...hit, cacheHit: true };
  }
  const result = await run();
  const raw = result.stdout || result.stderr;
  const listing: ProviderListing = {
    ...parseListOutput(raw),
    exitCode: result.exitCode,
    raw: stripAnsi(raw),
    cachedAt: new Date().toISOString()
  };
  if (cache.size >= MAX_CACHE_ENTRIES) cache.clear();
  cache.set(key, listing);
  return { ...listing, cacheHit: false };
}

export async function listProviders(options: {
  opencodeBin: string;
  cwd: string;
  force?: boolean;
}): Promise<CachedProviders> {
  return await cachedListing(
    providerCache,
    `${options.opencodeBin} ${options.cwd}`,
    options.force,
    async () =>
      await runOpenCode(["providers", "list"], {
        cwd: options.cwd,
        opencodeBin: options.opencodeBin,
        timeoutMs: 30_000
      })
  );
}

export async function listModels(options: {
  opencodeBin: string;
  cwd: string;
  provider: string;
  force?: boolean;
}): Promise<CachedProviders> {
  return await cachedListing(
    modelCache,
    `${options.opencodeBin} ${options.cwd} ${options.provider}`,
    options.force,
    async () =>
      await runOpenCode(["models", options.provider], {
        cwd: options.cwd,
        opencodeBin: options.opencodeBin,
        timeoutMs: 30_000
      })
  );
}
