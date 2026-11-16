import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { GedcomImportResult, RecentTreeInfo, StartInfo, TreeState } from '../../../shared/ipc';
import { api, errorMessage } from '../api';
import { formatWhen } from '../format';
import { HelpButton } from './help';
import { LogoWordmark } from './Logo';
import { SystemCheck } from './SystemCheck';
import { TextField, ThemeButton } from './ui';
import { UpdateNotice, UpdatesButton } from './updates';

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
  const title = useRef<HTMLHeadingElement>(null);

  // A tree that was closed took the focus with it: the screen starts at its title.
  useEffect(() => {
    const active = document.activeElement;
    if (active === null || active === document.body) title.current?.focus();
  }, []);

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

  // The one red button of the screen: Open on the tree used last, or Create tree when there is none.
  const mainOpen = recent.find((tree) => tree.available)?.dir;

  const openCard = (
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
                    className={tree.dir === mainOpen ? 'primary' : undefined}
                    disabled={busy}
                    aria-label={`Open ${tree.name}`}
                    onClick={() => void openRecent(tree.dir)}
                    data-testid="open-recent"
                  >
                    Open
                  </button>
                )}
                <button
                  type="button"
                  className="ghost"
                  disabled={busy}
                  aria-label={`Remove from list: ${tree.name}`}
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
  );

  const newAndImport = (
    <div className="start-grid">
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
            <button
              type="submit"
              className={mainOpen === undefined ? 'primary' : undefined}
              disabled={busy}
              data-testid="create-tree"
            >
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
          new tree here. The file itself is not changed. A GEDCOM file names pictures and does not
          hold them; a GEDZip file (ending in .gdz) holds both and is read as well.
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
              Choose a GEDCOM or GEDZip file…
            </button>
          </div>
          <div role="status">
            {importing && (
              <p className="muted" data-testid="importing">
                Choose the file in the window that opened. Reading a large file then takes a few
                seconds.
              </p>
            )}
          </div>
        </form>
      </section>
    </div>
  );

  return (
    <main className="shell" data-testid="start-screen">
      <header className="hero">
        <div className="hero-glow" aria-hidden="true" />
        <div className="hero-slashes" aria-hidden="true" />
        <div className="hero-row">
          <div className="hero-brand">
            <h1 ref={title} tabIndex={-1}>
              <LogoWordmark className="hero-logo" />
            </h1>
            <div>
              <span className="eyebrow" aria-hidden="true">
                KINSPORA
              </span>
              <p className="tagline">Family history from free sources, stored on your own PC.</p>
            </div>
          </div>
          <div className="hero-tools">
            <UpdatesButton />
            <HelpButton />
            <ThemeButton />
          </div>
        </div>
      </header>

      <UpdateNotice />
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

      {recent.length > 0 ? (
        <>
          {openCard}
          {newAndImport}
        </>
      ) : (
        <>
          {newAndImport}
          {openCard}
        </>
      )}

      <SystemCheck />
    </main>
  );
}
