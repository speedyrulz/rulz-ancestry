import {
  API_CAP_DEFAULT,
  API_CAP_MAX,
  API_CAP_MIN,
  API_EFFORTS,
  API_MODELS,
  MODEL_PRICES,
  PRICES_AS_OF,
  type ApiEffort,
  type ApiModel,
} from '../../../../../../packages/ai/src/prices';
import type { PersonQuery } from '@rulz/core';
import { useEffect, useRef, useState } from 'react';
import {
  AI_SESSION_MAX_GENERATIONS,
  type AiActivityInfo,
  type AiApiEnd,
  type AiAssistantInfo,
  type AiConnectionInfo,
  type AiKeyState,
  type AiQuestion,
  type AiRunStatus,
  type AiSessionPlan,
  type AiSessionState,
  type AiSessionStatus,
  type RecordSearchSetup,
} from '../../../shared/ipc';
import { api, errorMessage } from '../api';
import { NO_NAME, countOf, formatWhen } from '../format';
import { RecordNotice, timeOf } from './records';
import { ConfirmDialog, Dialog } from './ui';

/**
 * The window of the optional AI assistant. The assistant is off until the
 * user agrees to its notice, which says what an AI may read and ask, and
 * where that goes. Once it is on, a session can be started for a person and
 * some of their ancestors: the time during which an AI app the user connects
 * may use the assistant's tools. The main process holds the session and
 * enforces every limit (see `main/aisession.ts`); this window shows it, and
 * says who it is for and which services may be asked.
 *
 * Nothing can connect an AI in this version yet: a session can be started,
 * watched and stopped, and nothing calls.
 */

/** How many entries of the activity log are read at a time. */
const LOG_PAGE = 100;

/** Who a session is for, by how far back it reaches. */
const GENERATIONS = [
  'This person only',
  'This person and their parents',
  'As far as the grandparents',
  'As far as the great-grandparents',
];

const RELATION = ['', 'parent', 'grandparent', 'great-grandparent'];

const MODEL_LABELS: Record<ApiModel, string> = {
  'claude-opus-5-5': 'Claude Opus 5.5',
  'claude-sonnet-5-5': 'Claude Sonnet 5.5',
  'claude-haiku-5-5': 'Claude Haiku 5.5',
};

const EFFORT_LABELS: Record<ApiEffort, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

const KEY_STATE_WORDS: Record<AiKeyState, string> = {
  missing: 'No key is saved yet (missing).',
  saved: 'A key is saved, encrypted by Windows for your account. The app does not show it again.',
  unreadable: 'The saved key is unreadable on this Windows account. Enter it again.',
  unavailable:
    'This PC cannot encrypt a key for your Windows account, so saving a key is unavailable.',
};

const RUN_ENDED_WORDS: Record<AiApiEnd, string> = {
  done: 'Done: the model finished its turn.',
  stopped: 'You stopped the run.',
  'session-ended': 'The session ended.',
  declined: 'The model declined the request.',
  'max-tokens': 'A response reached the token limit before finishing.',
  paused: 'The model paused its turn.',
  unexpected: 'The model stopped for an unexpected reason.',
  'cap-cost': 'Stopped before the next request could pass your cost cap.',
  'cap-responses': 'Reached the limit of 30 responses for one run.',
  'cap-time': 'Reached the 20-minute time limit for one run.',
  'model-changed': 'Stopped because Anthropic answered with a different model than asked for.',
  'key-refused': 'Anthropic did not accept this key.',
  'key-forbidden': 'This key may not use this model.',
  'rate-limited': 'Anthropic asked to slow down (rate limit reached).',
  overloaded: 'Anthropic is overloaded or had a server error.',
  network: 'Could not reach Anthropic over the network.',
  timeout: 'A request to Anthropic timed out.',
  failed: 'The run failed.',
};

function priceWords(amount: number): string {
  return Number.isInteger(amount) ? `$${amount}` : `$${amount.toFixed(2)}`;
}

/** A name for the page; "Name not recorded" when the tree has none. */
const nameOf = (name: string) => (name === '' ? NO_NAME : name);

/** What was asked of a service: the name and the years. */
function queryWords(query: PersonQuery): string {
  return [
    `${query.given} ${query.surname}`.trim(),
    query.birthYear === null ? '' : `born ${query.birthYear}`,
    query.deathYear === null ? '' : `died ${query.deathYear}`,
  ]
    .filter((part) => part !== '')
    .join(', ');
}

/** Where one question stands, in a few words. */
function answerWords(question: AiQuestion): string {
  if (question.state === 'asking') return 'asking…';
  if (question.state === 'failed') return `no answer: ${question.message}`;
  if (question.state === 'not-sent') return `not sent: ${question.message}`;
  return [
    `${countOf(question.found, 'record', 'records')} passed on${
      question.cached ? ' (from an earlier answer; nothing was sent)' : ''
    }`,
    question.message,
  ]
    .filter((part) => part !== '')
    .join('. ');
}

interface NoticeProps {
  info: AiAssistantInfo;
  onAgree: () => void;
  onLog: () => void;
  onClose: () => void;
}

