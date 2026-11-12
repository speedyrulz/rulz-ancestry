import type { GedcomVersion } from '@rulz/core';
import { useEffect, useId, useState } from 'react';
import type { GedcomExportInfo, GedcomImportInfo, TreeState } from '../../../shared/ipc';
import { api, errorMessage } from '../api';
import { countOf } from '../format';
import { Dialog } from './ui';

/** The dialogs for GEDCOM files: what an import did, and exporting the open tree. */

/** One sentence on what an import brought in. */
export function importSummary(report: GedcomImportInfo): string {
  const parts = [
    countOf(report.persons, 'person', 'people'),
    countOf(report.families, 'family', 'families'),
    countOf(report.events, 'event', 'events'),
  ];
  return `Imported ${parts[0] ?? ''}, ${parts[1] ?? ''} and ${parts[2] ?? ''} from ${report.fileName}.`;
}

interface ImportReportDialogProps {
  report: GedcomImportInfo;
  onClose: () => void;
}

/** Everything an import has to say: what came in, what is kept as written, and what was odd in the file. */
export function ImportReportDialog({ report, onClose }: ImportReportDialogProps) {
  const kept = report.keptRecords + report.keptLines;
  const unlisted = report.issueCount - report.issues.length;
  return (
    <Dialog title="What the import did" onClose={onClose} testId="import-report-dialog" wide>
      <p className="dialog-text" data-testid="import-report-summary">
        {importSummary(report)} The file is GEDCOM {report.version}, in the {report.encoding}{' '}
        character set.
      </p>
      {kept > 0 && (
        <p className="dialog-text" data-testid="import-report-kept">
          {countOf(kept, 'item', 'items')} in the file are things the app has no screens for yet,
          such as sources, notes and pictures. They are kept exactly as written and go back into a
          GEDCOM file when you export the tree. Those that belong to a person are listed at the
          bottom of that person’s page.
        </p>
      )}
      {report.issueCount === 0 ? (
        <p className="dialog-text" data-testid="import-report-clean">
          Nothing in the file broke the rules of the format.
        </p>
      ) : (
        <>
          <p className="dialog-text">
            {countOf(report.issueCount, 'place', 'places')} in the file did not follow the rules of
            the format. Nothing was thrown away because of them; this is what the app did instead.
          </p>
          <table className="table" data-testid="import-report-issues">
            <thead>
              <tr>
                <th scope="col">Line</th>
                <th scope="col">What was found, and what was done</th>
              </tr>
            </thead>
            <tbody>
              {report.issues.map((issue, index) => (
                <tr key={index} data-testid="import-issue">
                  <td>{issue.line === 0 ? 'Whole file' : issue.line.toLocaleString()}</td>
                  <td>{issue.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {unlisted > 0 && (
            <p className="hint">And {countOf(unlisted, 'more', 'more')} of the same kinds.</p>
          )}
        </>
      )}
      <div className="dialog-actions">
        <button
          type="button"
          className="primary"
          onClick={onClose}
          data-testid="import-report-close"
        >
          Done
        </button>
      </div>
    </Dialog>
  );
}

interface ExportDialogProps {
  tree: TreeState;
  onClose: () => void;
}

/** Asks which kind of GEDCOM file to write and who to include, then writes it. */
export function ExportDialog({ tree, onClose }: ExportDialogProps) {
  const [version, setVersion] = useState<GedcomVersion>('5.5.1');
  const [includeLiving, setIncludeLiving] = useState(false);
  const [living, setLiving] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<GedcomExportInfo | null>(null);
  const group = useId();

  useEffect(() => {
    let cancelled = false;
    api.countPresumedLiving().then(
      (count) => {
        if (!cancelled) setLiving(count);
      },
      () => {
        // The count is only there to inform; the export works without it.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [tree.revision]);

  const exportNow = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.exportGedcom({ version, includeLiving });
      // Null means the save dialog was cancelled; the choices stay as they were.
      if (result !== null) setDone(result);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  if (done !== null) {
    return (
      <Dialog title="Export finished" onClose={onClose} testId="export-dialog">
        <p className="dialog-text" role="status" data-testid="export-done">
          {countOf(done.persons, 'person', 'people')} and{' '}
          {countOf(done.families, 'family', 'families')} were written as GEDCOM {done.version} to{' '}
          <span className="path" data-testid="export-file">
            {done.file}
          </span>
        </p>
        {done.livingOmitted > 0 && (
          <p className="dialog-text" data-testid="export-omitted">
            {countOf(done.livingOmitted, 'person', 'people')} who may be living{' '}
            {done.livingOmitted === 1 ? 'was' : 'were'} left out.
          </p>
        )}
        {done.unconverted.length > 0 && (
          <div className="dialog-text" data-testid="export-unconverted">
            <p>
              Some items the app keeps as written from the imported file have no plain form in
              GEDCOM {done.version}. They were written as they are; another program may ignore them.
            </p>
            <ul>
              {done.unconverted.map((item) => (
                <li key={item.what}>
                  {item.count.toLocaleString()} × {item.what}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="dialog-actions">
          <button type="button" className="primary" onClick={onClose} data-testid="export-close">
            Done
          </button>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog title="Export as a GEDCOM file" onClose={onClose} testId="export-dialog">
      <p className="dialog-text">
        A GEDCOM file is what family tree programs use to pass a tree to one another. The file is a
        copy; this tree is not changed.
      </p>

      <fieldset className="options">
        <legend>Kind of file</legend>
        <label>
          <input
            type="radio"
            name={`${group}-version`}
            checked={version === '5.5.1'}
            onChange={() => setVersion('5.5.1')}
            data-testid="export-version-551"
          />
          <span>
            <strong>GEDCOM 5.5.1</strong>, which nearly every program reads
          </span>
        </label>
        <label>
          <input
            type="radio"
            name={`${group}-version`}
            checked={version === '7.0'}
            onChange={() => setVersion('7.0')}
            data-testid="export-version-70"
          />
          <span>
            <strong>GEDCOM 7.0</strong>, the newer standard, which not every program reads yet
          </span>
        </label>
      </fieldset>

      <fieldset className="options">
        <legend>Who to include</legend>
        <label>
          <input
            type="radio"
            name={`${group}-people`}
            checked={!includeLiving}
            onChange={() => setIncludeLiving(false)}
            data-testid="export-hide-living"
          />
          <span>
            <strong>Leave out people who may be living</strong>, for a file you will share
          </span>
        </label>
        <label>
          <input
            type="radio"
            name={`${group}-people`}
            checked={includeLiving}
            onChange={() => setIncludeLiving(true)}
            data-testid="export-include-living"
          />
          <span>
            <strong>Include everyone</strong>, for moving the tree to another program or keeping a
            copy
          </span>
        </label>
        <p className="hint" data-testid="export-living-count">
          {living === null
            ? 'Counting who may be living…'
            : `${countOf(living, 'person', 'people')} of ${tree.persons.toLocaleString()} may be living.`}{' '}
          A person counts as possibly living unless they are marked deceased, have a death or burial
          recorded, or took part in an event more than 110 years ago.
        </p>
      </fieldset>

      {error !== null && (
        <p className="error" role="alert" data-testid="dialog-error">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <button type="button" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={() => void exportNow()}
          data-testid="export-submit"
        >
          Choose where to save…
        </button>
      </div>
    </Dialog>
  );
}
