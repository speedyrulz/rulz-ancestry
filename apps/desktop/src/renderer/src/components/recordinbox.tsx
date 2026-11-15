import { useEffect, useRef, useState } from 'react';
import {
  RECORD_INBOX_MAX,
  type AiConfidence,
  type AiOpinionInfo,
  type AiProposalItem,
  type AiSessionState,
  type AiVerdict,
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
 *
 * A third list holds the proposals of the optional AI assistant: records a
 * session brought, with what the AI said of each. They are in the app's
 * memory only, and the main process checked every quote of the AI against the
 * record before it handed a proposal over (see `main/aisession.ts`).
 */

/** How many results are asked for at a time. */
const PAGE = 50;

type Tab = 'kept' | 'declined' | 'proposals';

const VERDICT_WORDS: Record<AiVerdict, string> = {
  fits: 'AI: fits',
  'may-fit': 'AI: may fit',
  'does-not-fit': 'AI: does not fit',
};

const CONFIDENCE_WORDS: Record<AiConfidence, string> = {
  high: 'it says it is sure',
  medium: 'it says it is fairly sure',
  low: 'it says it is unsure',
};

/**
 * What an AI said of a record: its verdict, how sure it says it is, and its
 * reasons, each with the words of the record it rests on. It is the AI's
 * opinion, shown apart from the app's own label, and proves nothing.
 */
function AiOpinion({ opinion }: { opinion: AiOpinionInfo }) {
  return (
    <>
      <span className="badge ai" data-testid="ai-verdict">
        {VERDICT_WORDS[opinion.verdict]}
      </span>
      <span className="muted"> {CONFIDENCE_WORDS[opinion.confidence]}</span>
      {opinion.reasons.length > 0 && (
        <ul className="ai-reasons" data-testid="ai-reasons">
          {opinion.reasons.map((reason, index) => (
            // Two reasons may read alike; their place in the list tells them apart.
            <li key={index} data-testid="ai-reason">
              <strong>{reason.side === 'for' ? 'For:' : 'Against:'}</strong> {reason.text}{' '}
              <span className="muted">
                “{reason.quote}” ({reason.field})
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** What tells one result of the list from another: a person has one mark of a result. */
const itemKey = (item: RecordInboxItem) => `${item.personId}\n${item.sourceId}\n${item.key}`;

interface EntryProps {
  item: RecordInboxItem;
  tab: Exclude<Tab, 'proposals'>;
  busy: boolean;
  onSelect: () => void;
  onCompare: () => void;
  onAttach: () => void;
  onDecline: () => void;
  onRemove: () => void;
}

/** When a result was read and kept, or turned down, as far as the tree's file says. */
function whenWords(item: RecordInboxItem, tab: Exclude<Tab, 'proposals'>): string {
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
      {tab === 'kept' && item.ai !== null && <AiOpinion opinion={item.ai} />}
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
      {tab === 'kept' && item.aiProblem !== '' && (
        <div className="record-fact muted" data-testid="inbox-ai-problem">
          {item.aiProblem}
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

/** What tells one proposal from another: the session it was made in, and the reference it gave. */
const proposalKey = (item: AiProposalItem) => `${item.sessionId}\n${item.ref}`;

interface ProposalEntryProps {
  item: AiProposalItem;
  busy: boolean;
  onSelect: () => void;
  onCompare: () => void;
  onKeep: () => void;
  onAttach: () => void;
  onDecline: () => void;
  onForget: () => void;
}

/** When the record was read, and when the AI proposed it. */
function proposalWhen(item: AiProposalItem): string {
  return [
    `As the source had it on ${formatWhen(item.readAt)}.`,
    item.ai.proposedAt === null ? '' : `Proposed on ${formatWhen(item.ai.proposedAt)}.`,
  ]
    .filter((part) => part !== '')
    .join(' ');
}

function ProposalEntry({
  item,
  busy,
  onSelect,
  onCompare,
  onKeep,
  onAttach,
  onDecline,
  onForget,
}: ProposalEntryProps) {
  const { record, fit } = item;
  return (
    <li data-testid="inbox-proposal">
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
      <AiOpinion opinion={item.ai} />
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
      <RecordLines record={record} />
      {item.dropped > 0 && (
        <div className="record-fact muted" data-testid="proposal-dropped">
          {item.dropped === 1
            ? '1 reason of the AI is not shown: the app did not find its quote in the record, or it said nothing beside the quote.'
            : `${item.dropped.toLocaleString()} reasons of the AI are not shown: the app did not find their quotes in the record, or they said nothing beside the quote.`}
        </div>
      )}
      <div className="record-fact muted" data-testid="inbox-when">
        {proposalWhen(item)}
      </div>
      {item.mayBeLiving && (
        <div className="record-fact muted" data-testid="inbox-living">
          As your tree has this person now, they may be living. The app does not search for them.
        </div>
      )}
      <div className="record-actions">
        {record.kind !== 'text' && (
          <button type="button" onClick={onCompare} data-testid="proposal-compare">
            Compare
          </button>
        )}{' '}
        {item.mark === 'kept' && item.keptAsProposed ? (
          <span className="badge" data-testid="proposal-kept">
            Kept for later
          </span>
        ) : item.mark === 'kept' ? (
          // The tree keeps this record already, as a search read it or as
          // another proposal had it: without what the AI says here.
          <>
            <span className="badge" data-testid="proposal-kept-otherwise">
              Kept for later, without these reasons
            </span>{' '}
            <button
              type="button"
              onClick={onKeep}
              disabled={busy}
              title="Keeps the record as it is shown here, with what the AI says of it, in the place of what is kept"
              data-testid="proposal-keep"
            >
              Keep with these reasons
            </button>
          </>
        ) : (
          <button type="button" onClick={onKeep} disabled={busy} data-testid="proposal-keep">
            Keep for later
          </button>
        )}{' '}
        {item.attached ? (
          <span className="badge" data-testid="proposal-attached">
            Attached as a source
          </span>
        ) : (
          <button type="button" onClick={onAttach} disabled={busy} data-testid="proposal-attach">
            Attach as a source
          </button>
        )}{' '}
        {item.mark === 'declined' ? (
          <span className="badge" data-testid="proposal-declined">
            Turned down
          </span>
        ) : (
          <button type="button" onClick={onDecline} disabled={busy} data-testid="proposal-decline">
            {declineWords(record)}
          </button>
        )}{' '}
        <button type="button" onClick={onForget} disabled={busy} data-testid="proposal-forget">
          Forget
        </button>
      </div>
    </li>
  );
}

interface RecordInboxDialogProps {
  tree: TreeState;
  /** The person whose page is open, to show only their results; null when none is. */
  personId: string | null;
  /** The session of the AI assistant and the count of its proposals; null until it is known. */
  ai: AiSessionState | null;
  /** Called with the session and the proposals as they stand after one was forgotten. */
  onAi: (state: AiSessionState) => void;
  /** The list the window opens at; what is kept, unless it says otherwise. */
  startAt?: 'kept' | 'proposals';
  onTree: (tree: TreeState) => void;
  /** Opens the page of a person. */
  onSelect: (personId: string) => void;
  onClose: () => void;
}

export function RecordInboxDialog({
  tree,
  personId,
  ai,
  onAi,
  startAt = 'kept',
  onTree,
  onSelect,
  onClose,
}: RecordInboxDialogProps) {
  const [tab, setTab] = useState<Tab>(startAt);
  /** Whether only the results of the person whose page is open are shown. */
  const [only, setOnly] = useState(false);
  const [page, setPage] = useState<{ items: RecordInboxItem[]; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Why what was asked for one result was not done. */
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** The kept result that is set beside its person; null when none is. */
  const [comparing, setComparing] = useState<RecordInboxItem | null>(null);
  /** The proposals of the AI assistant, as last read; null while they are read. */
  const [proposals, setProposals] = useState<AiProposalItem[] | null>(null);
  /** The proposal that is set beside its person; null when none is. */
  const [comparingProposal, setComparingProposal] = useState<AiProposalItem | null>(null);
  const filter = only ? personId : null;
  /** Counts the readings of the list, so that an answer to an older one is not shown. */
  const reading = useRef(0);
  /** How many results the list shows, so that reading it again shows as many. */
  const shown = useRef(PAGE);
  const proposalsRevision = ai?.proposalsRevision ?? 0;

  // Read again whenever the tree changes: after a result was attached,
  // turned down or removed here, and after facts were taken over. As many are
  // read as were shown, so that the list does not jump back to its start.
  useEffect(() => {
    if (tab === 'proposals') return undefined;
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

  // The proposals are held against the tree as it is now, so they are read
  // again when the tree changes, and when a session adds or forgets one. They
  // are few and in memory: the whole list comes in one answer.
  useEffect(() => {
    if (tab !== 'proposals') return undefined;
    let current = true;
    api.listAiProposals().then(
      (loaded) => {
        if (!current) return;
        setProposals(loaded);
        setError(null);
      },
      (failure: unknown) => {
        if (current) setError(errorMessage(failure));
      },
    );
    return () => {
      current = false;
    };
  }, [tab, tree.revision, proposalsRevision]);

  const more = () => {
    if (page === null || tab === 'proposals') return;
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

  /** The request that names a proposal's record, for keeping, attaching or turning it down. */
  const proposalRef = (item: AiProposalItem) => ({
    personId: item.personId,
    sourceId: item.sourceId,
    key: item.key,
    from: 'proposal' as const,
    proposal: { sessionId: item.sessionId, ref: item.ref },
  });

  const forget = (item: AiProposalItem) => {
    setBusy(true);
    setProblem(null);
    api
      .dismissAiProposal({ sessionId: item.sessionId, ref: item.ref })
      .then(onAi, (failure: unknown) => setProblem(errorMessage(failure)))
      .finally(() => setBusy(false));
  };

  const show = (next: Tab) => {
    setProblem(null);
    setPage(null);
    setProposals(null);
    shown.current = PAGE;
    setTab(next);
  };

  // Filtered here: the list of proposals is not paged, and the main process gives all of it.
  const shownProposals =
    proposals === null
      ? null
      : filter === null
        ? proposals
        : proposals.filter((item) => item.personId === filter);
  const loading = tab === 'proposals' ? shownProposals === null : page === null;

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
        {((ai?.proposals ?? 0) > 0 || tab === 'proposals') && (
          <button
            type="button"
            className="small"
            aria-pressed={tab === 'proposals'}
            onClick={() => show('proposals')}
            data-testid="inbox-tab-proposals"
          >
            Proposed by the AI ({(ai?.proposals ?? 0).toLocaleString()})
          </button>
        )}
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
          : tab === 'declined'
            ? 'Results you said are not of the person they were found for. A search for that person leaves them out. "Allow again" lets a later search show the result once more.'
            : "Records that an AI app you connected proposed for people of your tree, with what it said of each and the words of the record it rests on. The app found every quote in the record; whether a reason is right is for you to judge. Proposals are in the app's memory only, and are forgotten when the tree closes or the assistant is turned off. A record you keep for later takes what the AI said of it along into your tree; one you attach as a source is cited without it. Of sessions before the last one, the app holds the latest 1,000 proposals. Nothing is sent from here."}
      </p>
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {loading && error === null && <p className="muted">Loading…</p>}
      {tab === 'proposals' && shownProposals !== null && shownProposals.length === 0 && (
        <p className="muted" data-testid="inbox-empty">
          The AI has proposed nothing.
        </p>
      )}
      {tab === 'proposals' && shownProposals !== null && shownProposals.length > 0 && (
        <ol className="record-list inbox-list">
          {shownProposals.map((item) => (
            <ProposalEntry
              key={proposalKey(item)}
              item={item}
              busy={busy}
              onSelect={() => onSelect(item.personId)}
              onCompare={() => {
                setProblem(null);
                setComparingProposal(item);
              }}
              onKeep={() => act(api.keepRecord(proposalRef(item)))}
              onAttach={() =>
                act(
                  api
                    .attachRecord(proposalRef(item))
                    .then((result) => (result.ok ? { ok: true, tree: result.tree } : result)),
                )
              }
              onDecline={() => act(api.declineRecord(proposalRef(item)))}
              onForget={() => forget(item)}
            />
          ))}
        </ol>
      )}
      {tab !== 'proposals' && page !== null && page.items.length === 0 && (
        <p className="muted" data-testid="inbox-empty">
          {tab === 'kept'
            ? 'Nothing is kept. "Keep for later" on a result of a search puts it here.'
            : 'Nothing was turned down.'}
        </p>
      )}
      {tab !== 'proposals' && page !== null && page.items.length > 0 && (
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
      {comparingProposal !== null && (
        <RecordCompareDialog
          personId={comparingProposal.personId}
          name={comparingProposal.personName === '' ? NO_NAME : comparingProposal.personName}
          sourceId={comparingProposal.sourceId}
          recordKey={comparingProposal.key}
          from="proposal"
          proposal={{ sessionId: comparingProposal.sessionId, ref: comparingProposal.ref }}
          onTaken={(result) => onTree(result.tree)}
          onClose={() => setComparingProposal(null)}
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
