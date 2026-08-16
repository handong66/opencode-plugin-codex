/**
 * Version rules shared by `npm run validate:plugin` and its test.
 *
 * The manifest may carry the author's local cachebuster (`+codex.<timestamp>`,
 * see docs/development.md "Refreshing an installed plugin") while developing, but
 * the release core in front of `+` must be the version that was actually built, and
 * a release commit must not carry the cachebuster at all: two shipped plugins were
 * tagged `0.2.1+codex.20260711160539` and `0.1.0+codex.20260710103034`, versions
 * that never matched their own package.json.
 */
export function releaseVersionIssues({ manifestVersion, packageVersion, releaseTags = [], releaseEnv }) {
  const errors = [];
  const warnings = [];
  const version = manifestVersion ?? "";

  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    errors.push("plugin version must be semver");
    return { errors, warnings };
  }

  const [releaseCore, buildMetadata] = version.split("+");
  if (releaseCore !== packageVersion) {
    errors.push(
      `plugin.json version ${version} advertises release ${releaseCore || "(none)"}, ` +
        `but the built code is package.json ${packageVersion}`
    );
  }
  if (buildMetadata === undefined) return { errors, warnings };

  if (!/^codex\.\d{8,}$/.test(buildMetadata)) {
    errors.push(`plugin version build metadata must be a codex cachebuster (+codex.<timestamp>), got +${buildMetadata}`);
    return { errors, warnings };
  }

  const isRelease = releaseTags.length > 0 || releaseEnv === "1";
  if (isRelease) {
    errors.push(
      `release commit must not carry the local cachebuster +${buildMetadata} ` +
        `(tags at HEAD: ${releaseTags.join(", ") || "none"}, OPENCODE_PLUGIN_RELEASE=${releaseEnv ?? "unset"}); ` +
        `set plugin.json version to ${packageVersion}`
    );
  } else {
    warnings.push(
      `Note: plugin.json carries the local cachebuster +${buildMetadata}; drop it before cutting a release tag.`
    );
  }
  return { errors, warnings };
}