/** What turning the assistant on means: shown until the user agrees, and again when it is worded anew. */
function AiNotice({ info, onAgree, onLog, onClose }: NoticeProps) {
  return (
    <div className="ai-notice" data-testid="ai-notice">
      <p className="dialog-text">
        The AI assistant is optional, and it is off. Turned on, it lets an AI app that you connect
        look for records of people of your tree and propose matches. You decide about every one.
        Before you turn it on:
      </p>
      <ul>
        <li data-testid="ai-notice-connect">
          <strong>How an AI app is connected:</strong>{' '}
          {info.canConnect
            ? 'through a connector of this app that you install in your own Claude Desktop, or add to Claude Code. During a session, and only then, the connector reaches this app over a connection between two programs on this PC. It needs a key that this app makes anew for each session and keeps in a file in its own data folder until the session ends. Outside a session nothing listens, and there is no key.'
            : 'this copy of the app has no connector to hand out, so no AI app on this PC can be connected with it. Your own API key can still be used (see below).'}
        </li>
        <li data-testid="ai-notice-same-account">
          <strong>What this cannot keep out:</strong> another program that runs under your Windows
          account could read that key during a session and call the same tools: read what an AI
          could read, and ask the services within the limits of the session. Such a program could
          read the file of your tree directly as well. This app cannot tell which program holds the
          key: the name a connected program gives is that program&apos;s own word.
        </li>
        <li>
          <strong>What an AI can read, during a session you start:</strong> the people of the open
          tree who are not living: their names, the dates and places of their events, and who their
          parents, partners, children, brothers and sisters are. It is given nothing of a person who
          may be living, and no notes, pictures, citations or DNA data of anyone.
        </li>
        <li>
          <strong>What it can ask, and whom:</strong> these services, for the people of the session
          only:
          <ul data-testid="ai-notice-sources">
            {info.sources.map((source) => (
              <li key={source.id}>
                {source.name}: {source.asks}.
              </li>
            ))}
          </ul>
          At most {info.requestsPerSource} questions to each service in a session, only under a name
          your tree has for the person or a spelling a letter or two from it, and with years within
          10 of your tree&apos;s. Every question is shown in this window as it is asked.
        </li>
        <li>
          <strong>Where it goes:</strong> what the AI reads of your tree, and the records the
          services return, go to the AI service behind the app you connect, under your own account
          there and its privacy rules. This app sends them nowhere else.
        </li>
        <li data-testid="ai-notice-other-tools">
          <strong>What this app does not see or limit:</strong> the AI app itself. It may have other
          tools turned on, such as a search of the web, and what it does with them and what it keeps
          of your conversation follow its own settings and rules. This app takes proposals only for
          records it fetched itself.
        </li>
        <li data-testid="ai-notice-api-key">
          <strong>With &ldquo;my own API key&rdquo;:</strong> when you choose to use your own
          Anthropic API key, this app itself sends to Anthropic, under your own key and
          Anthropic&apos;s terms and retention, what the tools return (people who are not living,
          names, dates, places, and the record texts of the sources that allow it) and the
          conversation. This happens only after you save a key and start a run. You pay Anthropic;
          the cost this app shows is an estimate from its own price table, and its caps are the
          app&apos;s own. A request already sent cannot be taken back by Stop and may be billed. The
          key is kept encrypted for this Windows account and can be removed at any time.
        </li>
        <li>
          <strong>When:</strong> only during a session you start here, for one person and up to
          three generations of their ancestors, and the services you tick. A session ends when you
          stop it, after {info.idleMinutes} minutes without a call, after {info.maxCalls} calls,
          {info.maxHours === 1 ? ' an hour' : ` ${info.maxHours} hours`} after it started at the
          latest, when the tree or the app closes, and when the window of the app is loaded again.
        </li>
        <li>
          <strong>What an AI cannot do:</strong> change your tree, read a file or open an address.
          It proposes. A proposal changes nothing until you keep or attach the record yourself.
        </li>
        <li>
          <strong>A record is a text someone else wrote.</strong> It can hold words written as
          instructions. The app passes records on as data and says so. An AI can still be wrong:
          every reason it gives must quote the record, and the app shows only the reasons whose
          quote it found there.
        </li>
        <li>
          <strong>What is kept:</strong> proposals stay in the app&apos;s memory until the tree
          closes or the assistant is turned off; of sessions before the last one, the latest 1,000.
          When you keep a proposed record for later, the AI&apos;s reasons are saved with it in the
          tree&apos;s file. An activity log on this PC notes every call: what was asked and which
          records were given, never the text of a record as a service gave it. It does hold the
          words an AI asked with: the names it asked a service for, and what it searched your tree
          for. An entry goes after {info.logDays} days, and you can clear the log at any time.
        </li>
        <li>
          <strong>Turning it off:</strong> in this window, at any time.
        </li>
      </ul>
      <div className="dialog-actions">
        <button type="button" onClick={onLog} data-testid="ai-log-open">
          Activity log
        </button>
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="primary" onClick={onAgree} data-testid="ai-agree">
          Turn the assistant on
        </button>
      </div>
    </div>
  );
}

interface SearchNoticeProps {
  personId: string;
  /** Called once the notice of the search is agreed to. */
  onAgreed: () => void;
  onClose: () => void;
}

/** The notice of the search for records, which a session asks through. */
function SearchNotice({ personId, onAgreed, onClose }: SearchNoticeProps) {
  const [setup, setSetup] = useState<RecordSearchSetup | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    api.getRecordSearch(personId).then(
      (found) => {
        if (!current) return;
        if (found === null) setError('This person is no longer in the tree.');
        else setSetup(found);
      },
      (failure: unknown) => {
        if (current) setError(errorMessage(failure));
      },
    );
    return () => {
      current = false;
    };
  }, [personId]);

  const agree = () => {
    api.agreeToRecordSearch().then(onAgreed, (failure: unknown) => setError(errorMessage(failure)));
  };

  return (
    <>
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {setup === null && error === null && <p className="muted">Loading…</p>}
      {setup !== null && (
        <RecordNotice
          sources={setup.sources}
          links={setup.links}
          onAgree={agree}
          onClose={onClose}
        />
      )}
    </>
  );
}

