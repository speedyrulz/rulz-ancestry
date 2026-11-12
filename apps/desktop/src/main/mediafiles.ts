import { canOpenOutside, mediaKind, type MediaKind } from '@rulz/core';
import { getMedia, isMediaPresent, mediaFilePath } from '@rulz/db';
import { MEDIA_SCHEME } from '../shared/ipc';
import type { TreeSession } from './session';

/**
 * Finds the file behind an address the page loads a picture from
 * (`rulz-media://file/<id>` or `rulz-media://thumb/<id>`).
 *
 * The page can name a file only by the id of a row in the open tree. The path
 * is worked out here from that row, so no address can reach a file outside
 * the tree's media folder. Nothing here uses Electron.
 */

export interface MediaRequest {
  /** `file` for the file itself, `thumb` for a small version of it. */
  variant: 'file' | 'thumb';
  mediaId: string;
}

export interface MediaFile extends MediaRequest {
  /** The full path of the file in the tree's media folder. */
  path: string;
  mime: string;
  size: number;
  kind: MediaKind;
}

const ID_PATH = /^\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** Reads an address of the media scheme. Null for anything that is not exactly one. */
export function parseMediaUrl(address: string): MediaRequest | null {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return null;
  }
  if (url.protocol !== `${MEDIA_SCHEME}:`) return null;
  if (url.hostname !== 'file' && url.hostname !== 'thumb') return null;
  if (url.search !== '' || url.hash !== '' || url.username !== '' || url.port !== '') return null;
  const match = ID_PATH.exec(url.pathname);
  return match ? { variant: url.hostname, mediaId: match[1] ?? '' } : null;
}

/**
 * The file an address stands for, or null when there is none to serve: no
 * tree is open, the row or the file is gone, or the address asks for the file
 * itself and it is not a picture the window draws. A document is never sent
 * to the page; only a small preview of it may be, and only for kinds of
 * document that cannot run.
 */
export function findMediaFile(session: TreeSession, address: string): MediaFile | null {
  const request = parseMediaUrl(address);
  if (request === null || !session.isOpen) return null;
  const tree = session.tree;
  const media = getMedia(tree, request.mediaId);
  if (media === null || !isMediaPresent(tree, media)) return null;
  const path = mediaFilePath(tree, media);
  if (path === null) return null;
  const kind = mediaKind(media.mime);
  if (kind !== 'image') {
    if (request.variant === 'file') return null;
    // A preview is made by whatever Windows has installed for the kind of
    // file. Only kinds the app would also hand to another program get one.
    if (!canOpenOutside(media.ext)) return null;
  }
  return { ...request, path, mime: media.mime, size: media.size, kind };
}
