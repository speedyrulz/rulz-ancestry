import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { addPersonFromDraft } from '../actions';
import { BACKUP_DIR_NAME, listBackups } from '../backup';
import { openDatabase } from '../connection';
import { deleteEvent, listFamilyEvents, listPersonEvents } from '../events';
import {
  MEDIA_DIR_NAME,
  addMediaFiles,
  deleteMedia,
  getMedia,
  isMediaPresent,
  linkMedia,
  listAllMedia,
  listMedia,
  mediaFilePath,
  unlinkMedia,
  updateMedia,
  type Media,
} from '../media';
import { mergePersons } from '../merge';
import { migrate, schemaVersion } from '../migrate';
import { treeMigrations } from '../schema';
import { listCitations } from '../sources';
import { cleanUpAfterEach, memoryTree, pngBytes, tempDir, track } from '../testing';
import { TREE_APPLICATION_ID, TREE_FILE_NAME, Tree, createTree, openExistingTree } from '../tree';
import { ZipReader, writeZip } from '../zip';
import { exportGedcom, exportGedcomFile } from './export';
import { GedcomFileError, importGedcom, importGedcomFile, readGedcomFile } from './import';
import { keptLinesOf, listStoredRecords } from './store';
import {
  EXPORT_DEFAULTS,
  ancestryStyleFile,
  bodyOf,
  exportLines,
  file,
  firstDifference,
  importText,
  inputOf,
  recordOf,
} from './testing';

cleanUpAfterEach();

/**
 * A file that names three pictures in every way a GEDCOM file can: a record
 * pointed at from a person and a family (M1), a record pointed at from an
 * event, a citation and a source (M2), and a photograph described in place
 * under both partners and their marriage.
 */
const PICTURED = file(
  '5.5.1',
  '0 @U1@ SUBM',
  '1 NAME Ann Lee',
  '0 @I1@ INDI',
  '1 NAME Ann /Lee/',
  '1 SEX F',
  '1 BIRT',
  '2 DATE 1 JAN 1900',
  '2 SOUR @S1@',
  '3 PAGE Page 4',
  '3 OBJE @M2@',
  '2 OBJE @M2@',
  '1 OBJE @M1@',
  '1 OBJE',
  '2 FILE photos/wedding.jpg',
  '3 FORM jpg',
  '2 TITL The wedding',
  '2 _PRIM Y',
  '1 FAMS @F1@',
  '0 @I2@ INDI',
  '1 NAME Tom /Lee/',
  '1 SEX M',
  '1 OBJE',
  '2 FILE photos/wedding.jpg',
  '3 FORM jpg',
  '2 TITL The wedding',
  '2 _PRIM Y',
  '1 OBJE @M9@',
  '1 FAMS @F1@',
  '0 @F1@ FAM',
  '1 HUSB @I2@',
  '1 WIFE @I1@',
  '1 MARR',
  '2 DATE 1921',
  '2 OBJE',
  '3 FILE photos/wedding.jpg',
  '4 FORM jpg',
  '3 TITL The wedding',
  '3 _PRIM Y',
  '1 OBJE @M1@',
  '0 @S1@ SOUR',
  '1 TITL Parish register',
  '1 OBJE @M2@',
  '0 @M1@ OBJE',
  '1 FILE C:\\Old PC\\Tree Media\\ann.png',
  '2 FORM png',
  '2 TITL Ann Lee',
  '1 NOTE In the garden',
  '0 @M2@ OBJE',
  '1 FILE https://example.com/scans/register-p4.jpg',
  '2 FORM jpg',
  '2 TITL Register, page 4',
  '1 _CREA 2015',
);
const PICTURED_LINES = PICTURED.split('\n').slice(0, -1);

interface Imported {
  tree: Tree;
  /** The id of the person, family, source or file with this cross-reference id. */
  id: (xref: string) => string;
  /** The photograph the file describes in place. */
  wedding: Media;
  birth: string;
  marriage: string;
}

function imported(tree = memoryTree(), text = PICTURED): Imported {
  importText(tree, text);
  const id = (xref: string) =>
    tree.db.prepare('SELECT id FROM gedcom_record WHERE xref = ?').pluck().get(xref) as string;
  const wedding = listMedia(tree, { type: 'person', id: id('I2') })[0];
  if (!wedding) throw new Error('the photograph written in place was not imported');
  return {
    tree,
    id,
    wedding,
    birth: listPersonEvents(tree, id('I1'))[0]?.id ?? '',
    marriage: listFamilyEvents(tree, id('F1'))[0]?.id ?? '',
  };
}

const titles = (media: readonly Media[]): string[] => media.map((item) => item.title);

