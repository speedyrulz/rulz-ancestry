import { useEffect, useRef, useState } from 'react';
import type { UpdateState } from '../../../shared/updates';
import { api } from '../api';
import './updates.css';

export function Updates() {
  const [state, setState] = useState<UpdateState>({ startup: true, version: null });
  const [message, setMessage] = useState('');
  const checkButton = useRef<HTMLButtonElement>(null);
  const details = useRef<HTMLDetailsElement>(null);
  const refresh = () =>
    api
      .updateState()
      .then(setState)
      .catch(() => undefined);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => clearInterval(timer);
  }, []);
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
    <section className="updates" aria-label="App updates">
      {state.version && (
        <p role="status">
          Version {state.version} is available.{' '}
          <button onClick={() => void api.openUpdate()}>Open release page</button>{' '}
          <button
            onClick={() => {
              if (details.current) details.current.open = true;
              checkButton.current?.focus();
              setMessage('');
              void api.dismissUpdate().then(refresh);
            }}
          >
            Dismiss
          </button>
        </p>
      )}
      <details ref={details}>
        <summary>App updates</summary>
        <button ref={checkButton} onClick={() => void check()}>
          Check for a new version
        </button>
        <p role="status">{message}</p>
        <label>
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
          />{' '}
          Check for a new version at startup
        </label>
        <p>
          Only the request to GitHub leaves this PC (its address and the app's ordinary request
          headers). No tree data, settings, or IDs leave the PC.
        </p>
      </details>
    </section>
  );
}
