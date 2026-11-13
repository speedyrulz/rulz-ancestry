import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { addPartner, addPersonFromDraft } from './actions';
import { BACKUP_DIR_NAME, listBackups } from './backup';
import { UNTRACKED_WRITE_MESSAGE } from './changelog';
import { openDatabase } from './connection';
import { addFamilyEvent, deleteEvent, listPersonEvents } from './events';
import { file as gedcomFile, importText } from './gedcom/testing';
import {
  MAX_MEDIA_FILES_AT_ONCE,
  MEDIA_DIR_NAME,
  MediaFileError,
  addMediaFiles,
  countMedia,
  deleteMedia,
  getMedia,
  isMediaPresent,
  linkMedia,
  listAllMedia,
  listMedia,
  listMediaUses,
  listPersonMedia,
  locateMediaFiles,
  mediaFilePath,
  setMediaFile,
  unlinkMedia,
  updateMedia,
  type Media,
  type MediaTarget,
} from './media';
import { mergePersons } from './merge';
import { migrate, schemaVersion } from './migrate';
import { getPersonPage } from './personpage';
import { createPerson, deletePerson } from './persons';
import { treeMigrations } from './schema';
import { addCitation, createSource, deleteSource, unlinkCitation } from './sources';
import {
  cleanUpAfterEach,
  memoryTree,
  pngBytes,
  snapshot,
  tempDir,
  track,
  undoDepth,
  withLaterColumns,
} from './testing';
import {
  NotFoundError,
  TREE_APPLICATION_ID,
  TREE_FILE_NAME,
  Tree,
  TreeRuleError,
  createTree,
  openExistingTree,
} from './tree';

cleanUpAfterEach();

const MISSING = '00000000-0000-7000-8000-000000000000';

function count(tree: Tree, table: 'media' | 'media_link'): number {
  return tree.db.prepare(`SELECT count(*) FROM ${table}`).pluck().get() as number;
}

/** Writes a file into a folder of its own and returns its full path. */
function fileIn(dir: string, name: string, contents: Buffer | string): string {
  const path = join(dir, name);
  writeFileSync(path, contents);
  return path;
}

/** Every file under the tree's media folder, as paths with forward slashes. */
function storedFiles(tree: Tree): string[] {
  const root = join(tree.dir ?? '', MEDIA_DIR_NAME);
  if (!existsSync(root)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isFile()) {
      found.push(entry.name);
    } else {
      for (const inner of readdirSync(join(root, entry.name))) found.push(`${entry.name}/${inner}`);
    }
  }
  return found.sort();
}

interface Start {
  tree: Tree;
  /** A folder with files to add; it is not the tree's folder. */
  files: string;
  personId: string;
  person: { type: 'person'; id: string };
  birth: { type: 'event'; id: string };
}

/** A tree in a folder, with one person who has a birth. */
function start(): Start {
  const tree = track(createTree(tempDir(), { name: 'Media' }));
  const personId = addPersonFromDraft(tree, {
    given: 'John',
    surname: 'Hale',
    birthDate: '1870',
  }).id;
  const birthId = listPersonEvents(tree, personId)[0]?.id ?? '';
  return {
    tree,
    files: tempDir(),
    personId,
    person: { type: 'person', id: personId },
    birth: { type: 'event', id: birthId },
  };
}

/** Adds one file and returns its row. */
function add(tree: Tree, file: string, target: MediaTarget | null): Media {
  const added = addMediaFiles(tree, [file], target);
  expect(added).toHaveLength(1);
  return (added[0] as { media: Media }).media;
}