/** Everything about pictures and documents that must not depend on how the rows were made. */
function mediaModel(tree: Tree): unknown {
  const db = tree.db;
  const xref = (id: string | null) =>
    id === null
      ? null
      : ((db.prepare('SELECT xref FROM gedcom_record WHERE id = ?').pluck().get(id) as
          string | undefined) ?? '?');
  const said = (mediaId: string) =>
    JSON.stringify(
      db
        .prepare(
          `SELECT sha256, ext, mime, size, file_name, title, description, origin
           FROM media WHERE id = ?`,
        )
        .get(mediaId),
    );
  interface LinkRow {
    media_id: string;
    sort_order: number;
    person_id: string | null;
    family_id: string | null;
    source_id: string | null;
    event: string | null;
    event_owner: string | null;
    citation: string | null;
  }
  const links = (
    db
      .prepare(
        `SELECT ml.media_id, ml.sort_order, ml.person_id, ml.family_id, ml.source_id,
                e.type AS event,
                (SELECT coalesce(ep.person_id, ep.family_id) FROM event_participant ep
                 WHERE ep.event_id = ml.event_id LIMIT 1) AS event_owner,
                c.page AS citation
         FROM media_link ml LEFT JOIN event e ON e.id = ml.event_id
           LEFT JOIN citation c ON c.id = ml.citation_id`,
      )
      .all() as LinkRow[]
  )
    .map((row) =>
      JSON.stringify({
        media: said(row.media_id),
        order: row.sort_order,
        person: xref(row.person_id),
        family: xref(row.family_id),
        source: xref(row.source_id),
        event: row.event,
        eventOwner: xref(row.event_owner),
        citation: row.citation,
      }),
    )
    .sort();
  return {
    media: (
      db.prepare('SELECT id FROM media ORDER BY origin, title').pluck().all() as string[]
    ).map(said),
    inPlace: (
      db.prepare('SELECT media_id, key FROM gedcom_media ORDER BY key').all() as {
        media_id: string;
        key: string;
      }[]
    ).map((row) => ({ key: row.key, media: said(row.media_id) })),
    links,
    records: listStoredRecords(tree).map((record) => ({
      kind: record.kind,
      xref: record.xref,
      text: record.text,
      parts:
        record.parts?.map((part) => ({
          kind: part.k ?? null,
          text: part.t,
          media: part.k === 'media' && part.r !== undefined ? said(part.r) : null,
        })) ?? null,
    })),
  };
}

describe('importing pictures and documents', () => {
  it('makes a file of each media record and of each description written in place', () => {
    const { tree, id, wedding } = imported();
    expect(getMedia(tree, id('M1'))).toMatchObject({
      sha256: null,
      ext: 'png',
      mime: 'image/png',
      size: 0,
      fileName: 'ann.png',
      title: 'Ann Lee',
      description: 'In the garden',
      origin: 'C:\\Old PC\\Tree Media\\ann.png',
    });
    expect(getMedia(tree, id('M2'))).toMatchObject({
      sha256: null,
      ext: 'jpg',
      mime: 'image/jpeg',
      fileName: 'register-p4.jpg',
      title: 'Register, page 4',
      origin: 'https://example.com/scans/register-p4.jpg',
    });
    expect(wedding).toMatchObject({
      sha256: null,
      ext: 'jpg',
      fileName: 'wedding.jpg',
      title: 'The wedding',
      origin: 'photos/wedding.jpg',
    });
    // Three places describe the photograph in the same words: one file.
    expect(listAllMedia(tree)).toHaveLength(3);
    expect(isMediaPresent(tree, wedding)).toBe(false);
  });

  it('attaches each file to what the lines stand under', () => {
    const { tree, id, birth, marriage } = imported();
    const of = (type: 'person' | 'family' | 'event' | 'source', key: string) =>
      titles(listMedia(tree, { type, id: key }));
    expect(of('person', id('I1'))).toEqual(['Ann Lee', 'The wedding']);
    expect(of('person', id('I2'))).toEqual(['The wedding']);
    expect(of('family', id('F1'))).toEqual(['Ann Lee']);
    expect(of('event', birth)).toEqual(['Register, page 4']);
    expect(of('event', marriage)).toEqual(['The wedding']);
    expect(of('source', id('S1'))).toEqual(['Register, page 4']);
    const citation = listCitations(tree, { type: 'event', id: birth })[0];
    expect(titles(listMedia(tree, { type: 'citation', id: citation?.id ?? '' }))).toEqual([
      'Register, page 4',
    ]);
  });

  it('counts what it made, and keeps a line that points at no record as written', () => {
    const tree = memoryTree();
    const report = importText(tree, PICTURED);
    expect(report).toMatchObject({
      media: 3,
      mediaHeld: 0,
      keptRecords: { SUBM: 1 },
      keptLines: 1,
    });
    const tom = tree.db.prepare("SELECT id FROM gedcom_record WHERE xref = 'I2'").pluck().get();
    expect(keptLinesOf(tree, tom as string)).toEqual(['1 OBJE @M9@']);
  });

  it('makes one link of a file that a record names twice', () => {
    const tree = memoryTree();
    importText(
      tree,
      file(
        '5.5.1',
        '0 @I1@ INDI',
        '1 NAME Ann /Lee/',
        '1 OBJE @M1@',
        '1 OBJE @M1@',
        '0 @M1@ OBJE',
        '1 FILE a.jpg',
      ),
    );
    expect(tree.db.prepare('SELECT count(*) FROM media_link').pluck().get()).toBe(1);
    expect(bodyOf(exportLines(tree))).toContain('1 OBJE @M1@');
    expect(exportLines(tree).filter((line) => line === '1 OBJE @M1@')).toHaveLength(2);
  });

  it('keeps a media structure that names no file as written', () => {
    const tree = memoryTree();
    const text = file(
      '5.5.1',
      '0 @U1@ SUBM',
      '1 NAME Ann Lee',
      '0 @I1@ INDI',
      '1 NAME Ann /Lee/',
      '1 OBJE',
      '2 TITL A lost picture',
      '0 OBJE',
      '1 FILE no-id.jpg',
    );
    const report = importText(tree, text);
    expect(report).toMatchObject({ media: 0, keptRecords: { SUBM: 1, OBJE: 1 }, keptLines: 1 });
    expect(
      firstDifference(bodyOf(exportLines(tree)), bodyOf(text.split('\n').slice(0, -1))),
    ).toBeNull();
  });

  it('reads the media records of GEDCOM 7.0', () => {
    const tree = memoryTree();
    const text = file(
      '7.0',
      '0 @I1@ INDI',
      '1 NAME Ann /Lee/',
      '1 OBJE @M1@',
      '2 TITL Ann, cropped',
      '0 @M1@ OBJE',
      '1 FILE media/ann.webp',
      '2 FORM image/webp',
      '2 TITL Ann Lee',
    );
    importText(tree, text);
    expect(listAllMedia(tree)[0]).toMatchObject({
      ext: 'webp',
      mime: 'image/webp',
      title: 'Ann Lee',
      origin: 'media/ann.webp',
    });
    const lines = exportLines(tree, { version: '7.0' });
    expect(firstDifference(bodyOf(lines), bodyOf(text.split('\n').slice(0, -1)))).toBeNull();
  });
});

