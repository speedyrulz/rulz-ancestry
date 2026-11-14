import { useEffect, useRef, useState } from 'react';
import {
  RECORD_INBOX_MAX,
  type MarkRecordResult,
  type RecordInboxItem,
  type TreeState,
} from '../../../shared/ipc';
import { api, errorMessage } from '../api';
import { NO_NAME, countOf, formatWhen } from '../format';
import { RecordCompareDialog, fitWhy, fitWords } from './recordcompare';
import { RecordLines, declineWords } from './records';
import { Dialog } from './ui';

/**
 * The inbox: the results of searches for records that the user kept to look
 * at later, and those they turned down. Both are read from the tree's file by
 * the main process, which checks each kept record again before it hands it
 * over (see `main/keptrecord.ts`); this window shows them and names a result
 * by its source and key only.
 *
 * A kept result can be set beside its person, attached as a source, turned
 * down or removed. What is shown is the record as the source had it on the
 * day it was kept: nothing is asked of a source from here.
 */

/** How many results are asked for at a time. */
const PAGE = 50;

type Tab = 'kept' | 'declined';

/** What tells one result of the list from another: a person has one mark of a result. */
const itemKey = (item: RecordInboxItem) => `${item.personId}\n${item.sourceId}\n${item.key}`;

interface EntryProps {
  item: RecordInboxItem;
  tab: Tab;
  busy: boolean;
  onSelect: () => void;
  onCompare: () => void;
  onAttach: () => void;
  onDecline: () => void;
  onRemove: () => void;
}

/** When a result was read and kept, or turned down, as far as the tree's file says. */
function whenWords(item: RecordInboxItem, tab: Tab): string {
  if (tab === 'declined') {
    return item.markedAt === null ? '' : `Turned down on ${formatWhen(item.markedAt)}.`;
  }
  return [
    item.readAt === null ? '' : `As the source had it on ${formatWhen(item.readAt)}.`,
    item.markedAt === null ? '' : `Kept on ${formatWhen(item.markedAt)}.`,
  ]
    .filter((part) => part !== '')
    .join(' ');
}

function Entry({
  item,
  tab,
  busy,
  onSelect,
  onCompare,
  onAttach,
  onDecline,
  onRemove,
}: EntryProps) {
  const { record, fit } = item;
  return (
    <li data-testid="inbox-item">
      {item.url === '' ? (
        <span data-testid="inbox-title">{item.title}</span>
      ) : (
        <a href={item.url} target="_blank" rel="noreferrer" data-testid="inbox-title">
          {item.title}
        </a>
      )}
      {fit !== null && (
        <span className={`badge fit fit-${fit.band}`} data-testid="inbox-fit">
          {fitWords(fit)}
        </span>
      )}
      <div className="record-fact">
        For{' '}
        <button type="button" className="link" onClick={onSelect} data-testid="inbox-person">
          {item.personName === '' ? NO_NAME : item.personName}
        </button>
        <span className="muted">, at {item.sourceName}</span>
      </div>
      {fit !== null && fitWhy(fit) !== '' && (
        <div className="record-fact muted" data-testid="inbox-fit-why">
          {fitWhy(fit)}
        </div>
      )}
      {record !== null && <RecordLines record={record} />}
      {whenWords(item, tab) !== '' && (
        <div className="record-fact muted" data-testid="inbox-when">
          {whenWords(item, tab)}
        </div>
      )}
      {item.mayBeLiving && (
        <div className="record-fact muted" data-testid="inbox-living">
          As your tree has this person now, they may be living. The app does not search for them.
        </div>
      )}
      {item.problem !== '' && (
        <div className="record-fact error" data-testid="inbox-problem">
          {item.problem}
          {tab === 'kept' ? ' It can only be removed.' : ''}
        </div>
      )}
      <div className="record-actions">
        {tab === 'kept' ? (
          <>
            {record !== null && record.kind !== 'text' && (
              <button type="button" onClick={onCompare} data-testid="inbox-compare">
                Compare
              </button>
            )}{' '}
            {item.attached ? (
              <span className="badge" data-testid="inbox-attached">
                Attached as a source
              </span>
            ) : (
              item.canAttach && (
                <button type="button" onClick={onAttach} disabled={busy} data-testid="inbox-attach">
                  Attach as a source
                </button>
              )
            )}{' '}
            {item.canAttach && (
              <button type="button" onClick={onDecline} disabled={busy} data-testid="inbox-decline">
                {record === null ? 'Not about this person' : declineWords(record)}
              </button>
            )}{' '}
            <button type="button" onClick={onRemove} disabled={busy} data-testid="inbox-remove">
              Remove
            </button>
          </>
        ) : (
          <button type="button" onClick={onRemove} disabled={busy} data-testid="inbox-allow">
            Allow again
          </button>
        )}
      </div>
    </li>
  );
}