describe('adding a file', () => {
  it('copies it into the media folder under the hash of its contents', () => {
    const { tree, files, person } = start();
    const bytes = pngBytes(40, 30);
    const file = fileIn(files, 'Wedding 1902.png', bytes);
    const sha256 = createHash('sha256').update(bytes).digest('hex');

    const [added] = addMediaFiles(tree, [file], person);
    expect(added).toMatchObject({ isNew: true, linked: true });
    expect(added?.media).toMatchObject({
      sha256,
      ext: 'png',
      mime: 'image/png',
      size: bytes.length,
      fileName: 'Wedding 1902.png',
      title: '',
      description: '',
    });
    expect(storedFiles(tree)).toEqual([`${sha256.slice(0, 2)}/${sha256}.png`]);
    const stored = mediaFilePath(tree, added?.media as Media);
    expect(readFileSync(stored ?? '').equals(bytes)).toBe(true);
    // The file that was chosen is left where it was.
    expect(existsSync(file)).toBe(true);
    expect(tree.info().media).toBe(1);
    expect(tree.undoStatus().undo?.label).toBe('Add file');
    expect(listMedia(tree, person).map((media) => media.id)).toEqual([added?.media.id]);
  });

  it('tells the kind of file from its bytes, and from its name only when it must', () => {
    const { tree, files, person } = start();
    const misnamed = add(tree, fileIn(files, 'scan.JPG', pngBytes(8, 8)), person);
    expect(misnamed).toMatchObject({ ext: 'png', mime: 'image/png', fileName: 'scan.JPG' });

    const pdf = add(tree, fileIn(files, 'will', '%PDF-1.4 a will of 1881'), person);
    expect(pdf).toMatchObject({ ext: 'pdf', mime: 'application/pdf' });

    const text = add(tree, fileIn(files, 'Notes.TXT', 'Seen at the record office'), person);
    expect(text).toMatchObject({ ext: 'txt', mime: 'text/plain' });

    const unknown = add(tree, fileIn(files, 'tree.ftmb', 'data nobody knows'), person);
    expect(unknown).toMatchObject({ ext: 'ftmb', mime: 'application/octet-stream' });

    const bare = add(tree, fileIn(files, 'README', 'no extension at all'), person);
    expect(bare.ext).toBe('');
    expect(isMediaPresent(tree, bare)).toBe(true);
  });

  it('keeps one copy of a file however often it is added', () => {
    const { tree, files, person, birth } = start();
    const bytes = pngBytes(20, 20);
    const first = add(tree, fileIn(files, 'a.png', bytes), person);
    const depth = undoDepth(tree);

    // The same contents under another name, for something else: the row that exists is attached.
    const [again] = addMediaFiles(tree, [fileIn(files, 'copy of a.png', bytes)], birth);
    expect(again).toMatchObject({ isNew: false, linked: true });
    expect(again?.media.id).toBe(first.id);
    expect(again?.media.fileName).toBe('a.png');
    expect(count(tree, 'media')).toBe(1);
    expect(count(tree, 'media_link')).toBe(2);
    expect(storedFiles(tree)).toHaveLength(1);
    expect(undoDepth(tree)).toBe(depth + 1);

    // Added where it already is: nothing changes, and there is nothing to undo.
    const [third] = addMediaFiles(tree, [fileIn(files, 'a again.png', bytes)], birth);
    expect(third).toMatchObject({ isNew: false, linked: false });
    expect(count(tree, 'media_link')).toBe(2);
    expect(undoDepth(tree)).toBe(depth + 1);
  });

  it('adds several files as one step', () => {
    const { tree, files, person } = start();
    const paths = [1, 2, 3].map((seed) => fileIn(files, `p${seed}.png`, pngBytes(10, 10, seed)));
    // The same picture twice in one go is still one file.
    paths.push(fileIn(files, 'p1 again.png', pngBytes(10, 10, 1)));
    const before = snapshot(tree);

    const added = addMediaFiles(tree, paths, person);
    expect(added.map((entry) => entry.isNew)).toEqual([true, true, true, false]);
    expect(added.map((entry) => entry.linked)).toEqual([true, true, true, false]);
    expect(count(tree, 'media')).toBe(3);
    expect(tree.undoStatus().undo?.label).toBe('Add files');
    expect(listMedia(tree, person).map((media) => media.fileName)).toEqual([
      'p1.png',
      'p2.png',
      'p3.png',
    ]);
    const after = snapshot(tree);

    // Undo takes the rows away and leaves the files, so redo finds them again.
    tree.undo();
    expect(snapshot(tree)).toBe(before);
    expect(storedFiles(tree)).toHaveLength(3);
    tree.redo();
    expect(snapshot(tree)).toBe(after);
    expect(listMedia(tree, person).every((media) => isMediaPresent(tree, media))).toBe(true);
  });

  it('can add a file that is attached to nothing', () => {
    const { tree, files } = start();
    const [added] = addMediaFiles(tree, [fileIn(files, 'loose.png', pngBytes(5, 5))], null);
    expect(added).toMatchObject({ isNew: true, linked: false });
    expect(count(tree, 'media_link')).toBe(0);
    expect(countMedia(tree, { unattached: true })).toBe(1);
  });

  it('refuses a file it cannot take, and then adds none of them', () => {
    const { tree, files, person } = start();
    const good = fileIn(files, 'good.png', pngBytes(10, 10));
    const depth = undoDepth(tree);
    const refuse = (file: string, message: RegExp, maxBytes?: number) => {
      const options = maxBytes === undefined ? {} : { maxBytes };
      expect(() => addMediaFiles(tree, [good, file], person, options)).toThrow(MediaFileError);
      expect(() => addMediaFiles(tree, [good, file], person, options)).toThrow(message);
    };

    refuse(join(files, 'nowhere.png'), /nowhere\.png could not be opened/);
    mkdirSync(join(files, 'a folder'));
    refuse(join(files, 'a folder'), /a folder (is not a file|could not be opened)/);
    refuse(fileIn(files, 'empty.png', ''), /empty\.png is empty/);
    refuse(
      fileIn(files, 'big.png', Buffer.alloc(5000, 1)),
      /big\.png is .* the largest file/,
      1000,
    );

    expect(count(tree, 'media')).toBe(0);
    expect(undoDepth(tree)).toBe(depth);
    // No half-copied file is left behind.
    expect(storedFiles(tree)).toEqual([]);
  });

  it('needs a tree in a folder, something to attach to, and a sensible number of files', () => {
    const { tree, files, person } = start();
    const file = fileIn(files, 'a.png', pngBytes(5, 5));

    const memory = memoryTree();
    const someone = createPerson(memory, {}).id;
    expect(() => addMediaFiles(memory, [file], { type: 'person', id: someone })).toThrow(
      TreeRuleError,
    );

    expect(() => addMediaFiles(tree, [file], { type: 'person', id: MISSING })).toThrow(
      NotFoundError,
    );
    expect(() => addMediaFiles(tree, [file], { type: 'citation', id: MISSING })).toThrow(
      NotFoundError,
    );
    const many = Array.from({ length: MAX_MEDIA_FILES_AT_ONCE + 1 }, () => file);
    expect(() => addMediaFiles(tree, many, person)).toThrow(/at most 100 files/);
    expect(addMediaFiles(tree, [], person)).toEqual([]);
    expect(count(tree, 'media')).toBe(0);
    expect(storedFiles(tree)).toEqual([]);
  });
});

