import { sql } from './connection';
import type { Tree } from './tree';

/**
 * Who may still be alive. Exports and reports leave these people out unless the
 * user asks for everyone, so that details of living people are not passed on by
 * accident.
 */

/** Someone with nothing to show they have died is taken to be living up to this age. */
export const PRESUMED_LIVING_YEARS = 110;

/** Event types that only happen once a person has died. */
const AFTER_DEATH = ['death', 'burial', 'cremation', 'probate'] as const;

/** The Julian Day Number of a moment given in Unix milliseconds. */
function jdnOf(time: number): number {
  return Math.floor(time / 86_400_000) + 2_440_588;
}

/** What the rule looks at for one person; see {@link decide}. */
interface LivingFacts {
  id: string;
  living: number | null;
  /** A death, burial, cremation or probate of their own. */
  died: number;
  /** An event of their own or of a couple they are in that certainly took place long ago. */
  old: number;
  /** A birth that certainly took place long ago. */
  bornLongAgo: number;
  /** A birth with a date that could be read. */
  bornKnown: number;
}

/**
 * Reads the facts the rule needs, for everyone or for one person. Only
 * someone with no mark of their own is looked into; the marks decide the rest.
 */
function readFacts(tree: Tree, now: number, personId: string | null): LivingFacts[] {
  const cutoff = jdnOf(now) - Math.round(PRESUMED_LIVING_YEARS * 365.25);
  const afterDeath = AFTER_DEATH.map((type) => `'${type}'`).join(', ');
  const text = `SELECT p.id AS id, p.living AS living,
      CASE WHEN p.living IS NULL THEN EXISTS (
        SELECT 1 FROM event_participant ep JOIN event e ON e.id = ep.event_id
        WHERE ep.person_id = p.id AND e.type IN (${afterDeath})) ELSE 0 END AS died,
      CASE WHEN p.living IS NULL THEN (
        EXISTS (
          SELECT 1 FROM event_participant ep JOIN event e ON e.id = ep.event_id
          WHERE ep.person_id = p.id
            AND e.date_max_jdn IS NOT NULL AND e.date_max_jdn < @cutoff)
        OR EXISTS (
          SELECT 1 FROM family f
            JOIN event_participant ep ON ep.family_id = f.id
            JOIN event e ON e.id = ep.event_id
          WHERE (f.partner1_id = p.id OR f.partner2_id = p.id)
            AND e.date_max_jdn IS NOT NULL AND e.date_max_jdn < @cutoff)
      ) ELSE 0 END AS old,
      CASE WHEN p.living IS NULL THEN EXISTS (
        SELECT 1 FROM event_participant ep JOIN event e ON e.id = ep.event_id
        WHERE ep.person_id = p.id AND e.type = 'birth'
          AND e.date_max_jdn IS NOT NULL AND e.date_max_jdn < @cutoff) ELSE 0 END AS bornLongAgo,
      CASE WHEN p.living IS NULL THEN EXISTS (
        SELECT 1 FROM event_participant ep JOIN event e ON e.id = ep.event_id
        WHERE ep.person_id = p.id AND e.type = 'birth'
          AND e.date_max_jdn IS NOT NULL) ELSE 0 END AS bornKnown
    FROM person p`;
  return personId === null
    ? (sql(tree.db, text).all({ cutoff }) as LivingFacts[])
    : (sql(tree.db, `${text} WHERE p.id = @personId`).all({ cutoff, personId }) as LivingFacts[]);
}

/** Why a person is taken to be living or deceased. */
export type LivingReason =
  | 'marked-living'
  | 'marked-deceased'
  | 'death-recorded'
  | 'born-long-ago'
  | 'event-long-ago'
  | 'born-recently'
  | 'nothing-shows-death';

/** The rule in one place: the reason, from which {@link LivingVerdict.living} follows. */
function decide(facts: LivingFacts): LivingReason {
  if (facts.living === 1) return 'marked-living';
  if (facts.living === 0) return 'marked-deceased';
  if (facts.died) return 'death-recorded';
  if (facts.bornLongAgo) return 'born-long-ago';
  if (facts.old) return 'event-long-ago';
  return facts.bornKnown ? 'born-recently' : 'nothing-shows-death';
}

const DECEASED = new Set<LivingReason>([
  'marked-deceased',
  'death-recorded',
  'born-long-ago',
  'event-long-ago',
]);

const REASON_TEXT: Readonly<Record<LivingReason, string>> = {
  'marked-living': 'Marked living by hand',
  'marked-deceased': 'Marked deceased by hand',
  'death-recorded': 'Deceased: death recorded',
  'born-long-ago': `Deceased: born more than ${PRESUMED_LIVING_YEARS} years ago`,
  'event-long-ago': `Deceased: an event of theirs is more than ${PRESUMED_LIVING_YEARS} years old`,
  'born-recently': `Presumed living: no death recorded and born less than ${PRESUMED_LIVING_YEARS} years ago`,
  'nothing-shows-death': 'Presumed living: nothing recorded shows that they have died',
};

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
  const ids = readFacts(tree, now, null)
    .filter((facts) => !DECEASED.has(decide(facts)))
    .map((facts) => facts.id);
  return new Set(ids);
}

/** How the rule sees one person, and in words why. */
export interface LivingVerdict {
  /** True when the person is left out of what is shared: marked living, or presumed so. */
  living: boolean;
  reason: LivingReason;
  /** The reason as a sentence for the person page, e.g. "Deceased: death recorded". */
  text: string;
}

/**
 * Why the rule of {@link presumedLivingIds} takes one person to be living or
 * deceased. It is that rule, not a second copy: both read the same facts and
 * call the same `decide`. Null when there is no such person.
 */
export function livingReason(
  tree: Tree,
  personId: string,
  now: number = Date.now(),
): LivingVerdict | null {
  const facts = readFacts(tree, now, personId)[0];
  if (facts === undefined) return null;
  const reason = decide(facts);
  return { living: !DECEASED.has(reason), reason, text: REASON_TEXT[reason] };
}
