import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkVersion, nsisArtifactName, repoRoot } from './check-version.mjs';

const SCRIPT = fileURLToPath(new URL('./check-version.mjs', import.meta.url));
const ARTIFACT = 'RulZ-Kinspora-Setup-${version}.${ext}';
const REPO_VERSION = JSON.parse(
  readFileSync(join(repoRoot(), 'apps', 'desktop', 'package.json'), 'utf8'),
).version;
if (typeof REPO_VERSION !== 'string' || REPO_VERSION.length === 0) {
  throw new Error('apps/desktop/package.json has no version');
}

/**
 * @param {{ desktop?: unknown, root?: unknown, yaml?: string }} files
 * @param {(root: string) => void} run
 */
function withFixture(files, run) {
  const root = mkdtempSync(join(tmpdir(), 'rulz-version-'));
  try {
    mkdirSync(join(root, 'apps', 'desktop'), { recursive: true });
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ version: files.root === undefined ? '0.1.0' : files.root }),
    );
    writeFileSync(
      join(root, 'apps', 'desktop', 'package.json'),
      JSON.stringify({ version: files.desktop === undefined ? '0.1.0' : files.desktop }),
    );
    writeFileSync(
      join(root, 'apps', 'desktop', 'electron-builder.yml'),
      files.yaml ?? `nsis:\n  artifactName: ${ARTIFACT}\n`,
    );
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * @param {string} root
 * @param {string | undefined} tag
 */
function check(root, tag) {
  return tag === undefined ? checkVersion({ root }) : checkVersion({ root, tag });
}

describe('checkVersion', () => {
  it('accepts agreeing versions and an installer name that uses ${version}', () => {
    withFixture({}, (root) => {
      expect(check(root)).toEqual({ version: '0.1.0', artifactName: ARTIFACT });
      expect(check(root, 'v0.1.0')).toEqual({ version: '0.1.0', artifactName: ARTIFACT });
    });
  });

  it('accepts a quoted artifact name and Windows line endings', () => {
    withFixture(
      {
        yaml: 'nsis:\r\n  oneClick: false\r\n  artifactName: "RulZ-Kinspora-Setup-${version}.${ext}"\r\n',
      },
      (root) => {
        expect(check(root).artifactName).toBe(ARTIFACT);
      },
    );
  });

  it('accepts a prerelease when the tag carries the same text', () => {
    withFixture({ desktop: '1.2.3-beta.1', root: '1.2.3-beta.1' }, (root) => {
      expect(check(root, 'v1.2.3-beta.1').version).toBe('1.2.3-beta.1');
    });
  });

  it('fails when the root version differs', () => {
    withFixture({ root: '0.2.0' }, (root) => {
      expect(() => check(root)).toThrow(/package\.json version "0\.2\.0" does not match/);
    });
  });

  it('fails when the tag is not v plus the desktop version', () => {
    withFixture({}, (root) => {
      expect(() => check(root, 'v0.1.1')).toThrow(/tag "v0\.1\.1"/);
      expect(() => check(root, '0.1.0')).toThrow(/tag "0\.1\.0"/);
      expect(() => check(root, 'V0.1.0')).toThrow(/tag "V0\.1\.0"/);
    });
  });

  it('fails when a version is not semver', () => {
    withFixture({ desktop: '0.1', root: '0.1' }, (root) => {
      expect(() => check(root)).toThrow(/apps\/desktop\/package\.json version must be a semver/);
    });
  });

  it('fails when the installer name bakes in a version', () => {
    withFixture({ yaml: 'nsis:\n  artifactName: RulZ-Kinspora-Setup-0.1.0.exe\n' }, (root) => {
      expect(() => check(root)).toThrow(/nsis\.artifactName must use \$\{version\}/);
    });
  });

  it('fails when artifactName is missing or not under nsis', () => {
    withFixture({ yaml: 'nsis:\n  oneClick: false\n' }, (root) => {
      expect(() => check(root)).toThrow(/no nsis\.artifactName/);
    });
    withFixture(
      { yaml: 'artifactName: RulZ-Kinspora-Setup-${version}.${ext}\nnsis:\n  oneClick: false\n' },
      (root) => {
        expect(() => check(root)).toThrow(/no nsis\.artifactName/);
      },
    );
  });

  it('ignores a comment and still reads the nsis name', () => {
    expect(
      nsisArtifactName(
        '# artifactName: forgotten\nnsis:\n  # artifactName: also no\n  artifactName: App-${version}.exe # kept\n\n# after\npublish:\n  provider: github\n',
      ),
    ).toBe('App-${version}.exe');
  });

  it('accepts this repository with no tag, and with its own tag', () => {
    const root = repoRoot();
    expect(check(root)).toEqual({ version: REPO_VERSION, artifactName: ARTIFACT });
    expect(check(root, `v${REPO_VERSION}`).version).toBe(REPO_VERSION);
    expect(() => check(root, 'v9.9.9')).toThrow(/tag "v9\.9\.9"/);
  });

  it('exits 0 for this repository when no tag is given', () => {
    const result = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`version ${REPO_VERSION}\n`);
  });

  it('exits non-zero when the tag disagrees or two tags are passed', () => {
    const bad = spawnSync(process.execPath, [SCRIPT, 'v9.9.9'], { encoding: 'utf8' });
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toMatch(/tag "v9\.9\.9"/);
    const tag = `v${REPO_VERSION}`;
    const extra = spawnSync(process.execPath, [SCRIPT, tag, tag], { encoding: 'utf8' });
    expect(extra.status).not.toBe(0);
    expect(extra.stderr).toMatch(/pass one tag/);
  });
});