describe('a file in the tree', () => {
  it('has a title and a description that can be changed and undone', () => {
    const { tree, files, person } = start();
    const media = add(tree, fileIn(files, 'a.png', pngBytes(5, 5)), person);
    const depth = undoDepth(tree);

    const edited = updateMedia(tree, media.id, {
      title: '  The Hale\n family, 1902 ',
      description: ' Back row: John.\r\nFront row: Mary. ',
    });
    expect(edited).toMatchObject({
      title: 'The Hale family, 1902',
      description: 'Back row: John.\nFront row: Mary.',
    });
    expect(tree.undoStatus().undo?.label).toBe('Edit file details');

    // A field that is left out stays, and saving the same again is no step.
    expect(updateMedia(tree, media.id, { title: 'The Hale family' }).description).toBe(
      'Back row: John.\nFront row: Mary.',
    );
    updateMedia(tree, media.id, { title: 'The Hale family' });
    expect(undoDepth(tree)).toBe(depth + 2);

    tree.undo();
    tree.undo();
    expect(getMedia(tree, media.id)).toMatchObject({ title: '', description: '' });
    expect(() => updateMedia(tree, MISSING, { title: 'x' })).toThrow(NotFoundError);
  });

  it('stays in the tree when it is taken away from what it was attached to', () => {
    const { tree, files, person, birth } = start();
    const media = add(tree, fileIn(files, 'a.png', pngBytes(5, 5)), person);
    linkMedia(tree, media.id, birth);
    expect(tree.undoStatus().undo?.label).toBe('Attach file');
    // Attaching it there again changes nothing.
    const depth = undoDepth(tree);
    linkMedia(tree, media.id, birth);
    expect(undoDepth(tree)).toBe(depth);

    unlinkMedia(tree, media.id, person);
    expect(tree.undoStatus().undo?.label).toBe('Remove file');
    expect(listMedia(tree, person)).toEqual([]);
    expect(listMedia(tree, birth)).toHaveLength(1);

    unlinkMedia(tree, media.id, birth);
    expect(count(tree, 'media')).toBe(1);
    expect(countMedia(tree, { unattached: true })).toBe(1);

    tree.undo();
    expect(listMedia(tree, birth).map((entry) => entry.id)).toEqual([media.id]);
    expect(() => linkMedia(tree, media.id, { type: 'event', id: MISSING })).toThrow(NotFoundError);
    expect(() => linkMedia(tree, MISSING, birth)).toThrow(NotFoundError);
  });

  it('leaves its copy in the folder when it is deleted, so that undo brings it back whole', () => {
    const { tree, files, person, birth } = start();
    const media = add(tree, fileIn(files, 'a.png', pngBytes(5, 5)), person);
    linkMedia(tree, media.id, birth);
    const before = snapshot(tree);
    const path = mediaFilePath(tree, media) ?? '';

    deleteMedia(tree, media.id);
    expect(tree.undoStatus().undo?.label).toBe('Delete file');
    expect(count(tree, 'media')).toBe(0);
    expect(count(tree, 'media_link')).toBe(0);
    expect(existsSync(path)).toBe(true);

    tree.undo();
    expect(snapshot(tree)).toBe(before);
    expect(isMediaPresent(tree, media)).toBe(true);
    expect(() => deleteMedia(tree, MISSING)).toThrow(NotFoundError);
  });

  it('stays, attached to nothing, when what it was attached to is deleted', () => {
    const { tree, files, personId, person, birth } = start();
    const sourceId = createSource(tree, { title: 'Parish register' }).id;
    const citation = addCitation(tree, birth, { sourceId }, { page: 'p. 12' });
    const scan = add(tree, fileIn(files, 'scan.png', pngBytes(6, 6, 1)), {
      type: 'citation',
      id: citation.id,
    });
    const cover = add(tree, fileIn(files, 'cover.png', pngBytes(6, 6, 2)), {
      type: 'source',
      id: sourceId,
    });
    const portrait = add(tree, fileIn(files, 'portrait.png', pngBytes(6, 6, 3)), person);
    const certificate = add(tree, fileIn(files, 'cert.png', pngBytes(6, 6, 4)), birth);
    expect(count(tree, 'media_link')).toBe(4);
    const before = snapshot(tree);

    // The citation goes with its last fact, and its scan is left unattached.
    unlinkCitation(tree, citation.id, birth);
    expect(listMediaUses(tree, scan.id)).toEqual([]);
    tree.undo();
    expect(snapshot(tree)).toBe(before);

    deleteSource(tree, sourceId);
    expect(listMediaUses(tree, cover.id)).toEqual([]);
    expect(listMediaUses(tree, scan.id)).toEqual([]);
    tree.undo();

    deleteEvent(tree, birth.id);
    expect(listMediaUses(tree, certificate.id)).toEqual([]);
    tree.undo();

    deletePerson(tree, personId);
    expect(listMediaUses(tree, portrait.id)).toEqual([]);
    expect(count(tree, 'media')).toBe(4);
    tree.undo();
    expect(snapshot(tree)).toBe(before);
  });

  it('is reported as gone when its copy is no longer in the folder, and comes back when added again', () => {
    const { tree, files, person, birth } = start();
    const bytes = pngBytes(9, 9);
    const file = fileIn(files, 'a.png', bytes);
    const media = add(tree, file, person);
    const path = mediaFilePath(tree, media) ?? '';
    rmSync(path);
    expect(isMediaPresent(tree, media)).toBe(false);

    const [again] = addMediaFiles(tree, [file], birth);
    expect(again).toMatchObject({ isNew: false, linked: true });
    expect(again?.media.id).toBe(media.id);
    expect(readFileSync(path).equals(bytes)).toBe(true);
  });

  it('is found again after the tree folder is moved', () => {
    const parent = tempDir();
    const dir = join(parent, 'before');
    const tree = createTree(dir, { name: 'Moved' });
    const personId = createPerson(tree, {}).id;
    const media = add(tree, fileIn(tempDir(), 'a.png', pngBytes(7, 7)), {
      type: 'person',
      id: personId,
    });
    tree.close();

    const moved = join(parent, 'after');
    renameSync(dir, moved);
    const reopened = track(openExistingTree(moved));
    const found = getMedia(reopened, media.id) as Media;
    expect(mediaFilePath(reopened, found)).toContain(join('after', MEDIA_DIR_NAME));
    expect(isMediaPresent(reopened, found)).toBe(true);
  });

  it('cannot be written outside a change, like every other table of a tree', () => {
    const { tree, files, person } = start();
    const media = add(tree, fileIn(files, 'a.png', pngBytes(5, 5)), person);
    expect(() =>
      tree.db.prepare("UPDATE media SET title = 'x' WHERE id = ?").run(media.id),
    ).toThrow(UNTRACKED_WRITE_MESSAGE);
    expect(() => tree.db.prepare('DELETE FROM media_link').run()).toThrow(UNTRACKED_WRITE_MESSAGE);
  });
});

