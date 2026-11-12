import { useState, type FormEvent } from 'react';
import type { GedcomImportResult, RecentTreeInfo, StartInfo, TreeState } from '../../../shared/ipc';
import { api, errorMessage } from '../api';
import { formatWhen } from '../format';
import { SystemCheck } from './SystemCheck';
import { TextField } from './ui';

interface StartScreenProps {
  info: StartInfo;
  /** Something to tell the user that happened before this screen appeared. */
  notice: string | null;
  onOpened: (tree: TreeState) => void;
  /** Called when a tree was made from a GEDCOM file and opened. */
  onImported: (result: GedcomImportResult) => void;
}

/** The screen shown while no tree is open: start a new tree, import one, or open an existing one. */
export function StartScreen({ info, notice, onOpened, onImported }: StartScreenProps) {
  const [name, setName] = useState('');
  const [importName, setImportName] = useState('');
  const [importing, setImporting] = useState(false);
  const [parentDir, setParentDir] = useState(info.defaultParentDir);
  const [recent, setRecent] = useState<RecentTreeInfo[]>(info.recent);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** Runs one action at a time and shows why it failed, if it did. */
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  const create = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() === '') {
      setError('Give the tree a name first.');
      return;
    }
    void run(async () => onOpened(await api.createTree({ name, parentDir })));
  };

  const chooseFolder = () =>
    run(async () => {
      const chosen = await api.chooseParentFolder();
      if (chosen !== null) setParentDir(chosen);
    });

  const importFile = async () => {
    setImporting(true);
    await run(async () => {
      const result = await api.importGedcom({ name: importName, parentDir });
      if (result !== null) onImported(result);
    });
    setImporting(false);
  };

  const openFromDialog = () =>
    run(async () => {
      const tree = await api.openTreeFromDialog();
      if (tree !== null) onOpened(tree);
    });

  const openRecent = (dir: string) => run(async () => onOpened(await api.openRecentTree(dir)));

  const forget = (dir: string) => run(async () => setRecent(await api.forgetRecentTree(dir)));

  return (
    <main className="shell" data-testid="start-screen">
      <header>
        <h1>RulZ Ancestry</h1>
        <p className="tagline">Family history from free sources, stored on your own PC.</p>
      </header>

      {notice !== null && (
        <p className="error banner" role="alert" data-testid="start-notice">
          {notice}
        </p>
      )}
      {error !== null && (
        <p className="error banner" role="alert" data-testid="start-error">
          {error}
        </p>
      )}

      <section className="card">
        <h2>Start a new family tree</h2>
        <form onSubmit={create} noValidate>
          <TextField
            label="Name of the tree"
            value={name}
            onChange={setName}
            testId="new-tree-name"
            placeholder="e.g. Smith family"
            maxLength={100}
          />
          <p className="hint">
            It will be kept in a new folder inside{' '}
            <span className="path" data-testid="new-tree-location">
              {parentDir}
            </span>
          </p>
          <div className="actions">
            <button type="submit" className="primary" disabled={busy} data-testid="create-tree">
              Create tree
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void chooseFolder()}
              data-testid="choose-folder"
            >
              Keep it somewhere else…
            </button>
          </div>
        </form>
      </section>

      <section className="card">
        <h2>Bring in a tree from another program</h2>
        <p>
          Ancestry, Family Tree Maker, RootsMagic, MyHeritage and most other family tree programs
          can save a tree as a GEDCOM file (a file ending in .ged). The app reads the file into a
          new tree here. The file itself is not changed.
        </p>
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (!busy) void importFile();
          }}
        >
          <TextField
            label="Name of the tree (leave empty to use the file’s name)"
            value={importName}
            onChange={setImportName}
            testId="import-tree-name"
            maxLength={100}
          />
          <p className="hint">
            It will be kept in a new folder inside <span className="path">{parentDir}</span>
          </p>
          <div className="actions">
            <button type="submit" disabled={busy} data-testid="import-gedcom">
              Choose a GEDCOM file…
            </button>
          </div>
          {importing && (
            <p className="muted" role="status" data-testid="importing">
              Choose the file in the window that opened. Reading a large file then takes a few
              seconds.
            </p>
          )}
        </form>
      </section>

      <section className="card">
        <h2>Open a family tree</h2>
        {recent.length === 0 ? (
          <p className="muted" data-testid="no-recent">
            No trees have been opened on this PC yet.
          </p>
        ) : (
          <ul className="recent" data-testid="recent-trees">
            {recent.map((tree) => (
              <li key={tree.dir} data-testid="recent-tree">
                <div className="recent-text">
                  <strong>{tree.name}</strong>
                  <span className="path">{tree.dir}</span>
                  <span className="muted">
                    {tree.available
                      ? `Last opened ${formatWhen(tree.lastOpenedAt)}`
                      : 'Not found here any more. The folder may have been moved, renamed or deleted.'}
                  </span>
                </div>
                <div className="actions">
                  {tree.available && (
                    <button
                      type="button"
                      className="primary"
                      disabled={busy}
                      onClick={() => void openRecent(tree.dir)}
                      data-testid="open-recent"
                    >
                      Open
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void forget(tree.dir)}
                    data-testid="forget-recent"
                  >
                    Remove from list
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <div className="actions">
          <button
            type="button"
            disabled={busy}
            onClick={() => void openFromDialog()}
            data-testid="open-tree-folder"
          >
            Open a tree folder…
          </button>
        </div>
      </section>

      <SystemCheck />
    </main>
  );
}
