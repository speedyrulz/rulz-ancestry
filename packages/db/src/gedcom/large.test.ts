import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { countPersons, updateName } from '../persons';
import { searchPersons } from '../search';
import { cleanUpAfterEach, memoryTree, tempDir, track } from '../testing';
import { createTree } from '../tree';
import { exportGedcom } from './export';
import { importGedcomFile } from './import';
import {
  EXPORT_DEFAULTS,
  ancestryStyleFile,
  bodyOf,
  firstDifference,
  importText,
  inputOf,
} from './testing';

cleanUpAfterEach();

/**
 * The test Phase 1 of the plan is measured by: a 10,000-person file in
 * Ancestry's style imports in under 10 seconds and comes back out with no
 * difference.
 */
describe('a 10,000-person file written the way Ancestry writes them', () => {
  const PEOPLE = 10_000;
  const original = ancestryStyleFile(PEOPLE);
  const originalLines = original.split('\r\n').slice(0, -1);

  it('imports in under 10 seconds and exports with no difference', { timeout: 120_000 }, () => {
    // The real thing: a file on disk, read into a tree on disk.
    const dir = tempDir();
    const path = join(dir, 'ancestry.ged');
    writeFileSync(path, original);
    const tree = track(createTree(join(dir, 'Tree'), { name: 'Tree' }));

    // Reading, decoding and parsing are part of what the user waits for, so they are timed too.
    const started = performance.now();
    const report = importGedcomFile(tree, path);
    const importMs = performance.now() - started;

    expect(report.persons).toBe(PEOPLE);
    expect(report.issues).toEqual([]);
    expect(countPersons(tree)).toBe(PEOPLE);
    expect(report.names).toBe(PEOPLE);
    expect(report.events).toBeGreaterThan(PEOPLE * 2);
    expect(report.keptRecords).toEqual({ SUBM: 1, REPO: 1 });
    expect(report.sources).toBe(20);
    // One portrait, which every tenth person points at.
    expect(report.media).toBe(1);
    expect(report.mediaHeld).toBe(0);
    expect(tree.db.prepare('SELECT count(*) FROM media_link').pluck().get()).toBe(PEOPLE / 10);
    // Each person's name and birth cite the same census entry: one citation, two links.
    expect(report.citations).toBe(PEOPLE);
    expect(tree.db.prepare('SELECT count(*) FROM citation_link').pluck().get()).toBe(PEOPLE * 2);
    expect(importMs).toBeLessThan(10_000);
    // Nothing went into the change log, which would have doubled the work.
    expect(tree.db.prepare('SELECT count(*) FROM change_log').pluck().get()).toBe(0);

    const exportStarted = performance.now();
    const result = exportGedcom(tree, EXPORT_DEFAULTS);
    const exportMs = performance.now() - exportStarted;
    expect(result.persons).toBe(PEOPLE);
    expect(exportMs).toBeLessThan(10_000);

    const exported = result.text.split('\r\n').slice(0, -1);
    // Every line after the header is the same as in the original file.
    expect(firstDifference(bodyOf(exported), bodyOf(originalLines))).toBeNull();
    expect(bodyOf(exported).length).toBeGreaterThan(200_000);

    console.info(
      `10,000-person GEDCOM: ${originalLines.length.toLocaleString('en')} lines, ` +
        `import ${Math.round(importMs)} ms, export ${Math.round(exportMs)} ms`,
    );
  });

  it('changes one line of the export when one name is edited', { timeout: 120_000 }, () => {
    const tree = memoryTree();
    importText(tree, original);
    const person = searchPersons(tree, 'John A Surname0')[0];
    expect(person).toBeDefined();
    if (!person) return;
    const name = tree.db
      .prepare('SELECT id, nickname FROM person_name WHERE person_id = ?')
      .get(person.id) as { id: string };
    updateName(tree, name.id, { nickname: 'Jack' });

    const exported = exportGedcom(tree, EXPORT_DEFAULTS).text.split('\r\n').slice(0, -1);
    const before = bodyOf(originalLines);
    const after = bodyOf(exported);
    expect(after).toHaveLength(before.length + 1);
    const added = after.findIndex((line, index) => line !== before[index]);
    expect(after[added]).toBe('2 NICK Jack');
    expect(after.slice(added + 1)).toEqual(before.slice(added));
  });

  it('reads the file the same way twice', () => {
    // The generator and the parser are both deterministic; a failure here
    // would mean one of them depends on something outside the file.
    const first = inputOf(original).document;
    const second = inputOf(ancestryStyleFile(PEOPLE)).document;
    expect(second.records.length).toBe(first.records.length);
    expect(second.lineCount).toBe(first.lineCount);
  });
});