describe('the files of a person', () => {
  it('are everything attached on their page, each once, with what it is attached to', () => {
    const { tree, files, personId, person, birth } = start();
    const partner = addPartner(tree, personId, { create: { given: 'Mary', surname: 'Stone' } });
    const family = tree.db
      .prepare('SELECT id FROM family WHERE partner1_id = ? OR partner2_id = ?')
      .pluck()
      .get(personId, personId) as string;
    const marriage = addFamilyEvent(tree, family, { type: 'marriage', date: '1902' });
    const sourceId = createSource(tree, { title: 'Parish register' }).id;
    const citation = addCitation(tree, birth, { sourceId }, { page: 'p. 12' });

    const png = (name: string, seed: number) => fileIn(files, name, pngBytes(6, 6, seed));
    const portrait = add(tree, png('portrait.png', 1), person);
    const scan = add(tree, png('scan.png', 2), { type: 'citation', id: citation.id });
    const wedding = add(tree, png('wedding.png', 3), { type: 'event', id: marriage.id });
    const home = add(tree, png('home.png', 4), { type: 'family', id: family });
    // One picture attached to two things of the page.
    linkMedia(tree, portrait.id, birth);
    // A file of the source itself is not on a person's page.
    add(tree, png('cover.png', 5), { type: 'source', id: sourceId });
    // Nor is a file of somebody else.
    add(tree, png('other.png', 6), { type: 'person', id: createPerson(tree, {}).id });

    const page = getPersonPage(tree, personId);
    expect(page?.media.map((media) => [media.fileName, media.uses])).toEqual([
      [
        'portrait.png',
        [
          { type: 'person', id: personId },
          { type: 'event', id: birth.id },
        ],
      ],
      ['home.png', [{ type: 'family', id: family }]],
      ['wedding.png', [{ type: 'event', id: marriage.id }]],
      ['scan.png', [{ type: 'citation', id: citation.id }]],
    ]);
    // Without the page's citations, the scan is not listed.
    expect(listPersonMedia(tree, personId).map((media) => media.fileName)).toEqual([
      'portrait.png',
      'home.png',
      'wedding.png',
    ]);
    // The partner sees what belongs to the couple, and nothing of John's own.
    expect(listPersonMedia(tree, partner.personId).map((media) => media.fileName)).toEqual([
      'home.png',
      'wedding.png',
    ]);

    expect(listMediaUses(tree, portrait.id)).toEqual([
      { type: 'person', id: personId, what: 'person', detail: '', personIds: [personId] },
      { type: 'event', id: birth.id, what: 'birth', detail: '', personIds: [personId] },
    ]);
    expect(listMediaUses(tree, scan.id)).toEqual([
      {
        type: 'citation',
        id: citation.id,
        what: 'citation',
        detail: 'Parish register, p. 12',
        personIds: [personId],
      },
    ]);
    expect(listMediaUses(tree, wedding.id)[0]).toMatchObject({
      what: 'marriage',
      personIds: [personId, partner.personId],
    });
    expect(listMediaUses(tree, home.id)[0]).toMatchObject({
      what: 'family',
      personIds: [personId, partner.personId],
    });
  });

  it('move to the person who is left when two records are merged', () => {
    const { tree, files, personId, person } = start();
    const twin = addPersonFromDraft(tree, { given: 'John', surname: 'Hale', birthDate: '1870' }).id;
    const twinBirth = listPersonEvents(tree, twin)[0]?.id ?? '';
    const shared = fileIn(files, 'shared.png', pngBytes(6, 6, 1));
    add(tree, shared, person);
    add(tree, shared, { type: 'person', id: twin });
    add(tree, fileIn(files, 'own.png', pngBytes(6, 6, 2)), { type: 'person', id: twin });
    // The twin's birth says the same as John's, but it has a certificate attached.
    add(tree, fileIn(files, 'cert.png', pngBytes(6, 6, 3)), { type: 'event', id: twinBirth });

    const result = mergePersons(tree, personId, twin);
    expect(result.events).toBe(1);
    expect(listMedia(tree, person).map((media) => media.fileName)).toEqual([
      'shared.png',
      'own.png',
    ]);
    expect(listMedia(tree, { type: 'event', id: twinBirth })).toHaveLength(1);
    expect(listPersonEvents(tree, personId)).toHaveLength(2);

    tree.undo();
    expect(listMedia(tree, { type: 'person', id: twin })).toHaveLength(2);
    expect(listMedia(tree, person)).toHaveLength(1);
  });
});