describe('exporting pictures and documents', () => {
  it('gives the file back when nothing has changed', () => {
    const { tree } = imported();
    const result = exportGedcom(tree, EXPORT_DEFAULTS);
    expect(firstDifference(bodyOf(exportLines(tree)), bodyOf(PICTURED_LINES))).toBeNull();
    expect(result).toMatchObject({ media: 3, mediaNotHeld: 3, mediaWithheld: 0, files: [] });
  });

  it('leaves a FILE line with no value as it is, as Ancestry writes them', () => {
    // The shape of a media record in a real export from Ancestry (2025.08).
    const text = file(
      '5.5.1',
      '0 @U1@ SUBM',
      '1 NAME Ann Lee',
      '0 @I1@ INDI',
      '1 NAME Ann /Lee/',
      '1 OBJE @O1@',
      '2 _PRIM Y',
      '0 @O1@ OBJE',
      '1 FILE',
      '2 FORM jpg',
      '3 TYPE image',
      '3 _MTYPE portrait',
      '3 _STYPE jpeg',
      '3 _SIZE 15509',
      '2 TITL Ann Lee',
      '1 _OID 0a1b2c3d',
      '1 _ORIG u',
    );
    const tree = memoryTree();
    const report = importText(tree, text);
    expect(report).toMatchObject({ media: 1, mediaHeld: 0, issues: [] });
    const lines = text.split(/\r\n|\n/).slice(0, -1);
    expect(firstDifference(bodyOf(exportLines(tree)), bodyOf(lines))).toBeNull();
    // An edit of the title still changes that line only.
    const media = listAllMedia(tree)[0];
    expect(media).toMatchObject({ title: 'Ann Lee', origin: '', sha256: null });
    if (!media) return;
    updateMedia(tree, media.id, { title: 'Ann Lee, 1910' });
    expect(bodyOf(exportLines(tree))).toEqual(
      bodyOf(lines).map((line) => (line === '2 TITL Ann Lee' ? '2 TITL Ann Lee, 1910' : line)),
    );
  });

  it('rewrites one line of a record whose title was edited', () => {
    const { tree, id } = imported();
    updateMedia(tree, id('M1'), { title: 'Ann Lee, 1910' });
    expect(bodyOf(exportLines(tree))).toEqual(
      bodyOf(PICTURED_LINES).map((line) =>
        line === '2 TITL Ann Lee' ? '2 TITL Ann Lee, 1910' : line,
      ),
    );
  });

  it('rewrites a description written in place everywhere it stands', () => {
    const { tree, wedding } = imported();
    updateMedia(tree, wedding.id, { title: 'The wedding, 1921' });
    const lines = exportLines(tree);
    expect(bodyOf(lines)).toEqual(
      bodyOf(PICTURED_LINES).map((line) =>
        line.endsWith('TITL The wedding') ? `${line}, 1921` : line,
      ),
    );
    // Read again, the three places still say the same, so they are one file.
    const copy = memoryTree();
    importText(copy, `${lines.join('\n')}\n`);
    expect(listAllMedia(copy)).toHaveLength(3);
  });

  it('drops the line of a file that was taken away, there only', () => {
    const { tree, id } = imported();
    unlinkMedia(tree, id('M1'), { type: 'person', id: id('I1') });
    const expected = [...PICTURED_LINES];
    expected.splice(expected.indexOf('1 OBJE @M1@'), 1);
    expect(bodyOf(exportLines(tree))).toEqual(bodyOf(expected));
  });

  it('leaves out a deleted file and every line that pointed at it, until undo', () => {
    const { tree, id } = imported();
    deleteMedia(tree, id('M2'));
    const record = recordOf(PICTURED_LINES, '0 @M2@ OBJE');
    expect(bodyOf(exportLines(tree))).toEqual(
      bodyOf(PICTURED_LINES).filter((line) => !line.includes('@M2@') && !record.includes(line)),
    );
    tree.undo();
    expect(firstDifference(bodyOf(exportLines(tree)), bodyOf(PICTURED_LINES))).toBeNull();
  });

  it('writes a pointer for a file attached to something else since', () => {
    const { tree, id } = imported();
    linkMedia(tree, id('M1'), { type: 'person', id: id('I2') });
    expect(recordOf(exportLines(tree), '0 @I2@ INDI')).toEqual([
      '0 @I2@ INDI',
      '1 NAME Tom /Lee/',
      '1 SEX M',
      '1 OBJE',
      '2 FILE photos/wedding.jpg',
      '3 FORM jpg',
      '2 TITL The wedding',
      '2 _PRIM Y',
      '1 OBJE @M1@',
      '1 OBJE @M9@',
      '1 FAMS @F1@',
    ]);
  });

  it('writes a description again, at its new level, for a file written in place', () => {
    const { tree, wedding, birth } = imported();
    linkMedia(tree, wedding.id, { type: 'event', id: birth });
    const lines = exportLines(tree);
    expect(recordOf(lines, '0 @I1@ INDI').slice(3, 14)).toEqual([
      '1 BIRT',
      '2 DATE 1 JAN 1900',
      '2 SOUR @S1@',
      '3 PAGE Page 4',
      '3 OBJE @M2@',
      '2 OBJE @M2@',
      '2 OBJE',
      '3 FILE photos/wedding.jpg',
      '4 FORM jpg',
      '3 TITL The wedding',
      '3 _PRIM Y',
    ]);
    const copy = memoryTree();
    importText(copy, `${lines.join('\n')}\n`);
    expect(listAllMedia(copy)).toHaveLength(3);
  });

  it('writes a record for a file written in place that is attached to nothing any more', () => {
    const { tree, id, wedding, marriage } = imported();
    unlinkMedia(tree, wedding.id, { type: 'person', id: id('I1') });
    unlinkMedia(tree, wedding.id, { type: 'person', id: id('I2') });
    unlinkMedia(tree, wedding.id, { type: 'event', id: marriage });
    const lines = exportLines(tree);
    expect(lines.filter((line) => line.endsWith('FILE photos/wedding.jpg'))).toEqual([
      '1 FILE photos/wedding.jpg',
    ]);
    expect(recordOf(lines, '0 @M3@ OBJE')).toEqual([
      '0 @M3@ OBJE',
      '1 FILE photos/wedding.jpg',
      '2 FORM jpg',
      '2 TITL The wedding',
      '1 _PRIM Y',
    ]);
  });

  it('turns files written in place into records for GEDCOM 7.0', () => {
    const { tree } = imported();
    const result = exportGedcom(tree, { ...EXPORT_DEFAULTS, version: '7.0' });
    const lines = result.text.split(/\r\n|\n/).slice(0, -1);
    expect(lines.filter((line) => /^\d OBJE$/.test(line))).toEqual([]);
    expect(lines.filter((line) => line.endsWith('OBJE @M3@'))).toEqual([
      '1 OBJE @M3@',
      '1 OBJE @M3@',
      '2 OBJE @M3@',
    ]);
    expect(recordOf(lines, '0 @M3@ OBJE')).toEqual([
      '0 @M3@ OBJE',
      '1 FILE photos/wedding.jpg',
      '2 FORM image/jpeg',
      '2 TITL The wedding',
      '1 _PRIM Y',
    ]);
    expect(recordOf(lines, '0 @M1@ OBJE')).toEqual([
      '0 @M1@ OBJE',
      '1 FILE C:\\Old PC\\Tree Media\\ann.png',
      '2 FORM image/png',
      '2 TITL Ann Lee',
      '1 NOTE In the garden',
    ]);
    expect(result.unconverted).toEqual({});

    const copy = memoryTree();
    importText(copy, result.text);
    expect(titles(listAllMedia(copy)).sort()).toEqual([
      'Ann Lee',
      'Register, page 4',
      'The wedding',
    ]);
    expect(copy.db.prepare('SELECT count(*) FROM media_link').pluck().get()).toBe(
      tree.db.prepare('SELECT count(*) FROM media_link').pluck().get(),
    );
  });

  it('leaves out the pictures of people who are left out, and says how many', () => {
    const tree = memoryTree();
    importText(
      tree,
      file(
        '5.5.1',
        '0 @I1@ INDI',
        '1 NAME Young /Lee/',
        '1 BIRT',
        '2 DATE 2001',
        '1 OBJE @M1@',
        '0 @I2@ INDI',
        '1 NAME Old /Lee/',
        '1 DEAT Y',
        '1 OBJE @M2@',
        '1 NOTE See also',
        '2 OBJE @M1@',
        '0 @M1@ OBJE',
        '1 FILE young.jpg',
        '0 @M2@ OBJE',
        '1 FILE old.jpg',
        '0 @M3@ OBJE',
        '1 FILE attached-to-nothing.jpg',
      ),
    );
    const result = exportGedcom(tree, { ...EXPORT_DEFAULTS, includeLiving: false });
    const lines = result.text.split(/\r\n|\n/);
    expect(result).toMatchObject({ media: 2, mediaWithheld: 1, livingOmitted: 1 });
    // Not the record, and not the line under a note that pointed at it.
    expect(lines.some((line) => line.includes('@M1@') || line.includes('young.jpg'))).toBe(false);
    expect(lines).toContain('0 @M2@ OBJE');
    expect(lines).toContain('0 @M3@ OBJE');
    expect(exportGedcom(tree, EXPORT_DEFAULTS)).toMatchObject({ media: 3, mediaWithheld: 0 });
  });
});

