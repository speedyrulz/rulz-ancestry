import { useCallback, useEffect, useRef, useState } from 'react';
import type { GedcomImportInfo, MergeInfo, TreeState } from '../../../shared/ipc';
import { api, errorMessage } from '../api';
import { countOf, formatWhen } from '../format';
import { ChartView } from './ChartView';
import { AddPersonDialog, BackupsDialog } from './dialogs';
import { DuplicatesDialog, mergeSummary } from './duplicates';
import { ExportDialog, ImportReportDialog, importSummary } from './gedcom';
import { MediaLibraryDialog } from './media';
import { PersonList } from './PersonList';
import { PersonPageView } from './PersonPage';
import { SourcesDialog } from './sources';

interface Notice {
  text: string;
  error: boolean;
}

interface WorkspaceProps {
  tree: TreeState;
  /** What the import did, when this tree has just been made from a GEDCOM file. */
  imported: GedcomImportInfo | null;
  /** Called with the tree's new state after every edit. */
  onTree: (tree: TreeState) => void;
  /** Called once the tree is closed. `backupError` says why its backup failed, if it did. */
  onClosed: (backupError: string | null) => void;
}

/** True while the keyboard is in a place where Ctrl+Z should undo typing, not the tree. */
function typingOrInDialog(target: EventTarget | null): boolean {
  if (document.querySelector('dialog[open]')) return true;
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

/** The screen for an open tree: search and commands on top, everyone on the left, one person on the right. */
export function Workspace({ tree, imported, onTree, onClosed }: WorkspaceProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [searchText, setSearchText] = useState('');
  const [query, setQuery] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  /** The message about the import stays until it is dismissed; other messages come and go above it. */
  const [importNotice, setImportNotice] = useState(imported !== null);
  const [dialog, setDialog] = useState<
    | 'add-person'
    | 'backups'
    | 'duplicates'
    | 'export'
    | 'import-report'
    | 'media'
    | 'sources'
    | null
  >(null);
  /** What the right-hand side shows for the person selected: their details, or a chart. */
  const [view, setView] = useState<'person' | 'chart'>('person');
  const [busy, setBusy] = useState(false);
  const searchBox = useRef<HTMLInputElement>(null);

  useEffect(() => {
    document.title = `${tree.name} - RulZ Ancestry`;
    return () => {
      document.title = 'RulZ Ancestry';
    };
  }, [tree.name]);

  // Search once typing pauses, not on every key.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(searchText.trim()), 150);
    return () => clearTimeout(timer);
  }, [searchText]);

  const showProblem = useCallback(
    (message: string) => setNotice({ text: message, error: true }),
    [],
  );

  /** Runs a command from the top bar, one at a time. */
  const run = useCallback(
    async (action: () => Promise<string | null>) => {
      if (busy) return;
      setBusy(true);
      try {
        const done = await action();
        setNotice(done === null ? null : { text: done, error: false });
      } catch (failure) {
        setNotice({ text: errorMessage(failure), error: true });
      } finally {
        setBusy(false);
      }
    },
    [busy],
  );

  const undo = useCallback(
    () =>
      run(async () => {
        const label = tree.undo;
        if (label === null) return null;
        onTree(await api.undo());
        return `Undone: ${label}.`;
      }),
    [run, tree.undo, onTree],
  );

  const redo = useCallback(
    () =>
      run(async () => {
        const label = tree.redo;
        if (label === null) return null;
        onTree(await api.redo());
        return `Redone: ${label}.`;
      }),
    [run, tree.redo, onTree],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === 'f' && !document.querySelector('dialog[open]')) {
        event.preventDefault();
        searchBox.current?.focus();
        searchBox.current?.select();
        return;
      }
      if (typingOrInDialog(event.target)) return;
      if (key === 'z' && !event.shiftKey) {
        event.preventDefault();
        void undo();
      } else if (key === 'y' || (key === 'z' && event.shiftKey)) {
        event.preventDefault();
        void redo();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [undo, redo]);

  /** After a merge: show the person who is left, and say what happened. */
  const showMerged = useCallback(
    (info: MergeInfo, name: string) => {
      onTree(info.tree);
      setSelectedId(info.personId);
      setNotice({ text: mergeSummary(info, name), error: false });
    },
    [onTree],
  );

  const closeTree = () =>
    run(async () => {
      const result = await api.closeTree();
      onClosed(result.backupError);
      return null;
    });

  return (
    <div className="workspace" data-testid="workspace">
      <header className="topbar">
        <div className="tree-title">
          <strong data-testid="tree-name">{tree.name}</strong>
          <span className="muted" data-testid="tree-backup">
            {tree.lastBackupAt === null
              ? 'No backup yet'
              : `Last backup ${formatWhen(tree.lastBackupAt)}`}
          </span>
        </div>
        <input
          ref={searchBox}
          type="search"
          className="search"
          value={searchText}
          placeholder="Search this tree by name (Ctrl+F)"
          aria-label="Search this tree by name"
          spellCheck={false}
          autoComplete="off"
          maxLength={200}
          data-testid="search-box"
          onChange={(event) => setSearchText(event.target.value)}
        />
        <div className="actions">
          <button
            type="button"
            disabled={busy || tree.undo === null}
            title={tree.undo === null ? 'Nothing to undo' : `Undo ${tree.undo} (Ctrl+Z)`}
            onClick={() => void undo()}
            data-testid="undo"
          >
            Undo
          </button>
          <button
            type="button"
            disabled={busy || tree.redo === null}
            title={tree.redo === null ? 'Nothing to redo' : `Redo ${tree.redo} (Ctrl+Y)`}
            onClick={() => void redo()}
            data-testid="redo"
          >
            Redo
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => setDialog('add-person')}
            data-testid="add-person"
          >
            Add person
          </button>
          <button
            type="button"
            title="The censuses, registers, books and other sources this tree rests on"
            onClick={() => setDialog('sources')}
            data-testid="open-sources"
          >
            Sources
          </button>
          <button
            type="button"
            title="The pictures and documents in this tree"
            onClick={() => setDialog('media')}
            data-testid="open-media"
          >
            Media
          </button>
          <button type="button" onClick={() => setDialog('backups')} data-testid="open-backups">
            Backups
          </button>
          <button
            type="button"
            title="Look for people who are in the tree twice"
            onClick={() => setDialog('duplicates')}
            data-testid="open-duplicates"
          >
            Duplicates
          </button>
          <button
            type="button"
            title="Save this tree as a GEDCOM file for another program"
            onClick={() => setDialog('export')}
            data-testid="open-export"
          >
            Export
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void closeTree()}
            data-testid="close-tree"
          >
            Close tree
          </button>
        </div>
      </header>

      <div className="notice-bar" aria-live="polite">
        {imported !== null && importNotice && (
          <p className="notice" role="status" data-testid="import-notice">
            <span>
              {importSummary(imported)}
              {imported.issueCount > 0 &&
                ` ${countOf(imported.issueCount, 'place', 'places')} in the file did not follow the rules of the format.`}
            </span>
            <button
              type="button"
              className="small"
              onClick={() => setDialog('import-report')}
              data-testid="import-details"
            >
              Details
            </button>
            <button
              type="button"
              className="small"
              onClick={() => setImportNotice(false)}
              aria-label="Dismiss the message about the import"
              data-testid="import-dismiss"
            >
              Dismiss
            </button>
          </p>
        )}
        {notice !== null && (
          <p
            className={notice.error ? 'error' : 'notice'}
            role={notice.error ? 'alert' : 'status'}
            data-testid="workspace-notice"
          >
            {notice.text}
            <button
              type="button"
              className="small"
              onClick={() => setNotice(null)}
              aria-label="Dismiss this message"
            >
              Dismiss
            </button>
          </p>
        )}
      </div>

      <div className="panes">
        <nav aria-label="People in this tree">
          <PersonList
            key={query}
            revision={tree.revision}
            query={query}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
        </nav>
        <main>
          {selectedId === null ? (
            <div className="person-page" data-testid="nobody-selected">
              <p className="muted">
                {tree.persons === 0
                  ? 'This tree is empty. Use “Add person” to add the first person.'
                  : 'Choose a person from the list to see and edit their details.'}
              </p>
            </div>
          ) : view === 'chart' ? (
            <ChartView
              personId={selectedId}
              revision={tree.revision}
              onSelect={setSelectedId}
              onDetails={() => setView('person')}
              onProblem={showProblem}
            />
          ) : (
            <PersonPageView
              personId={selectedId}
              tree={tree}
              onTree={onTree}
              onSelect={setSelectedId}
              onProblem={showProblem}
              onChart={() => setView('chart')}
              onMerged={showMerged}
            />
          )}
        </main>
      </div>

      {dialog === 'add-person' && (
        <AddPersonDialog
          onClose={() => setDialog(null)}
          onSubmit={async (draft) => {
            const change = await api.addPerson(draft);
            onTree(change.tree);
            setSelectedId(change.personId);
            setNotice(null);
          }}
        />
      )}
      {dialog === 'export' && <ExportDialog tree={tree} onClose={() => setDialog(null)} />}
      {dialog === 'duplicates' && (
        <DuplicatesDialog
          tree={tree}
          onTree={onTree}
          onMerged={showMerged}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'sources' && (
        <SourcesDialog
          tree={tree}
          onTree={onTree}
          onSelect={(personId) => {
            setSelectedId(personId);
            setView('person');
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'media' && (
        <MediaLibraryDialog
          tree={tree}
          onTree={onTree}
          onSelect={(personId) => {
            setSelectedId(personId);
            setView('person');
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'import-report' && imported !== null && (
        <ImportReportDialog report={imported} onClose={() => setDialog(null)} />
      )}
      {dialog === 'backups' && (
        <BackupsDialog
          tree={tree}
          onTree={(next) => {
            onTree(next);
          }}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}
