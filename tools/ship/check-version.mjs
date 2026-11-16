// One version for a release: apps/desktop/package.json. The root package.json
// must carry the same version, a tag must be that version with a leading v,
// and the installer file name must be built from ${version}.
//
//   node tools/ship/check-version.mjs
//   node tools/ship/check-version.mjs v1.2.3
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export class VersionCheckError extends Error {
  /**
   * @param {string[]} messages
   */
  constructor(messages) {
    super(messages.join('\n'));
    this.name = 'VersionCheckError';
    this.messages = messages;
  }
}

/** Repository root, two folders above this file. */
export function repoRoot(scriptUrl = import.meta.url) {
  return join(dirname(fileURLToPath(scriptUrl)), '..', '..');
}

/**
 * @param {{ root: string, tag?: string }} input
 * @returns {{ version: string, artifactName: string }}
 */
export function checkVersion({ root, tag }) {
  /** @type {string[]} */
  const problems = [];
  const desktopVersion = readVersion(
    join(root, 'apps', 'desktop', 'package.json'),
    'apps/desktop/package.json',
    problems,
  );
  const rootVersion = readVersion(join(root, 'package.json'), 'package.json', problems);
  if (desktopVersion !== undefined && rootVersion !== undefined && desktopVersion !== rootVersion) {
    problems.push(
      `package.json version ${JSON.stringify(rootVersion)} does not match apps/desktop/package.json version ${JSON.stringify(desktopVersion)}`,
    );
  }
  if (tag !== undefined) {
    const expected = desktopVersion === undefined ? undefined : `v${desktopVersion}`;
    if (tag !== expected) {
      problems.push(
        `tag ${JSON.stringify(tag)} does not match apps/desktop/package.json version ${desktopVersion === undefined ? '(unreadable)' : JSON.stringify(desktopVersion)}`,
      );
    }
  }

  let artifactName;
  const builderFile = join(root, 'apps', 'desktop', 'electron-builder.yml');
  try {
    artifactName = nsisArtifactName(readText(builderFile));
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  if (artifactName !== undefined && !artifactName.includes('${version}')) {
    problems.push(`nsis.artifactName must use \${version}, found ${JSON.stringify(artifactName)}`);
  }
  if (problems.length > 0 || artifactName === undefined || desktopVersion === undefined) {
    throw new VersionCheckError(
      problems.length > 0 ? problems : ['the version sources do not agree'],
    );
  }
  return { version: desktopVersion, artifactName };
}

/**
 * The nsis.artifactName scalar. Throws when the block does not have exactly one.
 * @param {string} text
 */
export function nsisArtifactName(text) {
  const lines = text.split(/\r?\n/);
  let inNsis = false;
  let nsisIndent = 0;
  /** @type {string[]} */
  const found = [];
  for (const line of lines) {
    if (!inNsis) {
      const heading = /^([ \t]*)nsis:[ \t]*(?:#.*)?$/.exec(line);
      if (heading) {
        inNsis = true;
        nsisIndent = heading[1].length;
      }
      continue;
    }
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const indent = /^([ \t]*)/.exec(line)?.[1].length ?? 0;
    if (indent <= nsisIndent) break;
    const match = /^[ \t]*artifactName:[ \t]*(.*?)[ \t]*$/.exec(stripTrailingComment(line));
    if (match) found.push(unquote(match[1].trim()));
  }
  if (found.length !== 1) {
    throw new Error(
      found.length === 0
        ? 'electron-builder.yml has no nsis.artifactName'
        : `electron-builder.yml has ${found.length} nsis.artifactName entries`,
    );
  }
  return found[0];
}

/** @param {string} line */
function stripTrailingComment(line) {
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quote) {
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '#' && (i === 0 || line[i - 1] === ' ' || line[i - 1] === '\t')) {
      return line.slice(0, i).trimEnd();
    }
  }
  return line;
}

/** @param {string} value */
function unquote(value) {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/**
 * @param {string} file
 * @param {string} label
 * @param {string[]} problems
 */
function readVersion(file, label, problems) {
  let parsed;
  try {
    parsed = JSON.parse(readText(file));
  } catch (error) {
    const missing = error instanceof Error && 'code' in error && error.code === 'ENOENT';
    problems.push(
      missing
        ? `${label} is missing`
        : `${label} cannot be read (${error instanceof Error ? error.message : error})`,
    );
    return undefined;
  }
  const version = parsed.version;
  if (typeof version !== 'string' || !SEMVER.test(version)) {
    problems.push(`${label} version must be a semver like 1.2.3, found ${JSON.stringify(version)}`);
    return undefined;
  }
  return version;
}

/** @param {string} file */
function readText(file) {
  return readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
}

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  return resolve(entry).toLowerCase() === resolve(fileURLToPath(import.meta.url)).toLowerCase();
}

if (isDirectRun()) {
  if (process.argv.length > 3) {
    process.stderr.write('pass one tag, or none\n');
    process.exitCode = 1;
  } else {
    const tag = process.argv[2];
    try {
      const result = checkVersion({
        root: repoRoot(),
        ...(tag === undefined ? {} : { tag }),
      });
      process.stdout.write(`version ${result.version}\n`);
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  }
}
