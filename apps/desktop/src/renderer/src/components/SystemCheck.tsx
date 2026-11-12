import { useEffect, useState } from 'react';
import type { AppInfo } from '../../../shared/ipc';
import { api } from '../api';

type Status =
  { state: 'loading' } | { state: 'ready'; info: AppInfo } | { state: 'error'; message: string };

function useAppInfo(): Status {
  const [status, setStatus] = useState<Status>({ state: 'loading' });

  useEffect(() => {
    let cancelled = false;
    api.getAppInfo().then(
      (info) => {
        if (!cancelled) setStatus({ state: 'ready', info });
      },
      (error: unknown) => {
        if (cancelled) return;
        setStatus({
          state: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  return status;
}

function StatusPanel({ info }: { info: AppInfo }) {
  const sourceCount = info.connectors.api + info.connectors.bulk + info.connectors.deeplink;
  return (
    <dl className="status" data-testid="app-status">
      <div>
        <dt>App version</dt>
        <dd data-testid="app-version">{info.appVersion}</dd>
      </div>
      <div>
        <dt>Database engine</dt>
        <dd data-testid="sqlite-version">SQLite {info.database.sqliteVersion}</dd>
      </div>
      <div>
        <dt>Full-text search</dt>
        <dd data-testid="fts5">{info.database.fts5 ? 'Available' : 'Missing'}</dd>
      </div>
      <div>
        <dt>Family tree engine</dt>
        <dd data-testid="tree-engine" className={info.treeEngine.ok ? undefined : 'error'}>
          {info.treeEngine.ok
            ? `Ready (schema version ${info.treeEngine.schemaVersion})`
            : `Failed: ${info.treeEngine.error}`}
        </dd>
      </div>
      <div>
        <dt>Data sources defined</dt>
        <dd data-testid="source-count">
          {sourceCount} ({info.connectors.api} live, {info.connectors.bulk} downloadable,{' '}
          {info.connectors.deeplink} link-only)
        </dd>
      </div>
      <div>
        <dt>Database file</dt>
        <dd className="path" data-testid="database-path">
          {info.database.path}
        </dd>
      </div>
      <div>
        <dt>Runtime</dt>
        <dd>
          Electron {info.versions.electron}, Chromium {info.versions.chrome}, Node{' '}
          {info.versions.node}
        </dd>
      </div>
    </dl>
  );
}

/** Shows that the parts the app depends on work on this PC. */
export function SystemCheck() {
  const status = useAppInfo();
  return (
    <section aria-live="polite">
      <h2>System check</h2>
      {status.state === 'loading' && <p data-testid="app-loading">Checking…</p>}
      {status.state === 'error' && (
        <p className="error" role="alert" data-testid="app-error">
          {status.message}
        </p>
      )}
      {status.state === 'ready' && <StatusPanel info={status.info} />}
    </section>
  );
}
