import { trackChanges, untrackChanges } from '../changelog';
import { extractCitationAddresses } from '../gedcom/citations';
import type { Migration } from '../migrate';

/**
 * Web addresses.
 *
 * A citation gains `url`, the address of the page or record it is about, and
 * `accessed_at`, the day that page was consulted, as `YYYY-MM-DD`. Both are
 * empty when not stated. A page on the web can change or go; the day says
 * what the citation saw.
 *
 * A source gains `connector_id`: the id of the site the app knows (as in its
 * manifest in `@rulz/connectors`) whose records this source stands for.
 * A tree has at most one source per site, so that every record attached from
 * a search of WikiTree cites the same source. NULL for every other source.
 * A GEDCOM file has no line for it; see `connectorSourceId` in `sources.ts`
 * for how a tree that came from a file finds its source again.
 *
 * Trees imported before this version held the address Ancestry gives a
 * citation as a line kept as written; it is filled in here (see
 * `extractCitationAddresses`).
 */
const TABLES = ['citation', 'source'] as const;

export const citationAddresses: Migration = {
  version: 9,
  name: 'web addresses of citations',
  up(db) {
    // The addresses are written while the tables are not tracked: a migration
    // is not an edit, and leaves nothing to undo.
    for (const table of TABLES) untrackChanges(db, table);
    db.exec(`
      ALTER TABLE citation ADD COLUMN url TEXT NOT NULL DEFAULT '';
      ALTER TABLE citation ADD COLUMN accessed_at TEXT NOT NULL DEFAULT '';
      ALTER TABLE source ADD COLUMN connector_id TEXT;
      CREATE UNIQUE INDEX source_connector ON source(connector_id)
        WHERE connector_id IS NOT NULL;
    `);
    extractCitationAddresses(db);
    // Again, because the triggers list the columns and each table has new ones.
    for (const table of TABLES) trackChanges(db, table);
  },
};
