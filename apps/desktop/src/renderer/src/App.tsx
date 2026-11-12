import { useCallback, useEffect, useState } from 'react';
import type { StartInfo, TreeState } from '../../shared/ipc';
import { api, errorMessage } from './api';
import { StartScreen } from './components/StartScreen';
import { Workspace } from './components/Workspace';

type Loaded =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; info: StartInfo; notice: string | null };

/** Shows the open tree, or the start screen when no tree is open. */
export function App() {
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' });
  const [tree, setTree] = useState<TreeState | null>(null);

  /** Shows what the main process says is open and was opened before. */
  const show = useCallback((info: StartInfo, notice: string | null) => {
    setTree(info.tree);
    setLoaded({
      state: 'ready',
      info,
      notice:
        notice ??
        (info.reopenError === null
          ? null
          : `The tree that was open last time could not be opened. ${errorMessage(info.reopenError)}`),
    });
  }, []);

  const fail = useCallback((failure: unknown) => {
    setLoaded({ state: 'error', message: errorMessage(failure) });
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.getStartInfo().then(
      (info) => {
        if (!cancelled) show(info, null);
      },
      (failure: unknown) => {
        if (!cancelled) fail(failure);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [show, fail]);

  if (loaded.state === 'loading') {
    return (
      <main className="shell">
        <p className="muted" data-testid="app-starting">
          Starting…
        </p>
      </main>
    );
  }
  if (loaded.state === 'error') {
    return (
      <main className="shell">
        <h1>RulZ Ancestry</h1>
        <p className="error" role="alert" data-testid="app-error">
          {loaded.message}
        </p>
      </main>
    );
  }

  if (tree !== null) {
    return (
      <Workspace
        // A different tree starts with a fresh screen: nobody selected, empty search.
        key={tree.id + tree.dir}
        tree={tree}
        onTree={setTree}
        onClosed={(backupError) => {
          const notice =
            backupError === null
              ? null
              : `The tree was closed, but its backup could not be made. ${errorMessage(backupError)}`;
          api.getStartInfo().then((info) => show(info, notice), fail);
        }}
      />
    );
  }

  return <StartScreen info={loaded.info} notice={loaded.notice} onOpened={setTree} />;
}
