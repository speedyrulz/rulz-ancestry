import { useEffect, useId, useRef, useState } from 'react';
import type {
  PackArchiveInfo,
  CensusStatesResult,
  PackInfo,
  PackJob,
  PackOfferInfo,
  PacksState,
} from '../../../shared/ipc';
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

function fileNameFromUrl(url: string): string {
  const queryIndex = url.indexOf('?');
  const withoutQuery = queryIndex === -1 ? url : url.slice(0, queryIndex);
  const hashIndex = withoutQuery.indexOf('#');
  const clean = hashIndex === -1 ? withoutQuery : withoutQuery.slice(0, hashIndex);
  const segments = clean.split('/').filter(Boolean);
  const last = segments[segments.length - 1];
  return last !== undefined && last !== '' ? last : url;
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

  const filterId = useId();
  const [archives, setArchives] = useState<PackArchiveInfo[] | null>(null);
  const [lookingUp, setLookingUp] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [selectedCode, setSelectedCode] = useState<string | null>(null);
  const [offer, setOffer] = useState<PackOfferInfo | null>(null);
  const [describing, setDescribing] = useState(false);
  const [describeError, setDescribeError] = useState<string | null>(null);
  const [offerExpired, setOfferExpired] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [census, setCensus] = useState<Extract<CensusStatesResult, { ok: true }> | null>(null);
  const [censusBusy, setCensusBusy] = useState(false);
  const [censusError, setCensusError] = useState<string | null>(null);
  const [censusExpired, setCensusExpired] = useState(false);
  const censusRequest = useRef(0);
  const censusLoaded = useRef(false);

  const lookupCensus = async () => {
    const request = ++censusRequest.current;
    setCensusBusy(true);
    setCensusError(null);
    try {
      const result = await api.listCensusStates();
      if (request !== censusRequest.current) return;
      if (result.ok) {
        censusLoaded.current = true;
        setCensus(result);
        setCensusExpired(Date.now() >= result.expiresAt);
      } else {
        setCensus(null);
        setCensusError(result.message);
      }
    } catch (failure) {
      if (request === censusRequest.current) {
        setCensus(null);
        setCensusError(errorMessage(failure));
      }
    } finally {
      if (request === censusRequest.current) setCensusBusy(false);
    }
  };

  useEffect(
    () => () => {
      censusRequest.current += 1;
    },
    [],
  );
  useEffect(() => {
    if (census === null) return undefined;
    const timer = setTimeout(
      () => setCensusExpired(true),
      Math.max(0, census.expiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [census]);

  const handleLookup = async () => {
    setLookupError(null);
    setLookingUp(true);
    try {
      const result = await api.listPackArchives();
      if (!result.ok) {
        setLookupError(result.message);
      } else {
        archivesLoaded.current = true;
        setArchives(result.archives);
      }
    } catch (failure) {
      setLookupError(errorMessage(failure));
    } finally {
      setLookingUp(false);
    }
  };

  // The latest request to describe an archive; only its answer is shown.
  const describeRequest = useRef(0);
  const selectedRef = useRef<string | null>(null);
  const archivesLoaded = useRef(false);
  // Set while an install job of this window has not yet been seen to end.
  const watchingJob = useRef(false);

  const handleSelectArchive = async (code: string) => {
    describeRequest.current += 1;
    const request = describeRequest.current;
    selectedRef.current = code;
    setSelectedCode(code);
    setOffer(null);
    setDescribeError(null);
    setOfferExpired(false);
    setInstallError(null);
    setDescribing(true);
    try {
      const result = await api.describePackArchive(code);
      if (request !== describeRequest.current) return;
      if (!result.ok) {
        setDescribeError(result.message);
      } else {
        setOffer(result.offer);
      }
    } catch (failure) {
      if (request === describeRequest.current) setDescribeError(errorMessage(failure));
    } finally {
      if (request === describeRequest.current) setDescribing(false);
    }
  };

  // When an install job ends, the offer and the archive tags may be out of date.
  const jobPhase = job?.phase ?? null;
  useEffect(() => {
    if (isRunning) watchingJob.current = true;
    if (jobPhase === null || isActivePhase(jobPhase) || !watchingJob.current) return;
    watchingJob.current = false;
    if (censusLoaded.current) void lookupCensus();
    if (archivesLoaded.current) {
      api.listPackArchives().then(
        (result) => {
          if (result.ok) setArchives(result.archives);
        },
        () => undefined,
      );
    }
    if (selectedRef.current !== null) void handleSelectArchive(selectedRef.current);
  }, [job, jobPhase, isRunning]);

  const handleInstall = async (targetOffer: PackOfferInfo) => {
    setInstallError(null);
    if (Date.now() > targetOffer.expiresAt) {
      setOfferExpired(true);
      return;
    }
    setOfferExpired(false);
    setInstalling(true);
    try {
      const result = await api.installPackArchive(targetOffer.code);
      if (!result.ok) {
        setInstallError(result.message);
      } else {
        watchingJob.current = true;
        await reload();
      }
    } catch (failure) {
      setInstallError(errorMessage(failure));
    } finally {
      setInstalling(false);
    }
  };

  const trimmedFilter = filter.trim().toLowerCase();
  const filteredArchives = (archives ?? []).filter(
    (archive) =>
      trimmedFilter === '' ||
      archive.name.toLowerCase().includes(trimmedFilter) ||
      archive.code.toLowerCase().includes(trimmedFilter),
  );

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

          <section className="packs-add" data-testid="packs-add">
            <h3>Add a pack</h3>
            <div className="packs-lookup-bar">
              <h4>1950 US census</h4>
              <button
                type="button"
                disabled={censusBusy || installing}
                onClick={() => void lookupCensus()}
                data-testid="census-lookup"
              >
                Look up the 1950 census states
              </button>
              <p className="hint">
                This asks nara-1950-census.s3.us-east-2.amazonaws.com for the states and sends
                nothing about you or your tree.
              </p>
              {censusError !== null && (
                <p className="error" role="alert">
                  {censusError}
                </p>
              )}
              {census !== null && (
                <>
                  <p className="dialog-text">{formatFreeSpace(census.freeBytes)}</p>
                  {censusExpired && (
                    <p className="error" role="alert">
                      This list is out of date; look again.
                    </p>
                  )}
                  <ul className="packs-archives-list">
                    {census.states.map((item) => (
                      <li
                        key={item.code}
                        className="census-pack-row"
                        data-testid={`census-state-${item.code}`}
                      >
                        <span>
                          <strong>{item.name}</strong> · Download {formatBytes(item.bytes)} · About{' '}
                          {formatBytes(item.estimateBytes)} once built
                        </span>
                        <button
                          type="button"
                          data-testid={`census-install-${item.code}`}
                          disabled={
                            item.installed === 'current' ||
                            censusExpired ||
                            censusBusy ||
                            isRunning ||
                            installing
                          }
                          onClick={() => {
                            if (Date.now() >= census.expiresAt) {
                              setCensusExpired(true);
                              return;
                            }
                            setInstalling(true);
                            setCensusError(null);
                            void api
                              .installCensusState(item.code)
                              .then(
                                async (result) => {
                                  if (!result.ok) setCensusError(result.message);
                                  else {
                                    watchingJob.current = true;
                                    await reload();
                                  }
                                },
                                (failure: unknown) => setCensusError(errorMessage(failure)),
                              )
                              .finally(() => setInstalling(false));
                          }}
                        >
                          {item.installed === 'current'
                            ? 'Up to date'
                            : item.installed === 'update'
                              ? 'Update'
                              : 'Install'}
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
            <h4>Open Archives</h4>
            <div className="packs-lookup-bar">
              <div className="actions">
                <button
                  type="button"
                  disabled={lookingUp}
                  onClick={() => void handleLookup()}
                  data-testid="packs-lookup"
                >
                  Look up Open Archives&apos; archives
                </button>
                {lookingUp && <span className="muted">Looking…</span>}
              </div>
              <p className="hint">
                This asks openarchieven.nl for its list of archives. Nothing about you or your tree
                is sent.
              </p>
            </div>

            {lookupError !== null && (
              <p className="error" role="alert" data-testid="packs-lookup-error">
                {lookupError}
              </p>
            )}

            {archives !== null && (
              <>
                <div className="field packs-filter-field">
                  <label htmlFor={filterId}>Filter</label>
                  <input
                    id={filterId}
                    type="text"
                    data-testid="packs-filter"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                  />
                </div>

                {filteredArchives.length === 0 ? (
                  <p className="dialog-text muted">No archives match the filter.</p>
                ) : (
                  <ul className="packs-archives-list">
                    {filteredArchives.map((archive) => (
                      <li key={archive.code}>
                        <button
                          type="button"
                          className={
                            selectedCode === archive.code
                              ? 'packs-archive-row selected'
                              : 'packs-archive-row'
                          }
                          data-testid={`packs-archive-${archive.code}`}
                          onClick={() => void handleSelectArchive(archive.code)}
                        >
                          <span className="packs-archive-header">
                            <strong className="packs-archive-name">{archive.name}</strong>
                            {archive.installed === 'yes' && (
                              <span className="badge">Installed</span>
                            )}
                            {archive.installed === 'maybe-update' && (
                              <span className="badge">Installed, may have an update</span>
                            )}
                          </span>
                          <span className="packs-archive-meta">
                            <span className="hint">{archive.code}</span>
                            {archive.period !== null && archive.period !== '' && (
                              <span className="packs-archive-period">{archive.period}</span>
                            )}
                            {archive.records !== null && (
                              <span className="packs-archive-records">
                                <span>{archive.records.toLocaleString()}</span> records
                              </span>
                            )}
                            {archive.modified !== null && archive.modified !== '' && (
                              <span className="packs-archive-modified">{archive.modified}</span>
                            )}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}

                {describing && (
                  <p className="muted pad" data-testid="packs-offer-loading">
                    Looking…
                  </p>
                )}

                {describeError !== null && (
                  <p className="error" role="alert" data-testid="packs-describe-error">
                    {describeError}
                  </p>
                )}

                {offer !== null && (
                  <section className="packs-offer" data-testid="packs-offer">
                    <p className="packs-offer-title">
                      <strong>{offer.name}</strong>
                    </p>
                    {offer.pageUrl !== '' && <p className="dialog-text path">{offer.pageUrl}</p>}
                    <ul className="packs-offer-files">
                      {offer.files.map((file, index) => (
                        <li key={`${file.url}-${index}`}>
                          <span className="packs-file-name">{fileNameFromUrl(file.url)}</span>
                          {' — '}
                          <span className="packs-file-size">{formatBytes(file.bytes)}</span>
                        </li>
                      ))}
                    </ul>
                    <p className="dialog-text">Download size: {formatBytes(offer.downloadBytes)}</p>
                    <p className="dialog-text">
                      about {formatBytes(offer.estimateBytes)} once built
                    </p>
                    <p className="dialog-text">{formatFreeSpace(offer.freeBytes)}</p>
                    <p className="hint">
                      Looking up an archive also asks oa-export.s3.nl-ams.scw.cloud for the sizes of
                      its files.
                    </p>
                    {offer.freeBytes !== null && offer.estimateBytes > offer.freeBytes && (
                      <p className="error" role="alert">
                        There may not be enough free space.
                      </p>
                    )}
                    {offer.installed === 'current' ? (
                      <p className="dialog-text">This pack is up to date.</p>
                    ) : (
                      <div className="actions">
                        <button
                          type="button"
                          className="primary"
                          disabled={isRunning || installing}
                          onClick={() => void handleInstall(offer)}
                          data-testid="packs-install"
                        >
                          {offer.installed === 'update' ? 'Update' : 'Install'}
                        </button>
                      </div>
                    )}
                    {offerExpired && (
                      <div className="packs-expired">
                        <p className="error" role="alert">
                          This list is out of date; look again.
                        </p>
                        <button
                          type="button"
                          onClick={() => void handleSelectArchive(offer.code)}
                          data-testid="packs-offer-refresh"
                        >
                          Look again
                        </button>
                      </div>
                    )}
                    {installError !== null && (
                      <p className="error" role="alert" data-testid="packs-install-error">
                        {installError}
                      </p>
                    )}
                  </section>
                )}
              </>
            )}
          </section>
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