/** A tree in a folder with one person, and a folder with a picture to add. */
function onDisk(): { tree: Tree; personId: string; picture: string; bytes: Buffer } {
  const tree = track(createTree(tempDir(), { name: 'Media' }));
  const personId = addPersonFromDraft(tree, { given: 'Ann', surname: 'Lee' }).id;
  const bytes = pngBytes(30, 20, 7);
  const picture = join(tempDir(), 'Ann in the garden (1910).png');
  writeFileSync(picture, bytes);
  return { tree, personId, picture, bytes };
}

describe('exporting files that were added in the app', () => {
  it('writes a record for each, named as it would be in an archive', () => {
    const { tree, personId, picture } = onDisk();
    const added = addMediaFiles(tree, [picture], { type: 'person', id: personId })[0]?.media;
    updateMedia(tree, added?.id ?? '', { title: 'Ann', description: 'Line one\nLine two' });

    const result = exportGedcom(tree, EXPORT_DEFAULTS);
    const lines = result.text.split(/\r\n|\n/).slice(0, -1);
    expect(recordOf(lines, '0 @M1@ OBJE')).toEqual([
      '0 @M1@ OBJE',
      '1 FILE media/Ann_in_the_garden_1910.png',
      '2 FORM png',
      '2 TITL Ann',
      '1 NOTE Line one',
      '2 CONT Line two',
    ]);
    expect(recordOf(lines, '0 @I1@ INDI')).toContain('1 OBJE @M1@');
    // A GEDCOM file on its own names the file and does not carry it.
    expect(result).toMatchObject({ media: 1, mediaNotHeld: 0, files: [] });

    const seven = exportGedcom(tree, { ...EXPORT_DEFAULTS, version: '7.0' }).text;
    expect(seven).toContain('2 FORM image/png');
  });

  it('gives two files of one name different paths', () => {
    const { tree, personId, picture } = onDisk();
    const other = join(tempDir(), 'Ann in the garden (1910).png');
    writeFileSync(other, pngBytes(30, 20, 8));
    addMediaFiles(tree, [picture, other], { type: 'person', id: personId });
    const lines = exportLines(tree).filter((line) => line.startsWith('1 FILE'));
    expect(lines).toEqual([
      '1 FILE media/Ann_in_the_garden_1910.png',
      '1 FILE media/Ann_in_the_garden_1910-2.png',
    ]);
  });

  it('writes a file that is attached to nothing', () => {
    const { tree, picture } = onDisk();
    addMediaFiles(tree, [picture], null);
    expect(exportLines(tree)).toContain('0 @M1@ OBJE');
  });
});

