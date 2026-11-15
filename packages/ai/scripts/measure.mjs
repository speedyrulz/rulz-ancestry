// Measures what an AI proposes, on the labelled made-up cases that the engine
// of the app is measured on (src/measure.ts). Run it from Git Bash or any
// shell, in the repository, with plain node:
//
//   node packages/ai/scripts/measure.mjs export <folder> [--seed N] [--records N]
//     --records is about how many records (default 90); every person has at
//     least two, so a request of fewer than 2 is raised to 2.
//     Writes blind.md (give this to the AI: made-up people, their records,
//     the instructions and the form of an answer, no label) and key.json
//     (the labels, keep it away from the AI) into <folder>.
//
//   node packages/ai/scripts/measure.mjs score <folder> <answers file>
//     Holds the AI's answers (a JSON list, alone, in a code fence or among
//     prose) against <folder>/key.json, prints the report with the AI's
//     figures beside the engine's, and writes it as <folder>/report.md.
//
// Nothing is written but into <folder>, which is given by you. The sources
// are TypeScript without file extensions, which plain node cannot import, so
// src/measure.ts is bundled first (with rolldown, which vite brings) into a
// temporary file that is removed afterwards.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { rolldown } from 'rolldown';

const here = dirname(fileURLToPath(import.meta.url));

async function load() {
  const bundle = await rolldown({
    input: resolve(here, '..', 'src', 'measure.ts'),
    platform: 'node',
    logLevel: 'warn',
  });
  const temp = mkdtempSync(join(tmpdir(), 'rulz-measure-'));
  try {
    await bundle.write({ dir: temp, format: 'esm', entryFileNames: 'measure.mjs' });
    return await import(pathToFileURL(join(temp, 'measure.mjs')).href);
  } finally {
    await bundle.close();
    rmSync(temp, { recursive: true, force: true });
  }
}

const USAGE = `Usage:
  node packages/ai/scripts/measure.mjs export <folder> [--seed N] [--records N]
  node packages/ai/scripts/measure.mjs score <folder> <answers file>`;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function numberOption(args, name) {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  const value = Number(args[at + 1]);
  if (!Number.isInteger(value) || value < 1) fail(`${name} needs a whole number from 1.`);
  return value;
}

const [command, folder, ...rest] = process.argv.slice(2);
if (folder === undefined || (command !== 'export' && command !== 'score')) fail(USAGE);
const dir = resolve(folder);

if (command === 'export') {
  const measure = await load();
  const options = {};
  const seed = numberOption(rest, '--seed');
  const records = numberOption(rest, '--records');
  if (seed !== undefined) options.seed = seed;
  if (records !== undefined) options.records = records;
  const { text, key } = measure.blindSet(options);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'blind.md'), text, 'utf8');
  writeFileSync(join(dir, 'key.json'), `${JSON.stringify(key, null, 2)}\n`, 'utf8');
  console.log(
    `Wrote ${key.records.length} records of ${key.people} people to ${join(dir, 'blind.md')}, and the key to ${join(dir, 'key.json')}.`,
  );
  if (records !== undefined && records < measure.MIN_RECORDS) {
    console.log(
      `--records ${records} is below the least, ${measure.MIN_RECORDS}: raised to ${measure.MIN_RECORDS}.`,
    );
  }
  console.log('Give blind.md to the AI and keep key.json away from it.');
} else {
  const [answersFile] = rest;
  if (answersFile === undefined) fail(USAGE);
  const measure = await load();
  const key = JSON.parse(readFileSync(join(dir, 'key.json'), 'utf8'));
  let report;
  try {
    report = measure.reportOf(
      measure.scoreAnswers(key, readFileSync(resolve(answersFile), 'utf8')),
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  writeFileSync(join(dir, 'report.md'), report, 'utf8');
  console.log(report);
  console.log(`Written to ${join(dir, 'report.md')}.`);
}
