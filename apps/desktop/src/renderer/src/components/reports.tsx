import { useEffect, useId, useMemo, useState } from 'react';
import type {
  PersonPage,
  ReportFormat,
  ReportPaper,
  ReportPreview,
  ReportRequest,
} from '../../../shared/ipc';
import { api, errorMessage } from '../api';
import { countOf, fullName } from '../format';
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

interface ReportDialogProps {
  page: PersonPage;
  onClose: () => void;
}

/**
 * Makes a family group sheet: choose the family, say whether living people
 * are in it, look at it, and save it as a PDF or a web page or print it. The
 * main process builds the report from the tree; this page sends only the
 * family and the choice about living people, and shows what comes back in a
 * frame in which nothing can run.
 */
export function ReportDialog({ page, onClose }: ReportDialogProps) {
  const choices = useMemo(() => familyChoices(page), [page]);
  const [familyId, setFamilyId] = useState(choices[0]?.familyId ?? '');
  const [includeLiving, setIncludeLiving] = useState(false);
  const [paper, setPaper] = useState<ReportPaper>(usualPaper);
  const [shown, setShown] = useState<
    { key: string; preview: ReportPreview } | { key: string; error: string } | null
  >(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const livingId = useId();
  const key = `${familyId}|${includeLiving}`;

  useEffect(() => {
    if (familyId === '') return;
    let cancelled = false;
    api.previewReport({ kind: 'family-group', familyId, includeLiving }).then(
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
  }, [familyId, includeLiving, key]);

  const current = shown !== null && shown.key === key ? shown : null;
  const preview = current !== null && 'preview' in current ? current.preview : null;
  const refusal = current !== null && 'error' in current ? current.error : null;
  const request: ReportRequest = { kind: 'family-group', familyId, includeLiving };

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
      const saved = await api.saveReport({ ...request, format, paper });
      return saved === null ? null : { kind: 'saved', text: `Saved to ${saved.file}.` };
    });
  const print = () =>
    run(async () => ((await api.printReport({ ...request, paper })) ? { kind: 'printed' } : null));

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
    <Dialog title="Family group sheet" onClose={onClose} wide testId="report-dialog">
      <div className="report-dialog">
        {choices.length === 0 ? (
          <p className="dialog-text" data-testid="report-no-family">
            This person has no family recorded yet. Add a partner, a parent or a child first.
          </p>
        ) : (
          <>
            <div className="report-controls">
              <SelectField
                label="Family"
                value={familyId}
                options={choices.map((choice) => [choice.familyId, choice.label] as const)}
                onChange={setFamilyId}
                testId="report-family"
              />
              <SelectField
                label="Paper"
                value={paper}
                options={PAPERS}
                onChange={setPaper}
                testId="report-paper"
              />
            </div>

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
                    : `${countOf(preview.livingOmitted, 'person', 'people')} shown only as "Living".${
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
                title="Preview of the family group sheet"
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