describe('a GEDZip file', () => {
  it('carries the files of a tree, and gives them to the tree that imports it', () => {
    const { tree, personId, picture, bytes } = onDisk();
    const added = addMediaFiles(tree, [picture], { type: 'person', id: personId })[0]?.media;
    updateMedia(tree, added?.id ?? '', { title: 'Ann in the garden' });
    const target = join(tempDir(), 'Lee family.gdz');
    const result = exportGedcomFile(tree, target, { ...EXPORT_DEFAULTS, files: true });
    expect(result).toMatchObject({ media: 1, mediaNotHeld: 0 });
    expect(result.files).toEqual([
      {
        path: 'media/Ann_in_the_garden_1910.png',
        source: mediaFilePath(tree, added as Media),
      },
    ]);
    expect(existsSync(`${target}.tmp`)).toBe(false);

    const zip = ZipReader.open(target);
    try {
      expect(zip.entries.map((entry) => entry.name)).toEqual([
        'gedcom.ged',
        'media/Ann_in_the_garden_1910.png',
      ]);
      expect(zip.read(zip.entries[1] as never, 1_000_000).equals(bytes)).toBe(true);
      // Inside the archive the file is called what the standard calls it.
      expect(zip.read(zip.entries[0] as never, 1_000_000).toString('utf8')).toContain(
        '1 FILE gedcom.ged',
      );
    } finally {
      zip.close();
    }

    const copy = track(createTree(tempDir(), { name: 'Copy' }));
    const report = importGedcomFile(copy, target);
    expect(report).toMatchObject({
      fileName: 'Lee family.gdz',
      media: 1,
      mediaHeld: 1,
      issues: [],
    });
    const held = listAllMedia(copy)[0] as Media;
    expect(held).toMatchObject({
      sha256: added?.sha256,
      ext: 'png',
      mime: 'image/png',
      size: bytes.length,
      fileName: 'Ann_in_the_garden_1910.png',
      title: 'Ann in the garden',
      origin: 'media/Ann_in_the_garden_1910.png',
    });
    expect(readFileSync(mediaFilePath(copy, held) ?? '').equals(bytes)).toBe(true);
    expect(copy.undoStatus().undo).toBeNull();

    // Written out again, the copy names its file by the path it came with.
    const again = join(tempDir(), 'again.gdz');
    const second = exportGedcomFile(copy, again, { ...EXPORT_DEFAULTS, files: true });
    expect(second.files.map((packed) => packed.path)).toEqual(['media/Ann_in_the_garden_1910.png']);
    expect(bodyOf(second.text.split(/\r\n|\n/))).toEqual(bodyOf(result.text.split(/\r\n|\n/)));
  });

  it('names a file the tree does not hold by the path the imported file gave', () => {
    const tree = track(createTree(tempDir(), { name: 'Named' }));
    importText(tree, PICTURED);
    const target = join(tempDir(), 'named.gdz');
    const result = exportGedcomFile(tree, target, { ...EXPORT_DEFAULTS, files: true });
    expect(result).toMatchObject({ media: 3, mediaNotHeld: 3, files: [] });
    expect(
      firstDifference(bodyOf(result.text.split(/\r\n|\n/).slice(0, -1)), bodyOf(PICTURED_LINES)),
    ).toBeNull();
  });

  /** Writes an archive with a GEDCOM file and some pictures, and returns its path. */
  function archive(gedcomName: string, text: string, pictures: Record<string, Buffer>): string {
    const target = join(tempDir(), 'made by hand.zip');
    writeZip(target, [
      { name: gedcomName, data: Buffer.from(text, 'utf8') },
      ...Object.entries(pictures).map(([name, data]) => ({ name, data })),
    ]);
    return target;
  }

  it('takes only the files that are in the archive, by a path that stays inside it', () => {
    const ann = pngBytes(10, 10, 1);
    const text = file(
      '5.5.1',
      '0 @I1@ INDI',
      '1 NAME Ann /Lee/',
      '1 OBJE @M1@',
      '1 OBJE @M2@',
      '1 OBJE @M3@',
      '1 OBJE @M4@',
      '1 OBJE',
      '2 FILE photos\\Ann%20Lee.png',
      '0 @M1@ OBJE',
      '1 FILE photos/ann.png',
      '0 @M2@ OBJE',
      '1 FILE photos/not-in-the-archive.png',
      '0 @M3@ OBJE',
      '1 FILE ../secret.png',
      '0 @M4@ OBJE',
      '1 FILE C:\\Users\\someone\\secret.png',
    );
    const source = archive('gedcom.ged', text, {
      'photos/ann.png': ann,
      'photos/Ann Lee.png': pngBytes(10, 10, 2),
      'secret.png': pngBytes(10, 10, 3),
    });
    const tree = track(createTree(tempDir(), { name: 'Zip' }));
    const report = importGedcomFile(tree, source);
    expect(report).toMatchObject({ media: 5, mediaHeld: 2, issues: [] });
    const held = listAllMedia(tree).filter((media) => media.sha256 !== null);
    expect(held.map((media) => media.origin).sort()).toEqual([
      'photos/ann.png',
      'photos\\Ann%20Lee.png',
    ]);
    expect(held.every((media) => isMediaPresent(tree, media))).toBe(true);
    // Nothing but the two pictures went into the media folder.
    const folders = readdirSync(join(tree.dir ?? '', MEDIA_DIR_NAME));
    expect(folders).toHaveLength(2);
  });

  it('reads an archive whose GEDCOM file has another name and is in a folder', () => {
    const text = file(
      '5.5.1',
      '0 @I1@ INDI',
      '1 NAME Ann /Lee/',
      '1 OBJE @M1@',
      '0 @M1@ OBJE',
      '1 FILE Photos/Ann.PNG',
    );
    const source = archive('export/family.ged', text, { 'export/photos/ann.png': pngBytes(8, 8) });
    const tree = track(createTree(tempDir(), { name: 'Zip' }));
    expect(importGedcomFile(tree, source)).toMatchObject({ persons: 1, mediaHeld: 1 });
  });

  it('says so when a picture in the archive cannot be taken, and imports the rest', () => {
    const text = file('5.5.1', '0 @I1@ INDI', '1 NAME A /B/', '0 @M1@ OBJE', '1 FILE empty.png');
    const source = archive('gedcom.ged', text, { 'empty.png': Buffer.alloc(0) });
    const tree = track(createTree(tempDir(), { name: 'Zip' }));
    const report = importGedcomFile(tree, source);
    expect(report).toMatchObject({ persons: 1, media: 1, mediaHeld: 0 });
    expect(report.issues).toEqual([{ line: 0, message: 'empty.png is empty' }]);
  });

  it('is refused when it holds no GEDCOM file, or several', () => {
    const none = archive('readme.txt', 'nothing here', {});
    expect(() => readGedcomFile(none)).toThrow(GedcomFileError);
    expect(() => readGedcomFile(none)).toThrow(/holds no GEDCOM file/);
    const two = join(tempDir(), 'two.zip');
    writeZip(two, [
      { name: 'a.ged', data: Buffer.from(PICTURED) },
      { name: 'b.ged', data: Buffer.from(PICTURED) },
    ]);
    expect(() => readGedcomFile(two)).toThrow(/several GEDCOM files/);
    const broken = join(tempDir(), 'broken.gdz');
    writeFileSync(broken, 'PK not really a zip file at all');
    expect(() => readGedcomFile(broken)).toThrow(GedcomFileError);
  });

  it('lets go of the archive when the import is over', () => {
    const text = file('5.5.1', '0 @I1@ INDI', '1 NAME A /B/', '0 @M1@ OBJE', '1 FILE a.png');
    const input = readGedcomFile(archive('gedcom.ged', text, { 'a.png': pngBytes(8, 8) }));
    expect(input.files?.open('a.png')).not.toBeNull();
    input.close?.();
    input.close?.();
    expect(() => input.files?.open('a.png')).toThrow(/closed/);
  });
});

