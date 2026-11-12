import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addMediaFiles, createPerson, openAppDatabase, type Db } from '@rulz/db';
import { mediaUrl } from '../shared/ipc';
import { findMediaFile, parseMediaUrl } from './mediafiles';
import { TreeSession } from './session';

const ID = '01890a5d-ac96-774b-bcce-b302099a8057';

let root: string;
let appDb: Db;
let session: TreeSession;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rulz-mediafiles-'));
  appDb = openAppDatabase(':memory:');
  session = new TreeSession({ appDb, defaultParentDir: join(root, 'Trees') });
});

afterEach(() => {
  session.shutdown();
  appDb.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** Adds a file with the given first bytes to the open tree, attached to nothing. */
function add(name: string, contents: Buffer | string): string {
  const file = join(root, name);
  writeFileSync(file, contents);
  const [added] = session.change((tree) => addMediaFiles(tree, [file], null));
  return added?.media.id ?? '';
}

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('a picture'),
]);

describe('parseMediaUrl', () => {
  it('reads the two kinds of address the page uses', () => {
    expect(parseMediaUrl(mediaUrl(ID, 'file'))).toEqual({ variant: 'file', mediaId: ID });
    expect(parseMediaUrl(mediaUrl(ID, 'thumb'))).toEqual({ variant: 'thumb', mediaId: ID });
    expect(mediaUrl(ID, 'file')).toBe(`rulz-media://file/${ID}`);
  });

  it('refuses everything else', () => {
    for (const address of [
      '',
      'not an address',
      `https://file/${ID}`,
      `file:///C:/Windows/win.ini`,
      `rulz-media://other/${ID}`,
      `rulz-media://file/`,
      `rulz-media://file/${ID}/extra`,
      `rulz-media://file/${ID}/../../tree.db`,
      `rulz-media://file/..%2F..%2Ftree.db`,
      `rulz-media://file/C:%5CWindows%5Cwin.ini`,
      `rulz-media://file/${ID.toUpperCase()}`,
      `rulz-media://file/${ID}?download=1`,
      `rulz-media://file/${ID}#top`,
      `rulz-media://user@file/${ID}`,
      `rulz-media://file:8080/${ID}`,
    ]) {
      expect(parseMediaUrl(address), address).toBeNull();
    }
  });

  it('reads nothing but an id out of an address, whatever dots it holds', () => {
    // An address is tidied before it is read, so this one names the id and nothing above it.
    expect(parseMediaUrl(`rulz-media://file/../${ID}`)).toEqual({ variant: 'file', mediaId: ID });
  });
});

describe('findMediaFile', () => {
  it('finds a picture of the open tree, as itself and as a small version', () => {
    const state = session.create('Family', join(root, 'Trees'));
    const id = add('portrait.png', PNG);

    const file = findMediaFile(session, mediaUrl(id, 'file'));
    expect(file).toMatchObject({
      variant: 'file',
      mediaId: id,
      mime: 'image/png',
      size: PNG.length,
      kind: 'image',
    });
    expect(file?.path.startsWith(join(state.dir, 'media'))).toBe(true);
    expect(file?.path).toMatch(/[0-9a-f]{64}\.png$/);
    expect(findMediaFile(session, mediaUrl(id, 'thumb'))?.path).toBe(file?.path);
  });

  it('never gives the page a document itself, only what a preview is made from', () => {
    session.create('Family', join(root, 'Trees'));
    const id = add('will.pdf', '%PDF-1.4 a will');
    expect(findMediaFile(session, mediaUrl(id, 'file'))).toBeNull();
    expect(findMediaFile(session, mediaUrl(id, 'thumb'))).toMatchObject({
      kind: 'document',
      mime: 'application/pdf',
    });

    // Windows is not asked for a preview of a kind of file the app would not open either.
    const program = add('setup.exe', 'MZ this would be a program');
    expect(findMediaFile(session, mediaUrl(program, 'file'))).toBeNull();
    expect(findMediaFile(session, mediaUrl(program, 'thumb'))).toBeNull();
    const unknown = add('data.xyz', 'nobody knows what this is');
    expect(findMediaFile(session, mediaUrl(unknown, 'thumb'))).toBeNull();
  });

  it('finds nothing for an unknown file, a file that has gone, or no tree', () => {
    expect(findMediaFile(session, mediaUrl(ID, 'file'))).toBeNull();

    session.create('Family', join(root, 'Trees'));
    expect(findMediaFile(session, mediaUrl(ID, 'file'))).toBeNull();
    expect(findMediaFile(session, 'rulz-media://file/..%2F..%2Ftree.db')).toBeNull();

    const id = add('portrait.png', PNG);
    const path = findMediaFile(session, mediaUrl(id, 'file'))?.path ?? '';
    rmSync(path);
    expect(findMediaFile(session, mediaUrl(id, 'file'))).toBeNull();

    // A person's id is not a file's id.
    const personId = session.change((tree) => createPerson(tree, {}).id);
    expect(findMediaFile(session, mediaUrl(personId, 'file'))).toBeNull();

    session.close();
    expect(findMediaFile(session, mediaUrl(id, 'thumb'))).toBeNull();
  });
});
