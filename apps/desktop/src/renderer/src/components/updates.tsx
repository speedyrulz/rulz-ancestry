import { Download, RefreshCw } from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { UpdateState } from '../../../shared/updates';
import { api } from '../api';
import { Dialog, IconButton } from './ui';
import './updates.css';

/**
 * The check for a new version and the one-click update. One provider keeps what is known (is a
 * newer version out, how far the update is, does the app check at startup), the panel that holds
 * the controls and one live region; the top bar and the start screen show a button that opens the
 * panel, and a notice says so when a newer version is out.
 */

interface UpdatesValue {
  state: UpdateState;
  openPanel: () => void;
  /** Hides the notice for this version ("Not now"). */
  dismiss: () => void;
  /** Downloads, checks and installs the newer version. */
  install: () => void;
  cancel: () => void;
  /** The notice of what the last update left has been read. */
  acknowledge: () => void;
  setStartup: (enabled: boolean) => void;
}

const UpdatesContext = createContext<UpdatesValue | null>(null);

function useUpdates(): UpdatesValue {
  const value = useContext(UpdatesContext);
  if (value === null) throw new Error('The update controls need an UpdatesProvider above them.');
  return value;
}

const FIRST_STATE: UpdateState = {
  startup: true,
  version: null,
  phase: 'idle',
  percent: null,
  canInstall: false,
  failure: null,
  outcome: null,
};

/** Moves the focus to a control the update just brought up, inside the open panel if there is one. */
function focusSoon(selector: string): void {
  requestAnimationFrame(() => {
    const panel = document.querySelector('[data-testid="updates-panel"]');
    (
      panel?.querySelector<HTMLElement>(selector) ?? document.querySelector<HTMLElement>(selector)
    )?.focus();
  });
}

/** What a screen reader hears when the phase changes; the percent is left out on purpose. */
function announcement(state: UpdateState): string {
  const version = state.version ?? '';
  switch (state.phase) {
    case 'downloading':
      return `Downloading version ${version}.`;
    case 'waiting':
      return 'Downloaded and checked. Waiting for the running task to finish before installing.';
    case 'verified':
      return 'Downloaded and checked. This copy of the app cannot install it by itself.';
    case 'installing':
      return `Installing version ${version}. The app will close and open again.`;
    case 'failed':
      return `The update failed. ${state.failure ?? ''}`;
    default:
      return state.outcome === null ? '' : outcomeText(state.outcome);
  }
}

function outcomeText(outcome: NonNullable<UpdateState['outcome']>): string {
  return outcome.kind === 'updated'
    ? `RulZ Kinspora was updated to version ${outcome.version}.`
    : `The update to version ${outcome.version} did not install.`;
}

export function UpdatesProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<UpdateState>(FIRST_STATE);
  const [message, setMessage] = useState('');
  /** Said once after the user gives an update up; the phase alone would be silent (it is idle again). */
  const [note, setNote] = useState('');
  const [panel, setPanel] = useState(false);
  const refresh = useCallback(
    () =>
      api
        .updateState()
        .then(setState)
        .catch(() => undefined),
    [],
  );
  const working =
    state.phase === 'downloading' || state.phase === 'waiting' || state.phase === 'installing';
  useEffect(() => {
    void refresh();
    // A download shows its percentage, so it is looked at more often than an idle app.
    const timer = setInterval(() => void refresh(), working ? 500 : 2000);
    return () => clearInterval(timer);
  }, [refresh, working]);

  const openPanel = useCallback(() => setPanel(true), []);
  const dismiss = useCallback(() => {
    setMessage('');
    void api.dismissUpdate().then(refresh);
    focusSoon('[data-testid="updates-open"]');
  }, [refresh]);
  const acknowledge = useCallback(() => {
    void api.acknowledgeUpdate().then(refresh, refresh);
    focusSoon('[data-testid="updates-open"]');
  }, [refresh]);
  const install = useCallback(() => {
    setMessage('');
    setNote('');
    void api
      .installUpdate()
      .then(refresh, refresh)
      .then(() => focusSoon('[data-update-status]'));
  }, [refresh]);
  const cancel = useCallback(() => {
    setNote('Update cancelled.');
    void api
      .cancelUpdate()
      .then(refresh, refresh)
      .then(() => focusSoon('[data-update-action]'));
  }, [refresh]);
  const setStartup = useCallback(
    (startup: boolean) => {
      // Show the new state at once; the switch would otherwise snap back until the main process
      // answers.
      setState((current) => ({ ...current, startup }));
      void api.setUpdateStartup(startup).then(refresh, refresh);
    },
    [refresh],
  );
  const value = useMemo(
    () => ({ state, openPanel, dismiss, install, cancel, acknowledge, setStartup }),
    [state, openPanel, dismiss, install, cancel, acknowledge, setStartup],
  );
  const spoken = state.phase === 'idle' && note !== '' ? note : announcement(state);

  const check = async () => {
    setMessage('Checking...');
    try {
      const result = await api.checkUpdate();
      setMessage(
        result === 'current'
          ? 'You have the newest version.'
          : result === 'busy'
            ? 'A check cannot start while another task or check is running.'
            : result === 'failed'
              ? 'The check failed. Please try again later.'
              : 'A newer version is available.',
      );
      await refresh();
    } catch {
      setMessage('The check failed. Please try again later.');
    }
  };

  const idle = state.phase === 'idle' || state.phase === 'failed';
  return (
    <UpdatesContext.Provider value={value}>
      {children}
      <div className="visually-hidden" role="status" data-testid="update-live">
        {spoken}
      </div>
      {panel && (
        <Dialog
          title="App updates"
          onClose={() => setPanel(false)}
          testId="updates-panel"
          footer={
            <button type="button" onClick={() => setPanel(false)}>
              Close
            </button>
          }
        >
          {state.version !== null && (
            <p className="dialog-text">
              <span className="badge accent update-badge">
                <Download aria-hidden="true" />
                New version
              </span>{' '}
              Version {state.version} is available.
            </p>
          )}
          <UpdateProgress where="panel" />
          <div className="actions">
            {state.version !== null && idle && (
              <button
                type="button"
                className="primary"
                data-autofocus="true"
                data-update-action="true"
                onClick={install}
              >
                Update now
              </button>
            )}
            <button
              type="button"
              className={state.version === null ? 'primary' : undefined}
              data-autofocus={state.version === null ? 'true' : undefined}
              disabled={working}
              onClick={() => void check()}
            >
              Check now
            </button>
            {state.version !== null && (
              <button type="button" className="ghost" onClick={() => void api.openUpdate()}>
                Open release page
              </button>
            )}
          </div>
          <p className="update-message" role="status">
            {message}
          </p>
          <StartupSwitch where="panel" />
          <p className="hint update-privacy">
            Only the request to GitHub leaves this PC (its address and the app's ordinary request
            headers). No tree data, settings, or IDs leave the PC. An update downloads the installer
            from GitHub and checks it against the release before it is run.
          </p>
        </Dialog>
      )}
    </UpdatesContext.Provider>
  );
}

