import { REPORT_GENERATIONS, type PersonReportKind } from '@rulz/core';
import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import type {
  PersonPage,
  ReportFormat,
  ReportPaper,
  ReportPreview,
  ReportSubject,
} from '../../../shared/ipc';
import { api, errorMessage } from '../api';
import { countOf, fullName } from '../format';
import type { ChartKind } from './ChartView';
import { Dialog, SelectField } from './ui';
import './reports.css';

/** The family a report can be made of, with how it is named in the list. */
export interface FamilyChoice {
  familyId: string;
  label: string;
}

/**
 * The families a person's page leads to: those the person is a partner in,
 * then the one they are a child in. A family sheet is made of one of them.
 */
export function familyChoices(page: PersonPage): FamilyChoice[] {
  const named = (names: string[], none: string) =>
    names.length === 0 ? none : names.join(' and ');
  const asPartner = page.partnerFamilies.map((family) => ({
    familyId: family.familyId,
    label: `Their own family, with ${family.partner === null ? 'a partner not recorded' : fullName(family.partner)}`,
  }));
  const asChild = page.parentFamilies.map((family) => ({
    familyId: family.familyId,
    label: `Their parents' family: ${named(
      family.parents.map((parent) => fullName(parent)),
      'parents not recorded',
    )}`,
  }));
  return [...asPartner, ...asChild];
}

/** Letter in the countries that use it, A4 elsewhere; the person can change it. */
function usualPaper(): ReportPaper {
  return /-(US|CA|MX|PH|CL|CO|VE|CR|GT|PA|DO)$/i.test(navigator.language) ? 'Letter' : 'A4';
}

const PAPERS = [
  ['A4', 'A4'],
  ['Letter', 'Letter'],
] as const;

type Outcome = { kind: 'saved'; text: string } | { kind: 'printed' } | null;

interface ReportWindowProps {
  /** The title of the dialog. */
  title: string;
  /** What the preview frame is called to a screen reader. */
  previewTitle: string;
  /** What is asked for, or null when there is nothing to ask for. */
  subject: ReportSubject | null;
  /** Shown instead of the choices and the preview when there is no subject. */
  empty?: ReactNode;
  /** The report's own choices (the family, the generations), beside the choice of paper. */
  leading?: ReactNode;
  /** A short note under the choices. */
  note?: ReactNode;
  /** True for a chart, which can also be saved as a picture. */
  picture?: boolean;
  onClose: () => void;
}

/**
 * The dialog every report is made in: the report's own choices, the choice of
 * paper, whether living people are in it, a preview, and saving as a PDF or a
 * web page or printing. The main process builds the report from the tree;
 * this page sends only the subject and the choice about living people, and
 * shows what comes back in a frame in which nothing can run.
 */
