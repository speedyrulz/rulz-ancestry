import { useEffect, useState } from 'react';
import type { PackInfo, PackJob, PacksState } from '../../../shared/ipc';
import { api, errorMessage } from '../api';
import { ConfirmDialog, Dialog } from './ui';

/**
 * Packs: the window that lists the offline data packs on this PC,
 * shows free space, and tracks pack install and update jobs.
 */

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatFreeSpace(bytes: number | null): string {
  if (bytes === null) return 'Free space unknown';
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB free`;
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB free`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(0)} KB free`;
  }
  return `${bytes} bytes free`;
}

function packStateLabel(state: PackInfo['state']): string {
  switch (state) {
    case 'ready':
      return 'Ready';
    case 'rebuild':
      return 'Needs a rebuild';
    case 'unreadable':
      return 'Cannot be read';
  }
}

function isActivePhase(phase: PackJob['phase']): boolean {
  return (
    phase === 'checking' || phase === 'downloading' || phase === 'building' || phase === 'switching'
  );
}

const PHASE_WORDS: Record<PackJob['phase'], string> = {
  checking: 'Checking',
  downloading: 'Downloading',
  building: 'Building',
  switching: 'Switching',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

function formatJobProgress(job: PackJob): string {
  if (job.phase === 'building') {
    return `${job.rows.toLocaleString()} rows`;
  }
  if (job.phase === 'downloading') {
    if (job.totalBytes !== null) {
      return `${formatBytes(job.doneBytes)} of ${formatBytes(job.totalBytes)}`;
    }
    return formatBytes(job.doneBytes);
  }
  if (job.rows > 0) {
    return `${job.rows.toLocaleString()} rows`;
  }
  if (job.totalBytes !== null) {
    return `${formatBytes(job.doneBytes)} of ${formatBytes(job.totalBytes)}`;
  }
  if (job.doneBytes > 0) {
    return formatBytes(job.doneBytes);
  }
  return '';
}

export interface PacksDialogProps {
  onClose: () => void;
}

export function PacksDialog({ onClose }: PacksDialogProps) {
  const [state, setState] = useState<PacksState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<PackInfo | null>(null);

  const reload = async () => {
    try {
      const next = await api.getPacks();
      setState(next);
    } catch (failure) {
      setError(errorMessage(failure));
    }
  };

  useEffect(() => {
    let cancelled = false;
    api.getPacks().then(
      (next) => {
        if (!cancelled) setState(next);
      },
      (failure: unknown) => {
        if (!cancelled) setError(errorMessage(failure));
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const job = state?.job ?? null;
  const isRunning = job !== null && isActivePhase(job.phase);

  useEffect(() => {
    if (!isRunning) return undefined;
    let cancelled = false;
    let asking = false;
    const timer = setInterval(() => {
      if (asking) return;
      asking = true;
      api
        .getPacks()
        .then(
          (next) => {
            if (!cancelled) setState(next);
          },
          () => undefined,
        )
        .finally(() => {
          asking = false;
        });
    }, 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [isRunning]);

  const handleCancelJob = async () => {
    setError(null);
    try {
      const result = await api.cancelPackJob();
      if (!result.ok) {
        setError(result.message);
      }
      await reload();
    } catch (failure) {
      setError(errorMessage(failure));
    }
  };

  const handleRemove = async (id: string) => {
    setError(null);
    try {
      const result = await api.removePack(id);
      if (!result.ok) {
        setError(result.message);
      }
      await reload();
    } catch (failure) {
      setError(errorMessage(failure));
    }
  };

  return (
    <Dialog title="Packs" onClose={onClose} testId="packs-dialog" wide>
      {state === null ? (
        <p className="muted pad" data-testid="packs-loading">
          Looking…
        </p>
      ) : (
        <>
          <p className="dialog-text" data-testid="packs-location">
            <span data-testid="packs-root">{state.root}</span>
            {' · '}
            <span data-testid="packs-free-space">{formatFreeSpace(state.freeBytes)}</span>
          </p>

          {job !== null && (
            <section className="pack-job" data-testid="pack-job">
              <p className="dialog-text" role="status">
                <strong data-testid="pack-job-title">{job.title}</strong>
                {' — '}
                <span data-testid="pack-job-phase">{PHASE_WORDS[job.phase]}</span>
                {formatJobProgress(job) !== '' && (
                  <>
                    {': '}
                    <span data-testid="pack-job-progress">{formatJobProgress(job)}</span>
                  </>
                )}
              </p>
              {job.message !== null && job.message.trim() !== '' && (
                <p className="dialog-text muted" data-testid="pack-job-message">
                  {job.message}
                </p>
              )}
              {isActivePhase(job.phase) && (
                <div className="actions">
                  <button
                    type="button"
                    onClick={() => void handleCancelJob()}
                    data-testid="pack-job-cancel"
                  >
                    Cancel
                  </button>
                </div>
              )}
            </section>
          )}

          {state.packs.length === 0 ? (
            <p className="dialog-text muted" data-testid="packs-empty">
              No packs are installed.
            </p>
          ) : (
            <div className="scroll-box">
              <table className="table" data-testid="packs-table">
                <thead>
                  <tr>
                    <th scope="col">Title</th>
                    <th scope="col">Source name</th>
                    <th scope="col">Rows</th>
                    <th scope="col">Size</th>
                    <th scope="col">Downloaded day</th>
                    <th scope="col">Licence and credit line</th>
                    <th scope="col">State</th>
                    <th scope="col">
                      <span className="visually-hidden">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {state.packs.map((pack) => (
                    <tr key={pack.id} data-testid="pack-row">
                      <td data-testid="pack-title">{pack.title}</td>
                      <td data-testid="pack-source">{pack.sourceName}</td>
                      <td data-testid="pack-rows">{pack.rows.toLocaleString()}</td>
                      <td data-testid="pack-size">{formatBytes(pack.bytes)}</td>
                      <td data-testid="pack-downloaded">{pack.downloadedAt}</td>
                      <td data-testid="pack-licence">
                        <div>{pack.licence}</div>
                        {pack.credit !== '' && <div className="hint">{pack.credit}</div>}
                      </td>
                      <td data-testid="pack-state">{packStateLabel(pack.state)}</td>
                      <td className="row-actions">
                        <button
                          type="button"
                          onClick={() => setRemoving(pack)}
                          data-testid="pack-remove"
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {error !== null && (
        <p className="error" role="alert" data-testid="packs-error">
          {error}
        </p>
      )}

      <div className="dialog-actions">
        <button type="button" className="primary" onClick={onClose} data-testid="packs-close">
          Close
        </button>
      </div>

      {removing !== null && (
        <ConfirmDialog
          title="Remove this pack from this PC?"
          confirmLabel="Remove"
          onClose={() => setRemoving(null)}
          onConfirm={async () => {
            const pack = removing;
            setRemoving(null);
            await handleRemove(pack.id);
          }}
        >
          <p className="dialog-text">
            Remove this pack from this PC? Citations made from it stay in your tree.
          </p>
        </ConfirmDialog>
      )}
    </Dialog>
  );
}
