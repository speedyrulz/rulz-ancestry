import { cleanText } from '@rulz/connectors';
import { z } from 'zod';
import { findQuote, type QuoteProblem } from './quote';
import type { SharedRecord } from './record';

/**
 * The check of what an AI proposes about one record and one person: whether
 * the record is of the person, how sure it is, and its reasons. What an AI
 * sends is not trusted. It must have the shape of a proposal; every text of
 * it is cleaned; and every reason must quote the record (`quote.ts`).
 *
 * - A reason whose quote is not in the record is dropped, and so is one that
 *   says nothing beside its quote.
 * - A proposal that is left without a reason is refused.
 * - So is one whose verdict no reason stands behind: "it fits" needs a reason
 *   for it, "it does not fit" a reason against it.
 *
 * What was dropped is handed back with what was kept, so that the user can
 * be told. Nothing is written anywhere by this check.
 */

/** The most reasons one proposal may give. */
export const PROPOSAL_REASONS_MAX = 12;

/** The longest explanation of one reason that is kept, in characters. */
export const REASON_TEXT_MAX = 500;

/** What an AI may send at most as one text, before anything is looked at. */
const RAW_MAX = 4000;

/**
 * Whether the record is of the person, as an AI sees it. The words follow the
 * labels of the app: "Fits well", "May fit", "Does not fit".
 */
export const PROPOSAL_VERDICTS = ['fits', 'may-fit', 'does-not-fit'] as const;
export type ProposalVerdict = (typeof PROPOSAL_VERDICTS)[number];

export const PROPOSAL_CONFIDENCES = ['high', 'medium', 'low'] as const;
export type ProposalConfidence = (typeof PROPOSAL_CONFIDENCES)[number];

/** What a proposal must look like, for a tool that takes one. */
export const proposalSchema = z.strictObject({
  verdict: z.enum(PROPOSAL_VERDICTS),
  confidence: z.enum(PROPOSAL_CONFIDENCES),
  reasons: z
    .array(
      z.strictObject({
        /** Whether the reason speaks for the record being of the person, or against it. */
        side: z.enum(['for', 'against']),
        /** The reason in a sentence. */
        text: z.string().max(RAW_MAX),
        /** The words of the record the reason rests on, as they stand there. */
        quote: z.string().max(RAW_MAX),
      }),
    )
    .min(1)
    .max(PROPOSAL_REASONS_MAX),
});

/** A reason whose quote was found. */
export interface CheckedReason {
  side: 'for' | 'against';
  text: string;
  /** The quoted words as they stand in the record. */
  quote: string;
  /** The name of the text of the record the quote is in. */
  field: string;
}

/** A reason that does not count, as the AI gave it. */
export interface DroppedReason {
  side: 'for' | 'against';
  text: string;
  quote: string;
  /** `no-text`: it says nothing beside its quote. The others are those of a quote. */
  why: QuoteProblem | 'no-text';
}

export type CheckedProposal =
  | {
      ok: true;
      verdict: ProposalVerdict;
      confidence: ProposalConfidence;
      reasons: CheckedReason[];
      dropped: DroppedReason[];
    }
  | {
      ok: false;
      /**
       * `shape`: it is no proposal. `no-reason`: no reason of it quotes the
       * record. `unsupported`: reasons are left, and none of them stands
       * behind the verdict.
       */
      problem: 'shape' | 'no-reason' | 'unsupported';
      message: string;
      dropped: DroppedReason[];
    };

/**
 * Checks a proposal against the record as it was passed on. `input` is what
 * the AI sent, as it came.
 */
export function checkProposal(input: unknown, record: SharedRecord): CheckedProposal {
  const parsed = proposalSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      problem: 'shape',
      message:
        'This is no proposal: it needs a verdict, a confidence, and one to twelve reasons that each quote the record.',
      dropped: [],
    };
  }
  const { verdict, confidence } = parsed.data;
  const reasons: CheckedReason[] = [];
  const dropped: DroppedReason[] = [];
  const seen = new Set<string>();
  for (const reason of parsed.data.reasons) {
    const text = cleanText(reason.text, REASON_TEXT_MAX);
    const check = text === '' ? null : findQuote(reason.quote, record);
    if (check?.found === true) {
      // The same reason twice is one reason.
      const key = `${reason.side}\n${check.field}\n${check.text}\n${text}`;
      if (!seen.has(key))
        reasons.push({ side: reason.side, text, quote: check.text, field: check.field });
      seen.add(key);
    } else {
      dropped.push({
        side: reason.side,
        text,
        quote: cleanText(reason.quote, REASON_TEXT_MAX),
        why: check === null ? 'no-text' : check.why,
      });
    }
  }
  if (reasons.length === 0) {
    return {
      ok: false,
      problem: 'no-reason',
      message: 'No reason of this proposal quotes the record, so it is not shown.',
      dropped,
    };
  }
  const needed = verdict === 'fits' ? 'for' : verdict === 'does-not-fit' ? 'against' : null;
  if (needed !== null && !reasons.some((reason) => reason.side === needed)) {
    return {
      ok: false,
      problem: 'unsupported',
      message:
        needed === 'for'
          ? 'This proposal says the record fits, and none of its reasons that quote the record speaks for that.'
          : 'This proposal says the record does not fit, and none of its reasons that quote the record speaks against it.',
      dropped,
    };
  }
  return { ok: true, verdict, confidence, reasons, dropped };
}