/** How this copy of the app is connected to an AI app: done once for each AI app. */
function ConnectSection({ info }: { info: AiAssistantInfo }) {
  const [copied, setCopied] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const failed = (failure: unknown) => setProblem(errorMessage(failure));
  const show = () => {
    api.showAiConnector().then((shown) => {
      setProblem(shown ? null : 'This copy of the app has no connector file.');
    }, failed);
  };
  const copy = () => {
    api.copyAiConnectorCommand().then((done) => {
      setCopied(done);
      setProblem(done ? null : 'There is no command to copy.');
    }, failed);
  };
  if (!info.canConnect) {
    return (
      <p className="hint" data-testid="ai-no-connection">
        This copy of the app has no connector to hand out, so no AI app on this PC can be connected
        with it. Your own API key can still be used.
      </p>
    );
  }
  return (
    <details className="ai-connect" data-testid="ai-connect">
      <summary>Connect an AI app (once for each app)</summary>
      <ul>
        <li>
          <strong>Claude Desktop:</strong>{' '}
          <button type="button" className="small" onClick={show} data-testid="ai-connector-show">
            Show the connector file
          </button>{' '}
          and drag it into the window of Claude Desktop, which then asks whether to install it.{' '}
          <span data-testid="ai-connector-ways">
            You can also choose the file in Claude Desktop: in its Settings, go to the extensions
            (under &ldquo;Desktop app&rdquo;, &ldquo;Manage&rdquo; beside Extensions; in older
            versions &ldquo;Extensions&rdquo;), then &ldquo;Advanced settings&rdquo; and
            &ldquo;Install Extension&rdquo;. A double click on the file works only where Windows
            knows that such files belong to Claude Desktop.
          </span>{' '}
          If Claude says later that the connector does not fit this app, install it again from here.
          {!info.connectorFileFits && (
            <span data-testid="ai-connector-other-folder">
              {' '}
              This copy of the app keeps its data in another folder than an installed copy does. So
              that the connector finds a session of this copy, choose this folder as the
              connector&apos;s &ldquo;Data folder&rdquo; when Claude Desktop asks, or later in the
              connector&apos;s settings there:
              <code className="ai-command" data-testid="ai-connector-data-folder">
                {info.connectorDataFolder}
              </code>
            </span>
          )}
        </li>
        <li>
          <strong>Claude Code:</strong>{' '}
          {info.connectorCommand === '' ? (
            <span data-testid="ai-connector-no-command">
              no command is offered, since the folder this app is in has a character in its name
              that a command line could read as something else.
            </span>
          ) : (
            <>
              run this once in a terminal. It needs Node.js 18 or later on this PC.
              <code className="ai-command" data-testid="ai-connector-command">
                {info.connectorCommand}
              </code>
              <button
                type="button"
                className="small"
                onClick={copy}
                data-testid="ai-connector-copy"
              >
                Copy the command
              </button>
              {copied && <span data-testid="ai-connector-copied"> Copied.</span>}
            </>
          )}
        </li>
      </ul>
      <p className="hint">
        The connector reaches this app only while a session is under way. In the AI app, pick the
        connector&apos;s instructions &ldquo;research_session&rdquo;, or ask it to look for records
        of the people of your session with RulZ Ancestry.
      </p>
      {problem !== null && (
        <p className="error" role="alert">
          {problem}
        </p>
      )}
    </details>
  );
}

interface ApiControlsProps {
  keyState: AiKeyState | null;
  onKeyState: (state: AiKeyState) => void;
  model: ApiModel;
  onModel: (model: ApiModel) => void;
  effort: ApiEffort;
  onEffort: (effort: ApiEffort) => void;
  capText: string;
  onCapText: (capText: string) => void;
  inSession: boolean;
  runRunning: boolean;
  onStartedRun: () => void;
}

