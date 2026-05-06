/**
 * Coordinated version bump for Obsidian plugin release.
 *
 * Run via `npm version <patch|minor|major>` — npm will set the new version in
 * package.json and expose it as `process.env.npm_package_version`. This script
 * then propagates the bump into manifest.json and versions.json so all three
 * files stay in lockstep.
 *
 * Without coordination, BRAT and Obsidian's plugin loader produce confusing
 * errors at install time. See docs/04_MANIFEST_JSON.md "Coordinated files".
 *
 * @example
 *   npm version patch     // → 0.1.0 -> 0.1.1, syncs manifest.json + versions.json
 */
import { readFileSync, writeFileSync } from 'node:fs';

const targetVersion = process.env.npm_package_version;
if (!targetVersion) {
  throw new Error(
    'version-bump: npm_package_version is not set. ' +
      'Run via `npm version <patch|minor|major>`, not directly with `node`.',
  );
}

const manifestPath = 'manifest.json';
const versionsPath = 'versions.json';

const manifestRaw = readFileSync(manifestPath, 'utf8');
const manifest = JSON.parse(manifestRaw);
const minAppVersion = manifest.minAppVersion;
if (typeof minAppVersion !== 'string' || minAppVersion.length === 0) {
  throw new Error(
    `version-bump: manifest.json is missing a valid "minAppVersion" string. Got: ${JSON.stringify(
      minAppVersion,
    )}`,
  );
}

manifest.version = targetVersion;
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

const versions = JSON.parse(readFileSync(versionsPath, 'utf8'));
versions[targetVersion] = minAppVersion;
writeFileSync(versionsPath, JSON.stringify(versions, null, 2) + '\n');

console.log(
  `version-bump: ${targetVersion} → manifest.json (minAppVersion ${minAppVersion}) + versions.json`,
);
