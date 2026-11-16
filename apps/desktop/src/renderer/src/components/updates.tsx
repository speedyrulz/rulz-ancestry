import { Download, RefreshCw } from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { UpdateState } from '../../../shared/updates';
import { api } from '../api';
import { Dialog, IconButton } from './ui';
import './updates.css';

/**
 * The check for a new version. One provider keeps what is known (is a newer version out, does the
 * app check at startup) and the panel that holds the controls; the top bar and the start screen
 * show a button that opens the panel, and a thin notice says so when a newer version is out.
 */

interface UpdatesValue {
  state: UpdateState;
  openPanel: () => void;
  /** Hides the notice for this version and shows the panel, at its check button. */
  dismiss: () => void;
}

const UpdatesContext = createContext<UpdatesValue | null>(null);

function useUpdates(): UpdatesValue {
  const value = useContext(UpdatesContext);
  if (value === null) throw new Error('The update controls need an UpdatesProvider above them.');
  return value;
}

export function UpdatesProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<UpdateState>({ startup: true, version: null });
  const [message, setMessage] = useState('');
  const [panel, setPanel] = useState(false);
  const refresh = useCallback(
    () =>
      api
        .updateState()
        .then(setState)
        .catch(() => undefined),
    [],
  );
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => clearInterval(timer);
  }, [refresh]);

  const openPanel = useCallback(() => setPanel(true), []);
  const dismiss = useCallback(() => {
    setPanel(true);
    setMessage('');
    void api.dismissUpdate().then(refresh);
  }, [refresh]);
  const value = useMemo(() => ({ state, openPanel, dismiss }), [state, openPanel, dismiss]);

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

  return (
    <UpdatesContext.Provider value={value}>
      {children}
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
              Version {state.version} is available.{' '}
              <button type="button" className="small" onClick={() => void api.openUpdate()}>
                Open release page
              </button>
            </p>
          )}
          <div className="actions">
            <button
              type="button"
              className="primary"
              data-autofocus="true"
              onClick={() => void check()}
            >
              Check for a new version
            </button>
          </div>
          <p className="update-message" role="status">
            {message}
          </p>
          <label className="check">
            <input
              type="checkbox"
              checked={state.startup}
              onChange={(event) => {
                // Show the new state at once; the box would otherwise snap back until the main
                // process answers.
                const startup = event.target.checked;
                setState((current) => ({ ...current, startup }));
                void api.setUpdateStartup(startup).then(refresh, refresh);
              }}
            />
            Check for a new version at startup
          </label>
          <p className="hint update-privacy">
            Only the request to GitHub leaves this PC (its address and the app's ordinary request
            headers). No tree data, settings, or IDs leave the PC.
          </p>
        </Dialog>
      )}
    </UpdatesContext.Provider>
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

/** A thin notice, shown only while a newer version is out. */
export function UpdateNotice() {
  const { state, dismiss } = useUpdates();
  if (state.version === null) return null;
  return (
    <p className="notice accent update-notice" role="status" data-testid="update-notice">
      <span>Version {state.version} is available.</span>
      <button type="button" className="small" onClick={() => void api.openUpdate()}>
        Open release page
      </button>
      <button type="button" className="small ghost" onClick={dismiss}>
        Dismiss
      </button>
    </p>
  );
}
