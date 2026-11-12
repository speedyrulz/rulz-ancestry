import { useCallback, useEffect, useRef, useState } from 'react';
import type { TreeState } from '../../../shared/ipc';
import { api, errorMessage } from '../api';
import { formatWhen } from '../format';
import { AddPersonDialog, BackupsDialog } from './dialogs';
import { PersonList } from './PersonList';
import { PersonPageView } from './PersonPage';

interface Notice {
  text: string;
  error: boolean;
}

interface WorkspaceProps {
  tree: TreeState;
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
export function Workspace({ tree, onTree, onClosed }: WorkspaceProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [searchText, setSearchText] = useState('');
  const [query, setQuery] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [dialog, setDialog] = useState<'add-person' | 'backups' | null>(null);
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
          <button type="button" onClick={() => setDialog('backups')} data-testid="open-backups">
            Backups
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
          ) : (
            <PersonPageView
              personId={selectedId}
              tree={tree}
              onTree={onTree}
              onSelect={setSelectedId}
              onProblem={showProblem}
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
