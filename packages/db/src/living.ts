import { sql } from './connection';
import type { Tree } from './tree';

/**
 * Who may still be alive. Exports leave these people out unless the user asks
 * for everyone, so that details of living people are not passed on by accident.
 */

/** Someone with nothing to show they have died is taken to be living up to this age. */
export const PRESUMED_LIVING_YEARS = 110;

/** Event types that only happen once a person has died. */
const AFTER_DEATH = ['death', 'burial', 'cremation', 'probate'] as const;

/** The Julian Day Number of a moment given in Unix milliseconds. */
function jdnOf(time: number): number {
  return Math.floor(time / 86_400_000) + 2_440_588;
}

/**
 * The ids of the people who may be living. The rule errs on the side of
 * privacy:
 *
 * - someone marked living is living, and someone marked deceased is not;
 * - otherwise a person is taken to be deceased only when there is something to
 *   show it: a death, burial, cremation or probate, or an event of their own
 *   or of a couple they are in that certainly took place more than
 *   {@link PRESUMED_LIVING_YEARS} years ago;
 * - everyone else, including a person with no dates at all, may be living.
 */
export function presumedLivingIds(tree: Tree, now: number = Date.now()): Set<string> {
  const cutoff = jdnOf(now) - Math.round(PRESUMED_LIVING_YEARS * 365.25);
  const afterDeath = AFTER_DEATH.map((type) => `'${type}'`).join(', ');
  const ids = sql(
    tree.db,
    `SELECT p.id FROM person p
     WHERE p.living = 1
        OR (p.living IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM event_participant ep JOIN event e ON e.id = ep.event_id
              WHERE ep.person_id = p.id
                AND (e.type IN (${afterDeath})
                     OR (e.date_max_jdn IS NOT NULL AND e.date_max_jdn < @cutoff)))
            AND NOT EXISTS (
              SELECT 1 FROM family f
                JOIN event_participant ep ON ep.family_id = f.id
                JOIN event e ON e.id = ep.event_id
              WHERE (f.partner1_id = p.id OR f.partner2_id = p.id)
                AND e.date_max_jdn IS NOT NULL AND e.date_max_jdn < @cutoff))`,
  )
    .pluck()
    .all({ cutoff }) as string[];
  return new Set(ids);
}