describe('the files of a tree', () => {
  it('are listed newest first, and found by title, description or file name', () => {
    const { tree, files, person } = start();
    const png = (name: string, seed: number) => fileIn(files, name, pngBytes(6, 6, seed));
    const first = add(tree, png('IMG_0001.png', 1), person);
    const second = add(tree, png('IMG_0002.png', 2), null);
    const third = add(tree, png('census 1881.png', 3), person);
    updateMedia(tree, first.id, { title: 'Wedding of John and Mary' });
    updateMedia(tree, second.id, { description: 'The house at 50% of its size, Mill_Lane' });

    expect(countMedia(tree)).toBe(3);
    expect(listAllMedia(tree).map((media) => media.id)).toEqual([third.id, second.id, first.id]);
    expect(listAllMedia(tree, { limit: 1, offset: 1 }).map((media) => media.id)).toEqual([
      second.id,
    ]);

    const found = (query: string) => listAllMedia(tree, { query }).map((media) => media.id);
    expect(found('wedding')).toEqual([first.id]);
    expect(found('CENSUS')).toEqual([third.id]);
    expect(found('img_')).toEqual([second.id, first.id]);
    // The signs of a LIKE pattern are taken as they are written.
    expect(found('50%')).toEqual([second.id]);
    expect(found('mill_lane')).toEqual([second.id]);
    expect(found('%')).toEqual([second.id]);
    expect(found('nothing like it')).toEqual([]);
    expect(countMedia(tree, { query: 'img_' })).toBe(2);

    expect(listAllMedia(tree, { unattached: true }).map((media) => media.id)).toEqual([second.id]);
    expect(countMedia(tree, { unattached: true, query: 'wedding' })).toBe(0);
  });
});