export function ReportWindow({
  title,
  previewTitle,
  subject,
  empty,
  leading,
  note,
  picture = false,
  onClose,
}: ReportWindowProps) {
  const [includeLiving, setIncludeLiving] = useState(false);
  const [paper, setPaper] = useState<ReportPaper>(usualPaper);
  const [shown, setShown] = useState<
    { key: string; preview: ReportPreview } | { key: string; error: string } | null
  >(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const livingId = useId();
  const key = `${JSON.stringify(subject)}|${includeLiving}`;

  useEffect(() => {
    if (subject === null) return;
    let cancelled = false;
    api.previewReport({ ...subject, includeLiving }).then(
      (preview) => {
        if (!cancelled) setShown({ key, preview });
      },
      (failure: unknown) => {
        if (!cancelled) setShown({ key, error: errorMessage(failure) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [subject, includeLiving, key]);

  const current = shown !== null && shown.key === key ? shown : null;
  const preview = current !== null && 'preview' in current ? current.preview : null;
  const refusal = current !== null && 'error' in current ? current.error : null;

  const run = async (action: () => Promise<Outcome>) => {
    setBusy(true);
    setProblem(null);
    setOutcome(null);
    try {
      setOutcome(await action());
    } catch (failure) {
      setProblem(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  const save = (format: ReportFormat) =>
    run(async () => {
      if (subject === null) return null;
      const saved = await api.saveReport({ ...subject, includeLiving, format, paper });
      return saved === null ? null : { kind: 'saved', text: `Saved to ${saved.file}.` };
    });
  const print = () =>
    run(async () => {
      if (subject === null) return null;
      return (await api.printReport({ ...subject, includeLiving, paper }))
        ? { kind: 'printed' }
        : null;
    });

  const leftOut: string[] = [];
  if (preview !== null) {
    if (preview.notesOmitted > 0) leftOut.push(countOf(preview.notesOmitted, 'note', 'notes'));
    if (preview.citationTextsOmitted > 0) {
      leftOut.push(countOf(preview.citationTextsOmitted, 'source text', 'source texts'));
    }
    if (preview.mediaOmitted > 0) {
      leftOut.push(countOf(preview.mediaOmitted, 'picture or document', 'pictures and documents'));
    }
  }
  const ready = preview !== null && !busy;

  return (
    <Dialog title={title} onClose={onClose} wide testId="report-dialog">
      <div className="report-dialog">
        {subject === null ? (
          <p className="dialog-text" data-testid="report-no-family">
            {empty}
          </p>
        ) : (
          <>
            <div className="report-controls">
              {leading}
              <SelectField
                label="Paper"
                value={paper}
                options={PAPERS}
                onChange={setPaper}
                testId="report-paper"
              />
            </div>
            {note !== undefined && <p className="hint">{note}</p>}

            <div className="report-living">
              <label htmlFor={livingId}>
                <input
                  id={livingId}
                  type="checkbox"
                  checked={includeLiving}
                  onChange={(event) => setIncludeLiving(event.target.checked)}
                  data-testid="report-include-living"
                />
                <span>
                  <strong>Include living people</strong>
                </span>
              </label>
              <p className="hint" data-testid="report-omitted">
                {includeLiving
                  ? 'Names, dates, places, notes and pictures of people who may be living are in the report. Leave this off for a report you will share.'
                  : preview === null
                    ? 'People who may be living are shown only as "Living".'
                    : `${
                        subject?.kind === 'family-group'
                          ? countOf(preview.livingOmitted, 'person', 'people')
                          : countOf(preview.livingOmitted, 'entry', 'entries')
                      } shown only as "Living".${
                        leftOut.length > 0
                          ? ` Left out because they may name someone living: ${leftOut.join(', ')}.`
                          : ''
                      }`}
              </p>
            </div>

            {refusal !== null && (
              <p className="error" role="alert" data-testid="report-refused">
                {refusal}
              </p>
            )}
            {refusal === null && (
              <iframe
                className="report-preview"
                title={previewTitle}
                sandbox=""
                srcDoc={preview?.html ?? ''}
                data-testid="report-preview"
              />
            )}
          </>
        )}

        {problem !== null && (
          <p className="error" role="alert" data-testid="report-error">
            {problem}
          </p>
        )}
        <p className="report-outcome" role="status" data-testid="report-outcome">
          {outcome?.kind === 'saved' ? outcome.text : ''}
          {outcome?.kind === 'printed' ? 'Sent to the printer.' : ''}
        </p>

        <div className="dialog-actions">
          <button type="button" onClick={onClose} data-testid="report-close">
            Close
          </button>
          <button
            type="button"
            disabled={!ready}
            onClick={() => void print()}
            data-testid="report-print"
          >
            Print…
          </button>
          {picture && (
            <button
              type="button"
              disabled={!ready}
              onClick={() => void save('svg')}
              data-testid="report-save-svg"
            >
              Save as SVG picture…
            </button>
          )}
          <button
            type="button"
            disabled={!ready}
            onClick={() => void save('html')}
            data-testid="report-save-html"
          >
            Save as web page…
          </button>
          <button
            type="button"
            className="primary"
            disabled={!ready}
            onClick={() => void save('pdf')}
            data-testid="report-save-pdf"
          >
            Save as PDF…
          </button>
        </div>
      </div>
    </Dialog>
  );
}

interface ReportDialogProps {
  page: PersonPage;
  onClose: () => void;
}

/** Makes a family group sheet: the family is chosen here, the rest in the report window. */
export function ReportDialog({ page, onClose }: ReportDialogProps) {
  const choices = useMemo(() => familyChoices(page), [page]);
  const [familyId, setFamilyId] = useState(choices[0]?.familyId ?? '');
  const subject = useMemo(
    (): ReportSubject | null => (familyId === '' ? null : { kind: 'family-group', familyId }),
    [familyId],
  );
  return (
    <ReportWindow
      title="Family group sheet"
      previewTitle="Preview of the family group sheet"
      subject={subject}
      empty="This person has no family recorded yet. Add a partner, a parent or a child first."
      leading={
        <SelectField
          label="Family"
          value={familyId}
          options={choices.map((choice) => [choice.familyId, choice.label] as const)}
          onChange={setFamilyId}
          testId="report-family"
        />
      }
      onClose={onClose}
    />
  );
}

/** The choices of generations, from the least to the most a kind of report allows. */
function generationOptions(kind: PersonReportKind): (readonly [string, string])[] {
  const { min, max } = REPORT_GENERATIONS[kind];
  return Array.from({ length: max - min + 1 }, (_, index): readonly [string, string] => {
    const value = String(min + index);
    return [value, value];
  });
}

interface PersonReportProps {
  personId: string;
  kind: PersonReportKind;
  /** The generations to start with; kept within what the kind allows. */
  initial: number;
  title: string;
  previewTitle: string;
  note: ReactNode;
  picture?: boolean;
  onClose: () => void;
}

/** A report of one person back or down some generations: the generations are chosen here. */
function PersonReportDialog({
  personId,
  kind,
  initial,
  title,
  previewTitle,
  note,
  picture = false,
  onClose,
}: PersonReportProps) {
  const limit = REPORT_GENERATIONS[kind];
  const [generations, setGenerations] = useState(Math.min(Math.max(initial, limit.min), limit.max));
  const subject = useMemo(
    (): ReportSubject => ({ kind, personId, generations }),
    [kind, personId, generations],
  );
  return (
    <ReportWindow
      title={title}
      previewTitle={previewTitle}
      subject={subject}
      leading={
        <SelectField
          label="Generations"
          value={String(generations)}
          options={generationOptions(kind)}
          onChange={(value) => setGenerations(Number(value))}
          testId="report-generations"
        />
      }
      note={note}
      picture={picture}
      onClose={onClose}
    />
  );
}

/** Makes the Ahnentafel of a person: their ancestors as a numbered list. */
export function AhnentafelDialog({ page, onClose }: ReportDialogProps) {
  return (
    <PersonReportDialog
      personId={page.person.id}
      kind="ahnentafel"
      initial={REPORT_GENERATIONS.ahnentafel.initial}
      title="Ahnentafel"
      previewTitle="Preview of the Ahnentafel"
      note="The person is number 1, the father is 2 and the mother 3, and so on back through the generations."
      onClose={onClose}
    />
  );
}

const CHART_REPORT: Record<ChartKind, { kind: PersonReportKind; name: string }> = {
  pedigree: { kind: 'chart-pedigree', name: 'ancestor chart' },
  descendants: { kind: 'chart-descendants', name: 'descendant chart' },
  hourglass: { kind: 'chart-hourglass', name: 'hourglass chart' },
  fan: { kind: 'chart-fan', name: 'fan chart' },
};

interface ChartExportDialogProps {
  personId: string;
  chart: ChartKind;
  /** The generations the chart on the screen shows. */
  generations: number;
  onClose: () => void;
}

/** Saves or prints the chart on the screen whole, on one page. */
export function ChartExportDialog({
  personId,
  chart,
  generations,
  onClose,
}: ChartExportDialogProps) {
  const { kind, name } = CHART_REPORT[chart];
  const { max } = REPORT_GENERATIONS[kind];
  return (
    <PersonReportDialog
      personId={personId}
      kind={kind}
      initial={generations}
      title="Save or print this chart"
      previewTitle={`Preview of the ${name}`}
      note={`The whole chart is put on one page, so it holds at most ${max} generations. More would make the names too small to read.`}
      picture
      onClose={onClose}
    />
  );
}
