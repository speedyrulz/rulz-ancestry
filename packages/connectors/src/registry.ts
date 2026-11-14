import type { ConnectorManifest, ConnectorTier } from './manifest';
import { familySearchRecordsManifest } from './sources/familysearch-records/manifest';
import { findAGraveManifest } from './sources/find-a-grave/manifest';
import { internetArchiveManifest } from './sources/internet-archive/manifest';
import { locManifest } from './sources/loc/manifest';
import { nara1940CensusManifest } from './sources/nara-1940-census/manifest';
import { nara1950CensusManifest } from './sources/nara-1950-census/manifest';
import { naraCatalogManifest } from './sources/nara-catalog/manifest';
import { openArchivesManifest } from './sources/open-archives/manifest';
import { wikidataManifest } from './sources/wikidata/manifest';
import { wikitreeManifest } from './sources/wikitree/manifest';

/** Every data source the app knows about. Add new sources here. */
export const manifests: readonly ConnectorManifest[] = [
  wikitreeManifest,
  wikidataManifest,
  locManifest,
  internetArchiveManifest,
  naraCatalogManifest,
  openArchivesManifest,
  nara1950CensusManifest,
  nara1940CensusManifest,
  findAGraveManifest,
  familySearchRecordsManifest,
];

const byId = new Map<string, ConnectorManifest>();
for (const manifest of manifests) {
  if (byId.has(manifest.id)) {
    throw new Error(`duplicate connector id: ${manifest.id}`);
  }
  byId.set(manifest.id, manifest);
}

export function getManifest(id: string): ConnectorManifest | undefined {
  return byId.get(id);
}

export function manifestsByTier(tier: ConnectorTier): ConnectorManifest[] {
  return manifests.filter((manifest) => manifest.tier === tier);
}