describe('a tree made before files could be attached', () => {
  /** A tree as the app made them before this part: schema version 4. */
  function olderTree(dir: string): Tree {
    const db = openDatabase(join(dir, TREE_FILE_NAME));
    db.pragma(`application_id = ${TREE_APPLICATION_ID}`);
    migrate(db, treeMigrations.slice(0, 4));
    db.prepare(
      "INSERT INTO tree_meta (key, value) VALUES ('id', 'older'), ('name', 'Older'), ('created_at', '0')",
    ).run();
    return new Tree(db, dir);
  }

  it('gets the new tables when it is opened, after a copy is put in its backups folder', () => {
    const dir = tempDir();
    const older = olderTree(dir);
    let personId = '';
    let sourceId = '';
    withLaterColumns(older, () => {
      personId = createPerson(older, {}).id;
      sourceId = createSource(older, { title: 'Parish register' }).id;
    });
    older.close();
    expect(listBackups(dir)).toEqual([]);

    const tree = track(openExistingTree(dir));
    expect(tree.info()).toMatchObject({
      schemaVersion: treeMigrations.length,
      persons: 1,
      sources: 1,
      media: 0,
    });
    const backups = listBackups(dir);
    expect(backups).toHaveLength(1);
    const copy = openDatabase(join(dir, BACKUP_DIR_NAME, backups[0]?.name ?? ''));
    try {
      expect(schemaVersion(copy)).toBe(4);
    } finally {
      copy.close();
    }

    // What was there before can have files attached straight away.
    const file = fileIn(tempDir(), 'a.png', pngBytes(5, 5));
    add(tree, file, { type: 'person', id: personId });
    add(tree, file, { type: 'source', id: sourceId });
    expect(count(tree, 'media')).toBe(1);
    expect(count(tree, 'media_link')).toBe(2);
  });
});

const sha256Of = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** A GEDCOM file that names four files and holds none, as every GEDCOM file does. */
const NAMED = gedcomFile(
  '5.5.1',
  '0 @I1@ INDI',
  '1 NAME Ann /Lee/',
  '1 OBJE @M1@',
  '1 OBJE @M2@',
  '1 OBJE @M3@',
  '1 OBJE @M4@',
  '0 @M1@ OBJE',
  '1 FILE C:/Old PC/Tree Media/1921/wedding.png',
  '2 TITL The wedding',
  '0 @M2@ OBJE',
  '1 FILE C:/Old PC/Tree Media/1930/wedding.png',
  '2 TITL Another wedding',
  '0 @M3@ OBJE',
  '1 FILE https://example.com/scans/Register.PNG?size=full',
  '0 @M4@ OBJE',
  '1 FILE portrait.png',
);

interface Named {
  tree: Tree;
  /** The id of the file with this cross-reference id. */
  id: (xref: string) => string;
}

function named(text = NAMED): Named {
  const tree = track(createTree(tempDir(), { name: 'Named' }));
  importText(tree, text);
  const id = (xref: string) =>
    tree.db.prepare('SELECT id FROM gedcom_record WHERE xref = ?').pluck().get(xref) as string;
  return { tree, id };
}