interface RecordInboxDialogProps {
  tree: TreeState;
  /** The person whose page is open, to show only their results; null when none is. */
  personId: string | null;
  onTree: (tree: TreeState) => void;
  /** Opens the page of a person. */
  onSelect: (personId: string) => void;
  onClose: () => void;
}

export function RecordInboxDialog({
  tree,
  personId,
  onTree,
  onSelect,
  onClose,
}: RecordInboxDialogProps) {
  const [tab, setTab] = useState<Tab>('kept');
  /** Whether only the results of the person whose page is open are shown. */
  const [only, setOnly] = useState(false);
  const [page, setPage] = useState<{ items: RecordInboxItem[]; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Why what was asked for one result was not done. */
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** The kept result that is set beside its person; null when none is. */
  const [comparing, setComparing] = useState<RecordInboxItem | null>(null);
  const filter = only ? personId : null;
  /** Counts the readings of the list, so that an answer to an older one is not shown. */
  const reading = useRef(0);
  /** How many results the list shows, so that reading it again shows as many. */
  const shown = useRef(PAGE);

  // Read again whenever the tree changes: after a result was attached,
  // turned down or removed here, and after facts were taken over. As many are
  // read as were shown, so that the list does not jump back to its start.
  useEffect(() => {
    let current = true;
    reading.current += 1;
    const limit = Math.min(RECORD_INBOX_MAX, Math.max(PAGE, shown.current));
    api.listRecordInbox({ state: tab, personId: filter, offset: 0, limit }).then(
      (loaded) => {
        if (!current) return;
        shown.current = loaded.items.length;
        setPage(loaded);
        setError(null);
      },
      (failure: unknown) => {
        if (current) setError(errorMessage(failure));
      },
    );
    return () => {
      current = false;
    };
  }, [tab, filter, tree.revision]);

  const more = () => {
    if (page === null) return;
    // More of the list as it was read last. Should the list be read again
    // before the answer comes (the tree changed, or another list is shown),
    // the answer is for a list that is no longer on screen, and is dropped.
    const mine = reading.current;
    setBusy(true);
    api
      .listRecordInbox({ state: tab, personId: filter, offset: page.items.length, limit: PAGE })
      .then(
        (loaded) => {
          if (reading.current !== mine) return;
          setPage((now) => {
            if (now === null) return now;
            const known = new Set(now.items.map(itemKey));
            const items = [
              ...now.items,
              ...loaded.items.filter((item) => !known.has(itemKey(item))),
            ];
            shown.current = items.length;
            return { items, total: loaded.total };
          });
        },
        (failure: unknown) => {
          if (reading.current === mine) setProblem(errorMessage(failure));
        },
      )
      .finally(() => setBusy(false));
  };

  /** Does something to one result, and shows the tree as it stands after. */
  const act = (call: Promise<MarkRecordResult>) => {
    setBusy(true);
    setProblem(null);
    call
      .then(
        (result) => {
          if (result.ok) onTree(result.tree);
          else setProblem(result.problem.message);
        },
        (failure: unknown) => setProblem(errorMessage(failure)),
      )
      .finally(() => setBusy(false));
  };

  const refOf = (item: RecordInboxItem) => ({
    personId: item.personId,
    sourceId: item.sourceId,
    key: item.key,
  });

  const show = (next: Tab) => {
    setProblem(null);
    setPage(null);
    shown.current = PAGE;
    setTab(next);
  };

  return (
    <Dialog title="Inbox: records kept for later" onClose={onClose} testId="record-inbox" wide>
      <div className="actions inbox-tabs">
        <button
          type="button"
          className="small"
          aria-pressed={tab === 'kept'}
          onClick={() => show('kept')}
          data-testid="inbox-tab-kept"
        >
          Kept for later
        </button>
        <button
          type="button"
          className="small"
          aria-pressed={tab === 'declined'}
          onClick={() => show('declined')}
          data-testid="inbox-tab-declined"
        >
          Turned down
        </button>
        {personId !== null && (
          <label>
            <input
              type="checkbox"
              checked={only}
              onChange={(event) => {
                setPage(null);
                shown.current = PAGE;
                setOnly(event.target.checked);
              }}
              data-testid="inbox-only"
            />{' '}
            Only for the person whose page is open
          </label>
        )}
      </div>
      <p className="hint" data-testid="inbox-hint">
        {tab === 'kept'
          ? 'Results of searches that you kept to look at later. Each is shown as its source had it on the day you kept it; the source may say something else by now. The labels hold a result against the person as your tree has them today. Nothing is sent from here.'
          : 'Results you said are not of the person they were found for. A search for that person leaves them out. "Allow again" lets a later search show the result once more.'}
      </p>
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {page === null && error === null && <p className="muted">Loading…</p>}
      {page !== null && page.items.length === 0 && (
        <p className="muted" data-testid="inbox-empty">
          {tab === 'kept'
            ? 'Nothing is kept. "Keep for later" on a result of a search puts it here.'
            : 'Nothing was turned down.'}
        </p>
      )}
      {page !== null && page.items.length > 0 && (
        <>
          <p className="muted" data-testid="inbox-count">
            {page.items.length < page.total
              ? `The latest ${page.items.length.toLocaleString()} of ${page.total.toLocaleString()} results.`
              : `${countOf(page.total, 'result', 'results')}.`}
          </p>
          <ol className="record-list inbox-list">
            {page.items.map((item) => (
              <Entry
                key={itemKey(item)}
                item={item}
                tab={tab}
                busy={busy}
                onSelect={() => onSelect(item.personId)}
                onCompare={() => {
                  setProblem(null);
                  setComparing(item);
                }}
                onAttach={() =>
                  act(
                    api.attachRecord({ ...refOf(item), from: 'inbox' }).then((result) =>
                      // What attaching answers has more in it than is needed here.
                      result.ok ? { ok: true, tree: result.tree } : result,
                    ),
                  )
                }
                onDecline={() => act(api.declineRecord({ ...refOf(item), from: 'inbox' }))}
                onRemove={() => act(api.unmarkRecord(refOf(item)))}
              />
            ))}
          </ol>
          {page.items.length < page.total && (
            <button type="button" onClick={more} disabled={busy} data-testid="inbox-more">
              More results
            </button>
          )}
        </>
      )}
      {problem !== null && (
        <p className="error" role="alert" data-testid="inbox-action-problem">
          {problem}
        </p>
      )}

      {comparing !== null && (
        <RecordCompareDialog
          personId={comparing.personId}
          name={comparing.personName === '' ? NO_NAME : comparing.personName}
          sourceId={comparing.sourceId}
          recordKey={comparing.key}
          from="inbox"
          onTaken={(result) => onTree(result.tree)}
          onClose={() => setComparing(null)}
        />
      )}

      <div className="dialog-actions">
        <button type="button" onClick={onClose} data-testid="record-inbox-close">
          Close
        </button>
      </div>
    </Dialog>
  );
}