/** The user's own Anthropic API key and the settings for a run of route C. */
function ApiControls({
  keyState,
  onKeyState,
  model,
  onModel,
  effort,
  onEffort,
  capText,
  onCapText,
  inSession,
  runRunning,
  onStartedRun,
}: ApiControlsProps) {
  const keyInputRef = useRef<HTMLInputElement>(null);
  const [hasKeyText, setHasKeyText] = useState(false);
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyProblem, setKeyProblem] = useState<string | null>(null);
  const [runBusy, setRunBusy] = useState(false);
  const [runProblem, setRunProblem] = useState<string | null>(null);

  const saveKey = () => {
    const raw = keyInputRef.current?.value.trim() ?? '';
    // Clear the field before the call returns; the key is never kept in React state.
    if (keyInputRef.current !== null) keyInputRef.current.value = '';
    setHasKeyText(false);
    if (raw === '') return;
    setKeyBusy(true);
    setKeyProblem(null);
    api
      .saveAiKey(raw)
      .then(
        (answer) => {
          if (!answer.ok) {
            setKeyProblem(answer.message);
            return;
          }
          return api.getAiKeyState().then(onKeyState);
        },
        (failure: unknown) => setKeyProblem(errorMessage(failure)),
      )
      .finally(() => setKeyBusy(false));
  };

  const removeKey = () => {
    setKeyBusy(true);
    setKeyProblem(null);
    api
      .removeAiKey()
      .then(onKeyState, (failure: unknown) => setKeyProblem(errorMessage(failure)))
      .finally(() => setKeyBusy(false));
  };

  const capUsd = Number(capText);
  const capValid = Number.isFinite(capUsd) && capUsd >= API_CAP_MIN && capUsd <= API_CAP_MAX;
  const canStartRun = inSession && !runRunning && keyState === 'saved' && capValid && !runBusy;

  const startRun = () => {
    if (!canStartRun) return;
    setRunBusy(true);
    setRunProblem(null);
    api
      .startAiRun({ model, effort, capUsd })
      .then(
        (answer) => {
          if (!answer.ok) {
            setRunProblem(answer.message);
            return;
          }
          onStartedRun();
        },
        (failure: unknown) => setRunProblem(errorMessage(failure)),
      )
      .finally(() => setRunBusy(false));
  };

  return (
    <div className="ai-api-section" data-testid="ai-api-section">
      <div className="record-key" data-testid="ai-key">
        <strong>Anthropic API key</strong>
        <p
          className={keyState === 'unreadable' || keyState === 'unavailable' ? 'error' : undefined}
          data-testid="ai-key-state"
        >
          {keyState === null ? 'Checking key…' : KEY_STATE_WORDS[keyState]}{' '}
          {(keyState === 'saved' || keyState === 'unreadable') && (
            <button
              type="button"
              disabled={keyBusy}
              onClick={removeKey}
              data-testid="ai-key-remove"
            >
              Remove the key
            </button>
          )}
        </p>
        {keyState !== 'unavailable' && (
          <form
            className="record-key-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (hasKeyText && !keyBusy) saveKey();
            }}
          >
            <label htmlFor="ai-key-input">
              {keyState === 'saved' ? 'Replace key' : 'Your key'}
            </label>
            <input
              ref={keyInputRef}
              id="ai-key-input"
              type="password"
              autoComplete="off"
              spellCheck={false}
              maxLength={300}
              onChange={(event) => setHasKeyText(event.target.value.trim() !== '')}
              data-testid="ai-key-input"
            />
            <button type="submit" disabled={!hasKeyText || keyBusy} data-testid="ai-key-save">
              {keyState === 'saved' ? 'Replace the key' : 'Save the key'}
            </button>
          </form>
        )}
        {keyProblem !== null && (
          <p className="error" role="alert" data-testid="ai-key-problem">
            {keyProblem}
          </p>
        )}
      </div>

      <div className="ai-run-controls" data-testid="ai-run-controls">
        <div className="field">
          <label htmlFor="ai-run-model">Model</label>
          <select
            id="ai-run-model"
            value={model}
            onChange={(event) => onModel(event.target.value as ApiModel)}
            data-testid="ai-run-model"
          >
            {API_MODELS.map((item) => (
              <option key={item} value={item}>
                {MODEL_LABELS[item]} ({priceWords(MODEL_PRICES[item].input)} /{' '}
                {priceWords(MODEL_PRICES[item].output)} per million input / output tokens)
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="ai-run-effort">Effort</label>
          <select
            id="ai-run-effort"
            value={effort}
            onChange={(event) => onEffort(event.target.value as ApiEffort)}
            data-testid="ai-run-effort"
          >
            {API_EFFORTS.map((item) => (
              <option key={item} value={item}>
                {EFFORT_LABELS[item]}
              </option>
            ))}
          </select>
          <p className="hint" data-testid="ai-effort-hint">
            At high effort a response can use its whole allowance on thinking before calling a tool,
            and the run then ends with that response paid for.
          </p>
        </div>

        <div className="field">
          <label htmlFor="ai-run-cap">
            Cap in dollars (${API_CAP_MIN.toFixed(2)} to ${API_CAP_MAX.toFixed(2)})
          </label>
          <input
            id="ai-run-cap"
            type="number"
            min={API_CAP_MIN}
            max={API_CAP_MAX}
            step="0.05"
            value={capText}
            onChange={(event) => onCapText(event.target.value)}
            data-testid="ai-run-cap"
          />
        </div>

        <p className="hint" data-testid="ai-price-note">
          Prices as of {PRICES_AS_OF}. Figures shown here are estimates; check Anthropic&apos;s own
          pages for the bill.
        </p>

        {runProblem !== null && (
          <p className="error" role="alert" data-testid="ai-run-problem">
            {runProblem}
          </p>
        )}

        {inSession && !runRunning && (
          <div className="actions">
            <button
              type="button"
              className="primary"
              disabled={!canStartRun}
              onClick={startRun}
              data-testid="ai-run-start"
            >
              Start a run
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Progress and outcome of one API run in a route-C session. */
function RunView({
  run,
  canStopRun,
  onStopRun,
}: {
  run: AiRunStatus;
  canStopRun: boolean;
  onStopRun: () => void;
}) {
  const progress = run.progress ?? {
    responses: 0,
    usage: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
    costUsd: 0,
    costMayBeHigher: false,
    lastTool: null,
    text: '',
    ended: null,
  };
  const modelLabel = MODEL_LABELS[run.settings.model as ApiModel] ?? run.settings.model;
  return (
    <div className="ai-run" data-testid="ai-run">
      <p className="dialog-text" data-testid="ai-run-status">
        {run.running ? (
          <>
            A run is under way ({modelLabel}, {run.settings.effort} effort).{' '}
            {canStopRun && (
              <button type="button" className="small" onClick={onStopRun} data-testid="ai-run-stop">
                Stop the run
              </button>
            )}
          </>
        ) : (
          <span data-testid="ai-run-ended">
            The run ended:{' '}
            {progress.ended !== null ? RUN_ENDED_WORDS[progress.ended] : 'The run ended.'}
          </span>
        )}
      </p>
      <ul className="run-list" data-testid="ai-run-figures">
        <li data-testid="ai-run-responses">
          Responses so far: {countOf(progress.responses, 'response', 'responses')}
        </li>
        <li data-testid="ai-run-tokens">
          Tokens: {progress.usage.input.toLocaleString()} input,{' '}
          {progress.usage.cacheWrite.toLocaleString()} cache written,{' '}
          {progress.usage.cacheRead.toLocaleString()} cache read,{' '}
          {progress.usage.output.toLocaleString()} output
        </li>
        <li data-testid="ai-run-cost">
          Estimated cost: ${progress.costUsd.toFixed(4)} of ${run.settings.capUsd.toFixed(2)} cap
          (prices as of {PRICES_AS_OF}; figures are estimates, check Anthropic&apos;s own pages for
          the bill)
          {progress.costMayBeHigher && (
            <span className="error" data-testid="ai-run-cost-higher">
              {' '}
              — the cost may be higher: Anthropic may bill a request whose answer did not arrive.
            </span>
          )}
        </li>
        <li data-testid="ai-run-last-tool">Last tool called: {progress.lastTool ?? 'none yet'}</li>
      </ul>
      {progress.text !== '' && (
        <div className="ai-run-text-box" data-testid="ai-run-text-section">
          <h3>The AI&apos;s own words (may repeat what a record says)</h3>
          <p className="ai-run-text" data-testid="ai-run-text">
            {progress.text}
          </p>
        </div>
      )}
    </div>
  );
}

interface SessionViewProps {
  session: AiSessionStatus;
  /** How an AI app can reach the session now. */
  connection: AiConnectionInfo;
  maxCalls: number;
  /** How many proposals the app holds in memory, of every session. */
  proposals: number;
  onStop: () => void;
  onStopRun: () => void;
  onOpenInbox: () => void;
  apiControls: React.ReactNode;
}

/** The session that is under way, or the last one that ended, with every question it asked. */
function SessionView({
  session,
  connection,
  maxCalls,
  proposals,
  onStop,
  onStopRun,
  onOpenInbox,
  apiControls,
}: SessionViewProps) {
  const personName = (personId: string) => {
    const person = session.people.find((entry) => entry.personId === personId);
    return person === undefined ? 'someone' : nameOf(person.name);
  };
  const sourceName = (sourceId: string) =>
    session.sources.find((source) => source.id === sourceId)?.name ?? sourceId;
  return (
    <section className="ai-session" data-testid="ai-session">
      <p className="dialog-text" data-testid="ai-session-status">
        {session.status === 'running' ? (
          <>
            A session is under way.
            {session.idleAt !== null &&
              ` It ends at ${timeOf(session.idleAt)} unless a call comes before${
                session.lastsUntil === null
                  ? ''
                  : `, and at ${timeOf(session.lastsUntil)} at the latest`
              }.`}{' '}
            <button type="button" className="small" onClick={onStop} data-testid="ai-stop">
              Stop
            </button>
          </>
        ) : (
          session.endedMessage
        )}
      </p>
      {session.status === 'running' && session.route === 'app' && connection.problem !== '' && (
        <p className="error" role="alert" data-testid="ai-connection-problem">
          {connection.problem}
        </p>
      )}
      {session.status === 'running' && session.route === 'app' && connection.problem === '' && (
        <p className="dialog-text" data-testid="ai-session-clients">
          {connection.clients.length === 0
            ? 'No AI app is connected to this session yet. One connects when you ask it to work with RulZ Ancestry.'
            : `Connected now: ${connection.clients
                .map(
                  (client) =>
                    `a program that calls itself "${client.name === '' ? 'nothing' : client.name}"${
                      client.version === '' ? '' : ` (${client.version})`
                    }, since ${timeOf(client.since)}`,
                )
                .join('; ')}.`}
        </p>
      )}
      {session.run !== null && (
        <RunView
          run={session.run}
          canStopRun={session.status === 'running'}
          onStopRun={onStopRun}
        />
      )}
      {session.status === 'running' && session.route === 'api' && apiControls}
      <p className="dialog-text">It is for:</p>
      <ul className="run-list" data-testid="ai-session-people">
        {session.people.map((person) => (
          <li key={person.personId}>{nameOf(person.name)}</li>
        ))}
      </ul>
      <ul className="run-list" data-testid="ai-session-sources">
        {session.sources.map((source) => (
          <li key={source.id}>
            {source.name}: {source.used} of {source.limit} questions asked
          </li>
        ))}
      </ul>
      <p className="dialog-text" data-testid="ai-session-calls">
        {session.calls.toLocaleString()} of the{' '}
        {maxCalls === 1 ? '1 call' : `${maxCalls.toLocaleString()} calls`} a session takes.
      </p>
      {session.questions.length > 0 && (
        <>
          <h3>What was asked</h3>
          <ol className="ai-questions" data-testid="ai-questions">
            {[...session.questions]
              .sort((a, b) => a.number - b.number)
              .map((question) => (
                <li key={question.number} data-testid="ai-question">
                  {sourceName(question.sourceId)}, for {personName(question.personId)}:{' '}
                  {queryWords(question.query)}; <span>{answerWords(question)}</span>
                </li>
              ))}
          </ol>
        </>
      )}
      <p className="dialog-text" data-testid="ai-session-proposals">
        {countOf(session.proposals, 'proposal', 'proposals')} in this session.{' '}
        {proposals > 0 && (
          <button type="button" className="small" onClick={onOpenInbox} data-testid="ai-open-inbox">
            Open the inbox
          </button>
        )}
      </p>
    </section>
  );
}

interface SessionPlanProps {
  personId: string;
  route: 'app' | 'api';
  onRoute: (route: 'app' | 'api') => void;
  apiControls: React.ReactNode;
  /** Called with the session as it stands once one was started. */
  onStarted: (state: AiSessionState) => void;
  /** Called when a start was refused for want of an agreed notice: the window reads the assistant again. */
  onNotice: () => void;
  /** The proposals as the workspace knows them, to keep their count while the new session is read. */
  ai: AiSessionState | null;
}

/** Who a new session would be for, and which services it may ask. Nothing starts before "Start session". */
function SessionPlan({
  personId,
  route,
  onRoute,
  apiControls,
  onStarted,
  onNotice,
  ai,
}: SessionPlanProps) {
  const [generations, setGenerations] = useState(1);
  const [plan, setPlan] = useState<AiSessionPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The services the user ticked. None are ticked to begin with. */
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [starting, setStarting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    api.planAiSession({ personId, generations }).then(
      (loaded) => {
        if (!current) return;
        if (loaded === null) {
          setError('This person is no longer in the tree.');
          return;
        }
        setPlan(loaded);
        setError(null);
      },
      (failure: unknown) => {
        if (current) setError(errorMessage(failure));
      },
    );
    return () => {
      current = false;
    };
  }, [personId, generations]);

  const people = plan?.people ?? [];
  const eligible = people.filter((person) => person.leftOut === null);
  const leftOut = people.filter((person) => person.leftOut !== null);
  // A service the plan no longer offers is not asked, even when it was ticked.
  const chosen = (plan?.sources ?? []).filter((source) => ticked.has(source.id));

  const start = () => {
    if (plan === null || chosen.length === 0 || eligible.length === 0) return;
    setProblem(null);
    setStarting(true);
    api
      .startAiSession({
        route,
        personId,
        generations,
        sourceIds: chosen.map((source) => source.id),
        stamp: plan.stamp,
      })
      .then(
        (result) => {
          if (!result.ok) {
            setProblem(result.problem.message);
            // Who the session would be for now: the tree changed under the plan that was shown.
            if (result.plan !== null) setPlan(result.plan);
            if (result.problem.kind === 'notice') onNotice();
            return;
          }
          // Shown at once, then read with the count of proposals as the main process has it.
          onStarted({
            session: result.session,
            connection: ai?.connection ?? { open: false, problem: '', clients: [] },
            proposals: ai?.proposals ?? 0,
            proposalsRevision: ai?.proposalsRevision ?? 0,
          });
          return api.getAiSession().then(onStarted);
        },
        (failure: unknown) => setProblem(errorMessage(failure)),
      )
      .catch(() => undefined)
      .finally(() => setStarting(false));
  };

  return (
    <section data-testid="ai-plan">
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {plan === null && error === null && <p className="muted">Loading…</p>}
      {plan !== null && (
        <>
          <fieldset className="options" data-testid="ai-route">
            <legend>How the AI is reached</legend>
            <label>
              <input
                type="radio"
                name="ai-route"
                checked={route === 'app'}
                onChange={() => onRoute('app')}
                data-testid="ai-route-app"
              />
              <span>An AI app on this PC (Claude Desktop or Claude Code)</span>
            </label>
            <label>
              <input
                type="radio"
                name="ai-route"
                checked={route === 'api'}
                onChange={() => onRoute('api')}
                data-testid="ai-route-api"
              />
              <span>My own Anthropic API key</span>
            </label>
          </fieldset>

          {route === 'api' && apiControls}

          <div className="field">
            <label htmlFor="ai-generations">Who the session is for</label>
            <select
              id="ai-generations"
              value={generations}
              onChange={(event) => setGenerations(Number(event.target.value))}
              data-testid="ai-generations"
            >
              {GENERATIONS.slice(0, AI_SESSION_MAX_GENERATIONS + 1).map((label, index) => (
                <option key={label} value={index}>
                  {label}
                </option>
              ))}
            </select>
          </div>

          <h3>Services the AI may ask</h3>
          <ul className="run-list">
            {plan.sources.map((source) => (
              <li key={source.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={ticked.has(source.id)}
                    onChange={(event) =>
                      setTicked((now) => {
                        const next = new Set(now);
                        if (event.target.checked) next.add(source.id);
                        else next.delete(source.id);
                        return next;
                      })
                    }
                    data-testid={`ai-source-${source.id}`}
                  />{' '}
                  <strong>{source.name}</strong>
                </label>
                <div className="hint">
                  It is sent {source.asks}.{' '}
                  <a href={source.termsUrl} target="_blank" rel="noreferrer">
                    Terms of use
                  </a>
                </div>
              </li>
            ))}
          </ul>

          {eligible.length > 0 && (
            <>
              <h3>{countOf(eligible.length, 'person', 'people')} the session is for</h3>
              <ol className="run-list" data-testid="ai-plan-people">
                {eligible.map((person) => (
                  <li key={person.personId}>
                    {nameOf(person.name)}
                    {person.generation > 0 && (
                      <span className="muted"> ({RELATION[person.generation] ?? 'ancestor'})</span>
                    )}
                  </li>
                ))}
              </ol>
            </>
          )}
          {leftOut.length > 0 && (
            <>
              <h3>{countOf(leftOut.length, 'person is', 'people are')} left out</h3>
              <ul className="run-list" data-testid="ai-plan-left-out">
                {leftOut.map((person) => (
                  <li key={person.personId}>
                    {nameOf(person.name)}
                    <span className="muted">
                      {person.generation > 0 && ` (${RELATION[person.generation] ?? 'ancestor'})`}:
                      may be living
                    </span>
                  </li>
                ))}
              </ul>
              <p className="hint">
                Nothing of them is given to the AI, and nothing is asked for them.
              </p>
            </>
          )}

          <p className="dialog-text" data-testid="ai-plan-count">
            {chosen.length === 0
              ? 'Tick a service the AI may ask.'
              : eligible.length === 0
                ? 'Everybody here may be living, so there is nobody a session can be for.'
                : `A session lets ${
                    route === 'api' ? 'a run with your key' : 'the AI app you connect'
                  } ask each ticked service at most ${plan.requestsPerSource} questions about ${
                    eligible.length === 1
                      ? 'this 1 person'
                      : `these ${countOf(eligible.length, 'person', 'people')}`
                  }. It ends after ${plan.idleMinutes} minutes without a call, or when you stop it.`}
          </p>
        </>
      )}
      {problem !== null && (
        <p className="error" role="alert" data-testid="ai-problem">
          {problem}
        </p>
      )}
      {plan !== null && (
        <div className="actions">
          <button
            type="button"
            className="primary"
            disabled={starting || chosen.length === 0 || eligible.length === 0}
            onClick={start}
            data-testid="ai-start"
          >
            Start session
          </button>
        </div>
      )}
    </section>
  );
}

interface AiAssistantDialogProps {
  /** The person whose page is open; null when none is. A session starts from them. */
  personId: string | null;
  /** The session and the proposals as the workspace follows them; null until they are known. */
  ai: AiSessionState | null;
  /** Called with the session and the proposals whenever this window learns how they stand. */
  onAi: (state: AiSessionState) => void;
  /** Closes this window and opens the inbox at the proposals. */
  onOpenInbox: () => void;
  onClose: () => void;
}

export function AiAssistantDialog({
  personId,
  ai,
  onAi,
  onOpenInbox,
  onClose,
}: AiAssistantDialogProps) {
  const [info, setInfo] = useState<AiAssistantInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Counts the times the assistant is read again. */
  const [round, setRound] = useState(0);
  const [showLog, setShowLog] = useState(false);
  const [askOff, setAskOff] = useState(false);
  const [route, setRoute] = useState<'app' | 'api'>('app');
  const [keyState, setKeyState] = useState<AiKeyState | null>(null);
  const [model, setModel] = useState<ApiModel>('claude-opus-5-5');
  const [effort, setEffort] = useState<ApiEffort>('medium');
  const [capText, setCapText] = useState(String(API_CAP_DEFAULT));

  useEffect(() => {
    let current = true;
    api.getAiAssistant().then(
      (loaded) => {
        if (!current) return;
        setInfo(loaded);
        setError(null);
        onAi(loaded);
      },
      (failure: unknown) => {
        if (current) setError(errorMessage(failure));
      },
    );
    api.getAiKeyState().then(
      (state) => {
        if (current) setKeyState(state);
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [round, onAi]);

  /** Takes over how the assistant stands, here and in the workspace. */
  const take = (next: AiAssistantInfo) => {
    setInfo(next);
    onAi(next);
  };

  const again = () => setRound((now) => now + 1);

  const agree = () => {
    api.agreeToAiAssistant().then(take, (failure: unknown) => setError(errorMessage(failure)));
  };

  const stop = () => {
    api.stopAiSession().then(onAi, (failure: unknown) => setError(errorMessage(failure)));
  };

  const stopRun = () => {
    api.stopAiRun().then(onAi, (failure: unknown) => setError(errorMessage(failure)));
  };

  const refreshSession = () => {
    api.getAiSession().then(onAi, (failure: unknown) => setError(errorMessage(failure)));
  };

  // The workspace keeps the session fresh; what this window read on opening is only a start.
  const session = ai?.session ?? null;
  const running = session?.status === 'running';
  const proposals = ai?.proposals ?? 0;

  const apiControls = (
    <ApiControls
      keyState={keyState}
      onKeyState={setKeyState}
      model={model}
      onModel={setModel}
      effort={effort}
      onEffort={setEffort}
      capText={capText}
      onCapText={setCapText}
      inSession={running && session.route === 'api'}
      runRunning={session?.run?.running === true}
      onStartedRun={refreshSession}
    />
  );

  return (
    <Dialog title="AI assistant" onClose={onClose} testId="ai-assistant" wide>
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {info === null && error === null && <p className="muted">Loading…</p>}

      {info !== null && !info.agreed && (
        <AiNotice info={info} onAgree={agree} onLog={() => setShowLog(true)} onClose={onClose} />
      )}

      {info !== null && info.agreed && !info.searchAgreed && (
        <>
          <p className="dialog-text" data-testid="ai-needs-search-notice">
            A session asks services through the app&apos;s search for records, so its notice comes
            first.{personId === null && " Open this window from a person's page."}
          </p>
          {personId === null ? (
            <div className="dialog-actions">
              <button type="button" onClick={onClose} data-testid="ai-close">
                Close
              </button>
            </div>
          ) : (
            <SearchNotice personId={personId} onAgreed={again} onClose={onClose} />
          )}
        </>
      )}

      {info !== null && info.agreed && info.searchAgreed && (
        <>
          <ConnectSection info={info} />
          {session !== null && (
            <SessionView
              session={session}
              connection={ai?.connection ?? info.connection}
              maxCalls={info.maxCalls}
              proposals={proposals}
              onStop={stop}
              onStopRun={stopRun}
              onOpenInbox={onOpenInbox}
              apiControls={apiControls}
            />
          )}
          {!running && personId !== null && (
            <SessionPlan
              key={personId}
              personId={personId}
              route={route}
              onRoute={setRoute}
              apiControls={apiControls}
              ai={ai}
              onStarted={onAi}
              onNotice={again}
            />
          )}
          {!running && personId === null && (
            <p className="dialog-text" data-testid="ai-no-person">
              To start a session, choose a person and open this window from their page.
            </p>
          )}
          <div className="dialog-actions">
            <button type="button" onClick={() => setShowLog(true)} data-testid="ai-log-open">
              Activity log
            </button>
            <button type="button" onClick={() => setAskOff(true)} data-testid="ai-turn-off">
              Turn the assistant off
            </button>
            <button type="button" onClick={onClose} data-testid="ai-close">
              Close
            </button>
          </div>
        </>
      )}

      {askOff && (
        <ConfirmDialog
          title="Turn the AI assistant off?"
          confirmLabel="Turn it off"
          onConfirm={async () => {
            take(await api.turnOffAiAssistant());
          }}
          onClose={() => setAskOff(false)}
        >
          A session that is under way ends, and the proposals you have not kept are forgotten
          {proposals > 0 && ` (the app holds ${countOf(proposals, 'proposal', 'proposals')} now)`}.
          What your tree keeps, and the activity log, stay.
        </ConfirmDialog>
      )}

      {showLog && info !== null && (
        <AiActivityDialog logDays={info.logDays} onClose={() => setShowLog(false)} />
      )}
    </Dialog>
  );
}

interface AiActivityDialogProps {
  /** How many days the log keeps an entry. */
  logDays: number;
  onClose: () => void;
}

/** The activity log of the assistant: every call an AI made, the latest first. */
function AiActivityDialog({ logDays, onClose }: AiActivityDialogProps) {
  const [page, setPage] = useState<{ items: AiActivityInfo[]; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [askClear, setAskClear] = useState(false);
  /** Counts the readings of the log, so that "More" after a clearing does not bring old entries back. */
  const reading = useRef(0);
  /**
   * True once "More" brought nothing new. The count of the log can name an
   * entry that is not handed over (one a damaged file holds), and the button
   * would otherwise stay for good.
   */
  const [ended, setEnded] = useState(false);

  useEffect(() => {
    let current = true;
    reading.current += 1;
    api.listAiActivity({ offset: 0, limit: LOG_PAGE }).then(
      (loaded) => {
        if (current) setPage(loaded);
      },
      (failure: unknown) => {
        if (current) setError(errorMessage(failure));
      },
    );
    return () => {
      current = false;
    };
  }, []);

  const more = () => {
    if (page === null) return;
    const mine = reading.current;
    setBusy(true);
    api
      .listAiActivity({ offset: page.items.length, limit: LOG_PAGE })
      .then(
        (loaded) => {
          if (reading.current !== mine) return;
          const known = new Set(page.items.map((item) => item.id));
          if (!loaded.items.some((item) => !known.has(item.id))) setEnded(true);
          setPage((now) => {
            if (now === null) return now;
            const held = new Set(now.items.map((item) => item.id));
            return {
              items: [...now.items, ...loaded.items.filter((item) => !held.has(item.id))],
              total: loaded.total,
            };
          });
        },
        (failure: unknown) => {
          if (reading.current === mine) setError(errorMessage(failure));
        },
      )
      .finally(() => setBusy(false));
  };

  const clear = async () => {
    reading.current += 1;
    setEnded(false);
    setPage(await api.clearAiActivity());
  };

  return (
    <Dialog title="AI assistant: activity log" onClose={onClose} testId="ai-log" wide>
      <p className="hint" data-testid="ai-log-hint">
        Every call an AI made in a session: what it asked, and which records it was given. The log
        never holds the text of a record as a service gave it. It does hold the words an AI asked
        with: the names it asked a service for, and what it searched your tree for. An entry goes
        after {logDays} days.
      </p>
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {page === null && error === null && <p className="muted">Loading…</p>}
      {page !== null && page.items.length === 0 && (
        <p className="muted" data-testid="ai-log-empty">
          The log is empty.
        </p>
      )}
      {page !== null && page.items.length > 0 && (
        <>
          <ol className="ai-log-list" data-testid="ai-log-list">
            {page.items.map((item, index) => (
              <li
                key={item.id}
                // A little more room above the first entry of each session.
                className={
                  index > 0 && page.items[index - 1]?.sessionId !== item.sessionId
                    ? 'ai-log-first'
                    : undefined
                }
                data-testid="ai-log-entry"
              >
                <time dateTime={new Date(item.at).toISOString()}>{formatWhen(item.at)}</time>
                {item.what}
                {!item.thisTree && <span className="muted"> (another tree)</span>}
              </li>
            ))}
          </ol>
          {!ended && page.items.length < page.total && (
            <button type="button" onClick={more} disabled={busy} data-testid="ai-log-more">
              More
            </button>
          )}
        </>
      )}
      <div className="dialog-actions">
        {page !== null && page.items.length > 0 && (
          <button type="button" onClick={() => setAskClear(true)} data-testid="ai-log-clear">
            Clear the log
          </button>
        )}
        <button type="button" onClick={onClose} data-testid="ai-log-close">
          Close
        </button>
      </div>

      {askClear && (
        <ConfirmDialog
          title="Clear the activity log?"
          confirmLabel="Clear the log"
          onConfirm={clear}
          onClose={() => setAskClear(false)}
        >
          Remove every entry of the activity log? This cannot be undone.
        </ConfirmDialog>
      )}
    </Dialog>
  );
}