describe('a file an imported GEDCOM file names', () => {
  it('is in the tree without its file until the file is given', () => {
    const { tree, id } = named();
    const wedding = getMedia(tree, id('M1')) as Media;
    expect(wedding).toMatchObject({ sha256: null, size: 0, title: 'The wedding' });
    expect(mediaFilePath(tree, wedding)).toBeNull();
    expect(isMediaPresent(tree, wedding)).toBe(false);
    expect(countMedia(tree)).toBe(4);
    expect(countMedia(tree, { notHeld: true })).toBe(4);
    expect(listAllMedia(tree, { notHeld: true, query: 'another' }).map((m) => m.title)).toEqual([
      'Another wedding',
    ]);
    expect(storedFiles(tree)).toEqual([]);
  });

  it('holds the file the user points at, as one step that can be undone', () => {
    const { tree, id } = named();
    const bytes = pngBytes(12, 9, 4);
    const chosen = fileIn(tempDir(), 'scan of the wedding.png', bytes);
    const before = undoDepth(tree);

    const held = setMediaFile(tree, id('M1'), chosen);
    expect(held).toMatchObject({
      sha256: sha256Of(bytes),
      ext: 'png',
      mime: 'image/png',
      size: bytes.length,
      fileName: 'scan of the wedding.png',
      title: 'The wedding',
      origin: 'C:/Old PC/Tree Media/1921/wedding.png',
    });
    expect(isMediaPresent(tree, held)).toBe(true);
    expect(undoDepth(tree)).toBe(before + 1);
    expect(tree.undoStatus().undo?.label).toBe('Add the file');
    expect(countMedia(tree, { notHeld: true })).toBe(3);
    expect(() => setMediaFile(tree, id('M1'), chosen)).toThrow(TreeRuleError);

    tree.undo();
    expect(getMedia(tree, id('M1'))).toMatchObject({
      sha256: null,
      size: 0,
      fileName: 'wedding.png',
    });
    // The copy stays, so that Redo finds it.
    expect(storedFiles(tree)).toHaveLength(1);
    tree.redo();
    expect(isMediaPresent(tree, getMedia(tree, id('M1')) as Media)).toBe(true);
  });

  it('takes back a file that went from the folder only when it is the same file', () => {
    const { tree, files, person } = start();
    const bytes = pngBytes(9, 9, 1);
    const media = add(tree, fileIn(files, 'a.png', bytes), person);
    rmSync(mediaFilePath(tree, media) ?? '');
    const depth = undoDepth(tree);

    const other = fileIn(files, 'b.png', pngBytes(9, 9, 2));
    expect(() => setMediaFile(tree, media.id, other)).toThrow(MediaFileError);
    expect(() => setMediaFile(tree, media.id, other)).toThrow(/contents are different/);
    expect(isMediaPresent(tree, media)).toBe(false);
    // Nothing of the refused file is left behind.
    expect(storedFiles(tree)).toEqual([]);

    setMediaFile(tree, media.id, fileIn(files, 'renamed.png', bytes));
    expect(isMediaPresent(tree, media)).toBe(true);
    expect(getMedia(tree, media.id)).toMatchObject({ fileName: 'a.png' });
    // The row did not change, so there is nothing to undo.
    expect(undoDepth(tree)).toBe(depth);
  });

  it('is refused for a tree in memory and for a file that cannot be read', () => {
    const tree = memoryTree();
    importText(tree, NAMED);
    const id = tree.db.prepare("SELECT id FROM gedcom_record WHERE xref = 'M1'").pluck().get();
    expect(() => setMediaFile(tree, id as string, 'anything.png')).toThrow(TreeRuleError);
    expect(() => locateMediaFiles(tree, tempDir())).toThrow(TreeRuleError);

    const onDisk = named();
    expect(() => setMediaFile(onDisk.tree, MISSING, 'a.png')).toThrow(NotFoundError);
    expect(() => setMediaFile(onDisk.tree, onDisk.id('M1'), join(tempDir(), 'none.png'))).toThrow(
      MediaFileError,
    );
  });
});

