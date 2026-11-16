// Writes the notes of one version from docs/RELEASE-NOTES.md to a file, for the
// GitHub Release body. A version must have its own "## <version>" section; the
// section runs to the next "## " heading.
//
//   node tools/ship/release-notes.mjs 0.9.0 out.md
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoRoot } from './check-version.mjs';

/**
 * @param {string} text the whole notes file
 * @param {string} version e.g. 0.9.0
 * @returns {string} the section's body, without its heading
 */
export function notesFor(text, version) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${version}`);
  if (start < 0) throw new Error(`docs/RELEASE-NOTES.md has no "## ${version}" section.`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i] ?? '')) {
      end = i;
      break;
    }
  }
  const body = lines
    .slice(start + 1, end)
    .join('\n')
    .trim();
  if (body === '')
    throw new Error(`The "## ${version}" section of docs/RELEASE-NOTES.md is empty.`);
  return `${body}\n`;
}

const entry = process.argv[1];
if (
  entry &&
  resolve(entry).toLowerCase() === resolve(fileURLToPath(import.meta.url)).toLowerCase()
) {
  const [version, out] = process.argv.slice(2);
  if (!version) {
    console.error('usage: node tools/ship/release-notes.mjs <version> [out.md]');
    process.exit(2);
  }
  try {
    const notes = notesFor(
      readFileSync(join(repoRoot(), 'docs', 'RELEASE-NOTES.md'), 'utf8'),
      version,
    );
    if (out) writeFileSync(out, notes);
    else process.stdout.write(notes);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
