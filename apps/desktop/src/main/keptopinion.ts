import {
  PROPOSAL_CONFIDENCES,
  PROPOSAL_REASONS_MAX,
  PROPOSAL_VERDICTS,
  checkProposal,
  recordTextsOf,
  type CheckedReason,
  type ProposalConfidence,
  type ProposalVerdict,
} from '@rulz/ai';
import type { ConnectorManifest } from '@rulz/connectors';
import type { ExternalRecord } from '@rulz/core';
import { RECORD_MARK_AI_JSON_MAX, type RecordMark } from '@rulz/db';
import { z } from 'zod';
import type { AiOpinionInfo } from '../shared/ipc';
import { whenOf } from './keptrecord';

/**
 * What an AI said of a record, as the tree keeps it with a result that the
 * user kept from a proposal of the AI assistant, and as it is read back.
 *
 * What is kept is what passed the check of a proposal (`@rulz/ai`): the
 * verdict, how sure the AI was, when it said so, and the reasons whose quotes
 * were found in the record. A reason that did not pass is not kept: it is
 * text of an AI that nothing of the record stands behind.
 *
 * What is read back is not trusted, as nothing of a tree's file is. It must
 * have the shape of what is kept, and then it goes through the check of a
 * proposal again, against the kept record as `keptrecord.ts` read it: every
 * quote is looked up in that record once more, and the verdict needs a reason
 * behind it as it did when the AI gave it. So a file that was written by
 * something else cannot put words beside a record as if the record said them.
 * The check says that the quoted words are in the kept record. It does not
 * say that an AI wrote the reason: whoever can write the file could have.
 *
 * Nothing here is passed on to an AI. The texts of the kept record are made
 * for the check only (`recordTextsOf`), for the user's own screen.
 */

/** The opinion of an AI as it is handed in for keeping. */
export interface OpinionToKeep {
  verdict: ProposalVerdict;
  confidence: ProposalConfidence;
  /** When the AI proposed it, in Unix milliseconds. */
  at: number;
  /** The reasons whose quotes were found in the record. */
  reasons: readonly CheckedReason[];
}

/** What an AI may have sent at most as one text; the check of a proposal takes no more. */
const RAW_MAX = 4000;

const kept = z.strictObject({
  /** The form of what is kept. Another number is one this version cannot read. */
  v: z.literal(1),
  verdict: z.enum(PROPOSAL_VERDICTS),
  confidence: z.enum(PROPOSAL_CONFIDENCES),
  /** Looked at by `whenOf`: a moment that is none is left out. */
  proposedAt: z.unknown(),
  reasons: z
    .array(
      z.strictObject({
        side: z.enum(['for', 'against']),
        text: z.string().max(RAW_MAX),
        quote: z.string().max(RAW_MAX),
      }),
    )
    .min(1)
    .max(PROPOSAL_REASONS_MAX),
});

/**
 * What is kept of an opinion, as JSON; null when it is too long to keep. The
 * name of the text a quote is in is not kept: it is found again when the
 * opinion is read back.
 */
export function keptOpinionJson(opinion: OpinionToKeep): string | null {
  const json = JSON.stringify({
    v: 1,
    verdict: opinion.verdict,
    confidence: opinion.confidence,
    proposedAt: opinion.at,
    reasons: opinion.reasons.map(({ side, text, quote }) => ({ side, text, quote })),
  } satisfies z.input<typeof kept>);
  return json.length > RECORD_MARK_AI_JSON_MAX ? null : json;
}

/** Shown where a mark holds something of an AI that does not pass the check. */
export const OPINION_UNREADABLE =
  'The tree holds reasons of an AI for this result that cannot be shown: they do not quote the record as it is kept.';

/**
 * The opinion a kept mark holds, checked again against the record the mark
 * keeps; or why it is not shown. `record` is the kept record as it was read
 * back and checked, null when it cannot be used. A mark without an opinion
 * gives neither.
 */
export function keptOpinionOf(
  mark: RecordMark,
  record: ExternalRecord | null,
  manifest: ConnectorManifest | undefined,
): { ai: AiOpinionInfo | null; problem: string } {
  if (mark.aiJson === null) return { ai: null, problem: '' };
  const unreadable = { ai: null, problem: OPINION_UNREADABLE };
  if (
    mark.state !== 'kept' ||
    record === null ||
    manifest === undefined ||
    typeof mark.aiJson !== 'string' ||
    mark.aiJson.length > RECORD_MARK_AI_JSON_MAX
  ) {
    return unreadable;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(mark.aiJson);
  } catch {
    return unreadable;
  }
  const held = kept.safeParse(parsed);
  if (!held.success) return unreadable;
  const { verdict, confidence, reasons, proposedAt } = held.data;
  // The same check as when the AI gave it, against the record as the tree keeps it.
  const checked = checkProposal({ verdict, confidence, reasons }, recordTextsOf(record, manifest));
  if (!checked.ok) return unreadable;
  return {
    ai: {
      verdict: checked.verdict,
      confidence: checked.confidence,
      reasons: checked.reasons.map(({ side, text, quote, field }) => ({
        side,
        text,
        quote,
        field,
      })),
      proposedAt: whenOf(proposedAt),
    },
    problem: '',
  };
}
