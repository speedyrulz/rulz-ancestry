import { trackChanges, untrackChanges } from '../changelog';
import type { Migration } from '../migrate';

/**
 * What an AI said of a kept result.
 *
 * `record_mark` gains `ai_json`. A result that the user kept from a proposal
 * of the optional AI assistant holds there what the AI said of it: whether
 * the record is of the person, how sure it was, and its reasons, each with
 * the words of the record it quotes. NULL for every other mark.
 *
 * It is a column of the mark and no table of its own, because it belongs to
 * one reading of one result for one person: it is kept in the same step as
 * the record, goes with the mark when the mark goes or its person is merged,
 * and comes back with it when that is undone.
 *
 * Only a kept mark has it. A result that is turned down, or kept again as a
 * search reads it now, loses it: the reasons quote the record as it read when
 * the AI was given it, and would otherwise stand beside another reading.
 *
 * Nothing here knows what the JSON holds. Whoever reads it back checks it
 * again, and looks every quote up in the kept record once more: a tree's
 * folder can come from anywhere.
 *
 * Nothing of this is written to a GEDCOM file.
 */
export const recordMarkReasons: Migration = {
  version: 11,
  name: 'what an AI said of a kept result',
  up(db) {
    untrackChanges(db, 'record_mark');
    db.exec(`
      ALTER TABLE record_mark ADD COLUMN ai_json TEXT
        CHECK (ai_json IS NULL OR (state = 'kept' AND length(ai_json) <= 16384));
    `);
    // Again, because the triggers list the columns and the table has a new one.
    trackChanges(db, 'record_mark');
  },
};
