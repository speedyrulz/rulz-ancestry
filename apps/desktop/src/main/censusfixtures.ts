import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NARA_CENSUS_PACK_KIND, censusStateUrl } from '@rulz/connectors';
import { buildPack } from './packbuild';
import { PACKS_MARKER } from './packs';

/**
 * Helpers for tests (and the end-to-end test) of the 1950 census packs: a pack
 * built from a made-up state file in a packs folder, the way an install builds
 * one. Every name in the fixtures is made up.
 */

/** The folder of the made-up state, territory and listing files. */
export const CENSUS_FIXTURES = join(
  import.meta.dirname,
  '../../../../packages/connectors/src/sources/nara-1950-census/fixtures',
);

/** A JPEG as far as the app can tell: it starts with the bytes FF D8 FF. */
export const TINY_JPEG = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9,
]);

/** Builds the pack of a state file into `<root>/<id>.pack`, with the marker that says the folder is the app's. */
export async function buildCensusPack(
  root: string,
  options: {
    id?: string;
    file: string;
    downloadedAt?: string;
    code?: string;
  },
): Promise<string> {
  const id = options.id ?? 'c50de';
  mkdirSync(root, { recursive: true });
  if (!existsSync(join(root, PACKS_MARKER))) {
    writeFileSync(join(root, PACKS_MARKER), 'The data packs of RulZ Ancestry.\r\n');
  }
  const outPath = join(root, `${id}.pack`);
  await buildPack(
    {
      kind: NARA_CENSUS_PACK_KIND,
      outPath,
      files: [
        {
          path: options.file,
          url: censusStateUrl(options.code ?? id.slice(3)),
          bytes: 1,
          sha256: '0'.repeat(64),
          etag: null,
          modified: null,
        },
      ],
      meta: {
        packId: id,
        title: '1950 census: Testland',
        sourceName: '1950 US Census (National Archives)',
        sourceUrl: 'https://1950census.archives.gov',
        licence: 'Public domain (US Government work)',
        credit: '1950 Census, National Archives and Records Administration',
        downloadedAt: options.downloadedAt ?? '2026-03-04',
        sourceModified: '2022-04-01',
      },
      reserveBytes: 1,
    },
    { stop: () => false, progress: () => undefined },
  );
  return outPath;
}