/** The switch for the check at startup: it applies at once. */
function StartupSwitch({ where }: { where: 'notice' | 'panel' }) {
  const { state, setStartup } = useUpdates();
  const id = useId();
  return (
    <div className="update-switch">
      <button
        type="button"
        role="switch"
        className="switch"
        id={id}
        aria-checked={state.startup}
        data-testid={`update-startup-${where}`}
        onClick={() => setStartup(!state.startup)}
      />
      <label htmlFor={id}>Check for updates when the app starts</label>
    </div>
  );
}

/**
 * How the update stands: the bar and the figure while it downloads, then the wait, the install or
 * the reason it stopped. Nothing here is a live region; the provider announces phase changes.
 */
function UpdateProgress({ where }: { where: 'notice' | 'panel' }) {
  const { state, cancel } = useUpdates();
  const { phase } = state;
  if (phase === 'idle') return null;
  const version = state.version ?? '';
  return (
    <div className="update-progress" data-update-status="true" tabIndex={-1} data-phase={phase}>
      {phase === 'downloading' && (
        <>
          <p className="update-line" data-testid={`update-progress-text-${where}`}>
            Downloading version {version}: {state.percent ?? 0}%
          </p>
          <div className="progress" aria-hidden="true">
            <div className="progress-fill" style={{ width: `${state.percent ?? 0}%` }} />
          </div>
        </>
      )}
      {phase === 'waiting' && (
        <p className="update-line">
          Version {version} is downloaded and checked. Waiting for the running import, pack install
          or AI session to end before it is installed.
        </p>
      )}
      {phase === 'verified' && (
        <p className="update-line">
          Version {version} is downloaded and checked, but this copy of the app cannot install it by
          itself. Open the release page to install it.
        </p>
      )}
      {phase === 'installing' && (
        <p className="update-line">
          Installing version {version}. The app closes and opens again by itself.
        </p>
      )}
      {phase === 'failed' && (
        <p className="update-line update-failure" data-testid={`update-failure-${where}`}>
          {state.failure ?? 'The update failed.'} You can try again, or install it from the release
          page.
        </p>
      )}
      {(phase === 'downloading' || phase === 'waiting') && (
        <div className="actions">
          <button type="button" className="small ghost" onClick={cancel}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

/** An icon button for the top bar and the start screen's banner: it opens the update panel. */
export function UpdatesButton() {
  const { state, openPanel } = useUpdates();
  const newer = state.version !== null;
  return (
    <IconButton
      label="App updates"
      title={newer ? `App updates: version ${state.version} is available` : 'App updates'}
      {...(newer ? { className: 'has-update' } : {})}
      testId="updates-open"
      onClick={openPanel}
    >
      {newer ? (
        <Download size={16} aria-hidden="true" />
      ) : (
        <RefreshCw size={16} aria-hidden="true" />
      )}
    </IconButton>
  );
}

/**
 * The notice: what the last update left behind, told once, and, while a newer version is out, the
 * offer to install it ("Update now"), "Not now", and the switch for the check at startup.
 */
export function UpdateNotice() {
  const { state, dismiss, install, acknowledge } = useUpdates();
  const { outcome } = state;
  return (
    <>
      {outcome !== null && (
        <div className="notice update-notice" data-testid="update-outcome">
          <span className="update-text">{outcomeText(outcome)}</span>
          {outcome.kind === 'not-installed' && (
            <button type="button" className="small" onClick={() => void api.openUpdate()}>
              Open release page
            </button>
          )}
          <button type="button" className="small ghost" onClick={acknowledge}>
            OK
          </button>
        </div>
      )}
      {state.version !== null && (
        <div className="notice accent update-notice" data-testid="update-notice">
          <span className="update-text">Version {state.version} is available.</span>
          {(state.phase === 'idle' || state.phase === 'failed') && (
            <>
              <button
                type="button"
                className="small primary"
                data-update-action="true"
                onClick={install}
              >
                Update now
              </button>
              {state.phase === 'failed' && (
                <button type="button" className="small" onClick={() => void api.openUpdate()}>
                  Open release page
                </button>
              )}
              <button type="button" className="small ghost" onClick={dismiss}>
                Not now
              </button>
            </>
          )}
          {state.phase === 'verified' && (
            <button type="button" className="small" onClick={() => void api.openUpdate()}>
              Open release page
            </button>
          )}
          <UpdateProgress where="notice" />
          <StartupSwitch where="notice" />
        </div>
      )}
    </>
  );
}