/** A tree as the app made them before imported files had rows: schema version 5. */
function olderTree(location: string): Tree {
  const inMemory = location === ':memory:';
  const db = openDatabase(inMemory ? location : join(location, TREE_FILE_NAME));
  db.pragma(`application_id = ${TREE_APPLICATION_ID}`);
  migrate(db, treeMigrations.slice(0, 5));
  db.prepare(
    "INSERT INTO tree_meta (key, value) VALUES ('id', 'older'), ('name', 'Older'), ('created_at', '0')",
  ).run();
  return track(new Tree(db, inMemory ? null : location));
}

describe('a tree imported before the files it names had rows', () => {
  it('holds them as lines kept as written', () => {
    const tree = olderTree(':memory:');
    const report = importGedcom(tree, inputOf(PICTURED), { media: false });
    expect(schemaVersion(tree.db)).toBe(5);
    expect(report).toMatchObject({ media: 0, sources: 1, keptRecords: { SUBM: 1, OBJE: 2 } });
    // The lines under Ann, the one under Tom twice, and the one under the family.
    expect(report.keptLines).toBe(5);
    expect(tree.db.prepare('SELECT count(*) FROM media').pluck().get()).toBe(0);
  });

  it('is given the same files as a fresh import of the file', () => {
    for (const text of [PICTURED, ancestryStyleFile(60)]) {
      const older = olderTree(':memory:');
      importGedcom(older, inputOf(text), { media: false });
      migrate(older.db, treeMigrations);
      expect(schemaVersion(older.db)).toBe(treeMigrations.length);

      const fresh = memoryTree();
      importText(fresh, text);
      expect(mediaModel(older)).toEqual(mediaModel(fresh));

      const original = text.split(/\r\n|\n/).slice(0, -1);
      expect(firstDifference(bodyOf(exportLines(older)), bodyOf(original))).toBeNull();
    }
  });

  it('can be edited like any other once upgraded', () => {
    const older = olderTree(':memory:');
    importGedcom(older, inputOf(PICTURED), { media: false });
    migrate(older.db, treeMigrations);
    const id = older.db.prepare("SELECT id FROM gedcom_record WHERE xref = 'M1'").pluck().get();
    updateMedia(older, id as string, { title: 'Ann Lee, 1910' });
    expect(exportLines(older)).toContain('2 TITL Ann Lee, 1910');
    older.undo();
    expect(firstDifference(bodyOf(exportLines(older)), bodyOf(PICTURED_LINES))).toBeNull();
  });

  it('gives the files of a merged record to the person who is left, and skips what was deleted', () => {
    const older = olderTree(':memory:');
    importGedcom(older, inputOf(PICTURED), { media: false });
    const id = (xref: string) =>
      older.db.prepare('SELECT id FROM gedcom_record WHERE xref = ?').pluck().get(xref) as string;
    const birth = listPersonEvents(older, id('I1'))[0]?.id ?? '';
    // Before the upgrade: Ann's birth is deleted, and a second record of Tom is merged into him.
    deleteEvent(older, birth);
    const twin = addPersonFromDraft(older, { given: 'Tom', surname: 'Lee', sex: 'M' }).id;
    mergePersons(older, twin, id('I2'));

    migrate(older.db, treeMigrations);
    expect(titles(listMedia(older, { type: 'person', id: twin }))).toEqual(['The wedding']);
    // The scan stood under the birth and under its citation, which are gone; the source still has it.
    const scan = getMedia(older, id('M2'));
    expect(scan?.title).toBe('Register, page 4');
    expect(
      older.db.prepare('SELECT count(*) FROM media_link WHERE media_id = ?').pluck().get(id('M2')),
    ).toBe(1);
  });

  it('puts the files of the imported file after those attached in the app', () => {
    const older = olderTree(':memory:');
    importGedcom(older, inputOf(PICTURED), { media: false });
    const ann = older.db.prepare("SELECT id FROM gedcom_record WHERE xref = 'I1'").pluck().get();
    // A file attached in the app, as the earlier build stored it.
    older.transact('Add file', () => {
      older.db
        .prepare(
          `INSERT INTO media (id, sha256, ext, mime, size, file_name, title, description, created_at, updated_at)
           VALUES ('added', ?, 'png', 'image/png', 10, 'added.png', 'Added in the app', '', 0, 0)`,
        )
        .run('a'.repeat(64));
      older.db
        .prepare(
          "INSERT INTO media_link (id, media_id, person_id, sort_order) VALUES ('l', 'added', ?, 0)",
        )
        .run(ann);
    });
    migrate(older.db, treeMigrations);
    expect(titles(listMedia(older, { type: 'person', id: ann as string }))).toEqual([
      'Added in the app',
      'Ann Lee',
      'The wedding',
    ]);
    expect(getMedia(older, 'added')).toMatchObject({ origin: '', sha256: 'a'.repeat(64) });
    // The change made before the upgrade can still be undone.
    older.undo();
    expect(getMedia(older, 'added')).toBeNull();
  });

  it('is copied to its backups folder before it is upgraded', () => {
    const dir = tempDir();
    const older = olderTree(dir);
    importGedcom(older, inputOf(PICTURED), { media: false });
    older.close();

    const tree = track(openExistingTree(dir));
    expect(tree.info()).toMatchObject({ schemaVersion: treeMigrations.length, media: 3 });
    expect(listBackups(dir)).toHaveLength(1);
    const backup = openDatabase(join(dir, BACKUP_DIR_NAME, listBackups(dir)[0]?.name ?? ''));
    try {
      expect(schemaVersion(backup)).toBe(5);
    } finally {
      backup.close();
    }
  });

  it('is left alone when it was never imported', () => {
    const older = olderTree(':memory:');
    addPersonFromDraft(older, { given: 'Ann', surname: 'Lee' });
    migrate(older.db, treeMigrations);
    expect(older.info()).toMatchObject({ schemaVersion: treeMigrations.length, media: 0 });
    expect(older.undoStatus().undo).not.toBeNull();
  });
});
