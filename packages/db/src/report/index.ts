import { REPORT_KINDS, type ReportKind } from '@rulz/core';
import type { Tree } from '../tree';
import { buildFamilyGroupSheet, type ReportBuild } from './familygroup';
import type { ReportPrivacy } from './filter';

export { ReportFilter, ReportRefusedError } from './filter';
export type { ReportOmissions, ReportPrivacy } from './filter';
export { buildFamilyGroupSheet } from './familygroup';
export type { ReportBuild } from './familygroup';

/** What a report is about, named by kind. The page sends nothing else. */
export type ReportSubject = { kind: 'family-group'; familyId: string };

type Builder<K extends ReportKind> = (
  tree: Tree,
  subject: Extract<ReportSubject, { kind: K }>,
  privacy: ReportPrivacy,
) => ReportBuild;

/**
 * Every kind of report, with the function that builds it. A kind added to
 * `REPORT_KINDS` fails to compile until it has a builder here, and fails the
 * leak test until it has a row there.
 */
export const REPORT_BUILDERS: { readonly [K in ReportKind]: Builder<K> } = {
  'family-group': (tree, subject, privacy) =>
    buildFamilyGroupSheet(tree, subject.familyId, privacy),
};

/** Builds a report of any kind. The living filter is an argument that cannot be left out. */
export function buildReport(
  tree: Tree,
  subject: ReportSubject,
  privacy: ReportPrivacy,
): ReportBuild {
  const kinds: readonly string[] = REPORT_KINDS;
  if (!kinds.includes(subject.kind)) throw new Error(`unknown kind of report: ${subject.kind}`);
  return REPORT_BUILDERS[subject.kind](tree, subject, privacy);
}