describe('looking for the files of an imported tree in a folder', () => {
  /** A folder laid out as the computer the GEDCOM file came from had it, under another name. */
  function folder(): { dir: string; first: Buffer; second: Buffer; register: Buffer } {
    const dir = tempDir();
    const first = pngBytes(10, 10, 1);
    const second = pngBytes(10, 10, 2);
    const register = pngBytes(10, 10, 3);
    for (const path of ['Tree Media/1921', 'Tree Media/1930', 'scans', 'x', 'y']) {
      mkdirSync(join(dir, path), { recursive: true });
    }
    fileIn(join(dir, 'Tree Media', '1921'), 'wedding.png', first);
    fileIn(join(dir, 'Tree Media', '1930'), 'wedding.png', second);
    fileIn(join(dir, 'scans'), 'register.png', register);
    fileIn(join(dir, 'x'), 'portrait.png', pngBytes(10, 10, 4));
    fileIn(join(dir, 'y'), 'portrait.png', pngBytes(10, 10, 5));
    return { dir, first, second, register };
  }

  it('finds each by its name, and by its folders where two have one name', () => {
    const { tree, id } = named();
    const { dir, first, second, register } = folder();
    const before = undoDepth(tree);

    expect(locateMediaFiles(tree, dir)).toEqual({
      wanted: 4,
      found: 3,
      ambiguous: 1,
      scanned: 5,
      truncated: false,
    });
    expect(getMedia(tree, id('M1'))?.sha256).toBe(sha256Of(first));
    expect(getMedia(tree, id('M2'))?.sha256).toBe(sha256Of(second));
    // A web address ends in a name too, and upper and lower case do not matter.
    expect(getMedia(tree, id('M3'))).toMatchObject({
      sha256: sha256Of(register),
      fileName: 'register.png',
      origin: 'https://example.com/scans/Register.PNG?size=full',
    });
    // Two files are called portrait.png and nothing tells them apart.
    expect(getMedia(tree, id('M4'))?.sha256).toBeNull();
    expect(storedFiles(tree)).toHaveLength(3);

    // All of it is one step.
    expect(undoDepth(tree)).toBe(before + 1);
    expect(tree.undoStatus().undo?.label).toBe('Find files');
    tree.undo();
    expect(countMedia(tree, { notHeld: true })).toBe(4);
    tree.redo();
    expect(countMedia(tree, { notHeld: true })).toBe(1);

    // With one of the two out of the way, the last file is found as well.
    rmSync(join(dir, 'y', 'portrait.png'));
    expect(locateMediaFiles(tree, dir)).toMatchObject({ wanted: 1, found: 1, ambiguous: 0 });
    expect(tree.undoStatus().undo?.label).toBe('Find file');
    expect(locateMediaFiles(tree, dir)).toMatchObject({ wanted: 0, found: 0, scanned: 0 });
  });

  it('finds nothing in a folder that is empty, missing, or the tree itself', () => {
    const { tree } = named();
    const depth = undoDepth(tree);
    expect(locateMediaFiles(tree, tempDir())).toMatchObject({ wanted: 4, found: 0, scanned: 0 });
    expect(locateMediaFiles(tree, join(tempDir(), 'not there'))).toMatchObject({ found: 0 });
    expect(locateMediaFiles(tree, tree.dir ?? '')).toMatchObject({ found: 0, ambiguous: 0 });
    expect(undoDepth(tree)).toBe(depth);
  });

  it('passes over a file it cannot take and takes the others', () => {
    const { tree, id } = named();
    const dir = tempDir();
    fileIn(dir, 'portrait.png', Buffer.alloc(0));
    mkdirSync(join(dir, '1921'));
    fileIn(join(dir, '1921'), 'wedding.png', pngBytes(6, 6));
    mkdirSync(join(dir, '1930'));
    fileIn(join(dir, '1930'), 'wedding.png', Buffer.alloc(5000, 1));
    expect(locateMediaFiles(tree, dir, { maxBytes: 1000 })).toMatchObject({ wanted: 4, found: 1 });
    expect(getMedia(tree, id('M1'))?.sha256).not.toBeNull();
    expect(storedFiles(tree)).toHaveLength(1);
  });

  it('lets two records hold the same picture, as the imported file has them', () => {
    const { tree, id } = named(
      gedcomFile(
        '5.5.1',
        '0 @I1@ INDI',
        '1 NAME Ann /Lee/',
        '1 OBJE @M1@',
        '0 @M1@ OBJE',
        '1 FILE one.png',
        '0 @M2@ OBJE',
        '1 FILE two.png',
      ),
    );
    const dir = tempDir();
    const bytes = pngBytes(7, 7);
    fileIn(dir, 'one.png', bytes);
    fileIn(dir, 'two.png', bytes);
    expect(locateMediaFiles(tree, dir)).toMatchObject({ wanted: 2, found: 2 });
    expect(getMedia(tree, id('M1'))?.sha256).toBe(sha256Of(bytes));
    expect(getMedia(tree, id('M2'))?.sha256).toBe(sha256Of(bytes));
    // One copy in the folder serves both.
    expect(storedFiles(tree)).toHaveLength(1);

    // Added in the app, the same picture is the record that came first.
    const added = addMediaFiles(tree, [fileIn(dir, 'three.png', bytes)], null);
    expect(added[0]).toMatchObject({ isNew: false, media: { id: id('M1') } });
    expect(count(tree, 'media')).toBe(2);
  });
});
