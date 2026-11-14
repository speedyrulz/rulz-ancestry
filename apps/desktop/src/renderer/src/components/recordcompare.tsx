import {
  describeDate,
  parseDate,
  type DateRelation,
  type PlaceRelation,
  type Sex,
  type TakeType,
} from '@rulz/core';
import { useEffect, useState } from 'react';
import type {
  RecordComparison,
  RecordFactTarget,
  RecordFieldInfo,
  RecordFitInfo,
  TakeRecordFactsResult,
} from '../../../shared/ipc';
import { api, errorMessage } from '../api';
import { Dialog } from './ui';

/**
 * A result of a search set beside the person it was found for. The main
 * process works the comparison out (see `main/records.ts`); this window shows
 * it and lets the user tick what to take over. Nothing is ticked to begin
 * with, and nothing is written before the button is pressed. What is taken is
 * named by the type of an event and the event of the tree; the values are the
 * main process's own.
 */

/** A date of a record in the words the rest of the app uses for dates. */
export function dateWords(date: string): string {
  const parsed = parseDate(date);
  return (parsed === null ? null : describeDate(parsed)) ?? date;
}

/**
 * The words for how well a result fits. They say what agrees, not who a
 * record is of: that is for the user to judge. A result that scores low with
 * nothing against it has little to go by, which is not a conflict.
 */
export function fitWords(fit: RecordFitInfo): string {
  if (fit.band === 'strong') return 'Fits well';
  if (fit.band === 'possible') return 'May fit';
  if (fit.band === 'unlikely') return 'Does not fit';
  return fit.doubts.length === 0 ? 'Little to go by' : 'Some details conflict';
}

/** What agrees and what speaks against a fit, as one line; empty when there is neither. */
export function fitWhy(fit: RecordFitInfo): string {
  const parts = [
    fit.reasons.join('. '),
    fit.doubts.length === 0 ? '' : `Against it: ${fit.doubts.join('; ').toLowerCase()}`,
  ].filter((part) => part !== '');
  return parts.length === 0 ? '' : `${parts.join('. ')}.`;
}

const DATE_WORDS: Record<DateRelation, string> = {
  same: 'The same',
  'more-exact': 'The record is more exact',
  'closer-about': 'The record names closer days, but only about',
  'less-exact': 'Your tree is more exact',
  overlaps: 'They overlap in part',
  differs: 'They differ',
  unreadable: 'The date of your tree is not one the app can read',
  'record-only': 'Only the record has it',
  'tree-only': 'Only your tree has it',
  neither: '',
};

const PLACE_WORDS: Record<PlaceRelation, string> = {
  same: 'The same',
  fuller: 'The record says all your tree says, and more',
  shorter: 'Your tree says all the record says, and more',
  // The words alone do not tell "Ashford, VT" from another Ashford, so nothing is claimed.
  alike: 'They begin alike; the rest is written differently',
  'alike-less': 'They begin alike; the rest is written differently, and the record is the shorter',
  differs: 'They differ',
  'record-only': 'Only the record has it',
  'tree-only': 'Only your tree has it',
  neither: '',
};

const EVENT_WORDS: Record<TakeType, string> = {
  birth: 'birth',
  baptism: 'baptism',
  death: 'death',
  burial: 'burial',
};

function sexWords(sex: Sex | null): string {
  return sex === 'M' ? 'Male' : sex === 'F' ? 'Female' : sex === null ? '' : 'Not known';
}

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** What the user has ticked for one event. */
interface Choice {
  date: boolean;
  place: boolean;
  /** Cite the record for the event and change nothing. */
  cite: boolean;
}

const NO_CHOICE: Choice = { date: false, place: false, cite: false };

const choiceKey = (type: TakeType, eventId: string | null) => `${type}\n${eventId ?? ''}`;

function Said({ text }: { text: string }) {
  return text === '' ? <span className="muted">Nothing</span> : <>{text}</>;
}

interface FieldRowProps<Relation extends string> {
  label: string;
  field: RecordFieldInfo<Relation>;
  /** The words for how the two stand to each other. */
  stands: string;
  /** How a value is shown: a date in words, a place as it is. */
  show: (text: string) => string;
  ticked: boolean;
  busy: boolean;
  onTick: (ticked: boolean) => void;
  testId: string;
}

function FieldRow<Relation extends string>({
  label,
  field,
  stands,
  show,
  ticked,
  busy,
  onTick,
  testId,
}: FieldRowProps<Relation>) {
  return (
    <tr data-testid={testId}>
      <th scope="row">{label}</th>
      <td>
        <Said text={field.tree === '' ? '' : show(field.tree)} />
      </td>
      <td>
        <Said text={field.record === '' ? '' : show(field.record)} />
      </td>
      <td>
        <span data-testid="compare-stands">{stands}</span>
        {field.canTake && (
          <label className="compare-tick">
            <input
              type="checkbox"
              checked={ticked}
              disabled={busy}
              onChange={(event) => onTick(event.target.checked)}
              data-testid="compare-take"
            />{' '}
            {field.tree === '' ? 'Take it over' : 'Replace with what the record says'}
          </label>
        )}
      </td>
    </tr>
  );
}

interface TargetRowsProps {
  type: TakeType;
  target: RecordFactTarget;
  /** Which of how many events of this type the tree has; null when it has one or none. */
  position: { index: number; count: number } | null;
  choice: Choice;
  busy: boolean;
  onChoose: (patch: Partial<Choice>) => void;
}

/** What the record says of one event, beside one event of the tree. */
function TargetRows({ type, target, position, choice, busy, onChoose }: TargetRowsProps) {
  // A baptism may stand beside a christening of the tree, which keeps its own name.
  const word = target.eventType === type ? EVENT_WORDS[type] : target.eventType;
  const writes = choice.date || choice.place;
  const replaces =
    (choice.date && target.date.tree !== '') || (choice.place && target.place.tree !== '');
  const after = [
    choice.date ? target.date.record : target.date.tree,
    choice.place ? target.place.record : target.place.tree,
  ];
  return (
    <tbody data-testid={`compare-${type}`}>
      <tr>
        <th colSpan={4} scope="rowgroup" className="compare-group">
          {capital(EVENT_WORDS[type])}
          {target.eventType !== type && (
            <span className="muted" data-testid="compare-beside">
              , beside a {word} of your tree
            </span>
          )}
          {position !== null && (
            <span className="muted">
              , number {position.index + 1} of the {position.count} your tree has
            </span>
          )}
          {target.eventId === null && <span className="muted">: your tree has none</span>}
        </th>
      </tr>
      {/* A row that neither side says anything of is left out. */}
      {target.date.relation !== 'neither' && (
        <FieldRow
          label="Date"
          field={target.date}
          stands={DATE_WORDS[target.date.relation]}
          show={dateWords}
          ticked={choice.date}
          busy={busy}
          onTick={(date) => onChoose({ date })}
          testId={`compare-${type}-date`}
        />
      )}
      {target.place.relation !== 'neither' && (
        <FieldRow
          label="Place"
          field={target.place}
          stands={PLACE_WORDS[target.place.relation]}
          show={(text) => text}
          ticked={choice.place}
          busy={busy}
          onTick={(place) => onChoose({ place })}
          testId={`compare-${type}-place`}
        />
      )}
      {(target.cited || target.canCite || writes) && (
        <tr>
          <th scope="row">Source</th>
          <td colSpan={3} data-testid={`compare-${type}-cite`}>
            {target.cited && <>This {word} of your tree cites the record already.</>}
            {!target.cited && writes && (
              <>
                The {word} will read: {after[0] === '' ? '' : dateWords(after[0] ?? '')}
                {after[0] !== '' && after[1] !== '' && ', '}
                {after[1]}. The record will be cited for it.
              </>
            )}
            {!target.cited && !writes && target.canCite && (
              <label className="compare-tick">
                <input
                  type="checkbox"
                  checked={choice.cite}
                  disabled={busy}
                  onChange={(event) => onChoose({ cite: event.target.checked })}
                  data-testid="compare-cite"
                />{' '}
                Cite the record for this {word}, and change nothing
              </label>
            )}
            {replaces && target.otherCitations > 0 && (
              <div className="error" data-testid="compare-others">
                {target.otherCitations === 1
                  ? `One other source is cited for this ${word}. It may not say what the record says.`
                  : `${target.otherCitations} other sources are cited for this ${word}. They may not say what the record says.`}
              </div>
            )}
          </td>
        </tr>
      )}
    </tbody>
  );
}

interface RecordCompareDialogProps {
  personId: string;
  /** The person's name, for the title. */
  name: string;
  sourceId: string;
  /** The key of a result the search showed for this person. */
  recordKey: string;
  /** Called after facts were taken over, with the tree as it stands then. */
  onTaken: (result: Extract<TakeRecordFactsResult, { ok: true }>) => void;
  onClose: () => void;
}

export function RecordCompareDialog({
  personId,
  name,
  sourceId,
  recordKey,
  onTaken,
  onClose,
}: RecordCompareDialogProps) {
  const [comparison, setComparison] = useState<RecordComparison | null>(null);
  /** Why there is nothing to show. */
  const [error, setError] = useState<string | null>(null);
  /** Why what was ticked was not taken over. */
  const [problem, setProblem] = useState<string | null>(null);
  /** What the last press did: wrote dates or places, or only cited the record. */
  const [done, setDone] = useState<'taken' | 'cited' | null>(null);
  const [busy, setBusy] = useState(false);
  const [choices, setChoices] = useState<Record<string, Choice>>({});

  useEffect(() => {
    let current = true;
    api.compareRecord({ personId, sourceId, key: recordKey }).then(
      (result) => {
        if (!current) return;
        if (result.ok) setComparison(result.comparison);
        else setError(result.problem.message);
      },
      (failure: unknown) => {
        if (current) setError(errorMessage(failure));
      },
    );
    return () => {
      current = false;
    };
  }, [personId, sourceId, recordKey]);

  const choose = (type: TakeType, target: RecordFactTarget, patch: Partial<Choice>) => {
    setDone(null);
    setChoices((now) => {
      const key = choiceKey(type, target.eventId);
      const next: Record<string, Choice> = {};
      // A record of a birth is of one birth: ticking under one event of a type
      // takes the ticks from the others of that type.
      for (const [other, choice] of Object.entries(now)) {
        if (!other.startsWith(`${type}\n`) || other === key) next[other] = choice;
      }
      next[key] = { ...(now[key] ?? NO_CHOICE), ...patch };
      return next;
    });
  };

  const takes = (comparison?.facts ?? []).flatMap((fact) =>
    fact.targets.flatMap((target) => {
      const choice = choices[choiceKey(fact.type, target.eventId)] ?? NO_CHOICE;
      return choice.date || choice.place || choice.cite
        ? [{ type: fact.type, eventId: target.eventId, date: choice.date, place: choice.place }]
        : [];
    }),
  );
  const onOffer = (comparison?.facts ?? []).some((fact) =>
    fact.targets.some((target) => target.date.canTake || target.place.canTake || target.canCite),
  );

  const take = () => {
    if (comparison === null || takes.length === 0) return;
    const wrote = takes.some((entry) => entry.date || entry.place);
    setBusy(true);
    setProblem(null);
    setDone(null);
    api
      .takeRecordFacts({ personId, sourceId, key: recordKey, stamp: comparison.stamp, takes })
      .then(
        (result) => {
          // Whatever happened, the ticks were for the comparison as it was.
          setChoices({});
          if (result.comparison !== null) setComparison(result.comparison);
          if (!result.ok) {
            setProblem(result.problem.message);
            return;
          }
          setDone(wrote ? 'taken' : 'cited');
          onTaken(result);
        },
        (failure: unknown) => setProblem(errorMessage(failure)),
      )
      .finally(() => setBusy(false));
  };

  return (
    <Dialog title={`Compare a record with ${name}`} onClose={onClose} testId="record-compare" wide>
      {error !== null && (
        <p className="error" role="alert" data-testid="compare-error">
          {error}
        </p>
      )}
      {comparison === null && error === null && <p className="muted">Loading…</p>}
      {comparison !== null && (
        <>
          <p className="dialog-text">
            <a href={comparison.url} target="_blank" rel="noreferrer" data-testid="compare-link">
              {comparison.title}
            </a>
            <span className="muted"> at {comparison.sourceName}</span>
            {comparison.fit !== null && (
              <span className={`badge fit fit-${comparison.fit.band}`} data-testid="compare-fit">
                {fitWords(comparison.fit)}
              </span>
            )}
            {comparison.attached && (
              <span className="badge" data-testid="compare-attached">
                Attached as a source
              </span>
            )}
          </p>
          {comparison.fit !== null && fitWhy(comparison.fit) !== '' && (
            <p className="hint">{fitWhy(comparison.fit)}</p>
          )}
          {comparison.event !== null && (
            <p className="record-fact" data-testid="compare-event">
              {[
                comparison.event.role,
                [
                  comparison.event.event,
                  comparison.event.date === '' ? '' : dateWords(comparison.event.date),
                  comparison.event.place,
                ]
                  .filter((part) => part !== '')
                  .join(', '),
              ]
                .filter((part) => part !== '')
                .join(' in: ')}
              {comparison.event.held !== '' && (
                <span className="muted"> ({comparison.event.held})</span>
              )}
            </p>
          )}
          <p className="hint compare-note" data-testid="compare-hint">
            The app does not know whether this record is of {name}. It sets the two side by side;
            what to take over is for you to decide. Nothing is ticked, and nothing is written until
            you press the button.
          </p>
          <table className="table compare">
            <thead>
              <tr>
                <td />
                <th scope="col">Your tree</th>
                <th scope="col">The record</th>
                <th scope="col">How they stand</th>
              </tr>
            </thead>
            <tbody>
              <tr data-testid="compare-name">
                <th scope="row">Name</th>
                <td>
                  <Said text={comparison.names.join('; ')} />
                </td>
                <td>{comparison.title}</td>
                <td className="muted">For reading; a name is not taken over</td>
              </tr>
              {comparison.sex.record !== null && (
                <tr data-testid="compare-sex">
                  <th scope="row">Sex</th>
                  <td>{sexWords(comparison.sex.tree)}</td>
                  <td>{sexWords(comparison.sex.record)}</td>
                  <td>
                    {comparison.sex.tree === 'U' ? (
                      <span className="muted">Only the record has it; it is not taken over</span>
                    ) : comparison.sex.tree === comparison.sex.record ? (
                      'The same'
                    ) : (
                      'They differ'
                    )}
                  </td>
                </tr>
              )}
              {comparison.about !== '' && (
                <tr>
                  <th scope="row">About</th>
                  <td />
                  <td colSpan={2}>{comparison.about}</td>
                </tr>
              )}
            </tbody>
            {comparison.facts.map((fact) =>
              fact.targets.map((target, index) => (
                <TargetRows
                  key={choiceKey(fact.type, target.eventId)}
                  type={fact.type}
                  target={target}
                  position={fact.targets.length > 1 ? { index, count: fact.targets.length } : null}
                  choice={choices[choiceKey(fact.type, target.eventId)] ?? NO_CHOICE}
                  busy={busy}
                  onChoose={(patch) => choose(fact.type, target, patch)}
                />
              )),
            )}
          </table>
          {comparison.nothing !== '' && (
            <p className="dialog-text" data-testid="compare-nothing">
              {comparison.nothing}
            </p>
          )}
          {problem !== null && (
            <p className="error" role="alert" data-testid="compare-problem">
              {problem}
            </p>
          )}
          {done !== null && (
            <p className="notice" data-testid="compare-done">
              {done === 'taken'
                ? 'Taken over, and the record is cited as the source. Undo takes all of it back in one step.'
                : 'The record is cited as the source, and nothing else was changed. Undo takes it back in one step.'}
            </p>
          )}
        </>
      )}
      <div className="dialog-actions">
        <button type="button" onClick={onClose} data-testid="compare-close">
          Close
        </button>
        {comparison !== null && onOffer && (
          <button
            type="button"
            className="primary"
            disabled={busy || takes.length === 0}
            onClick={take}
            data-testid="compare-go"
          >
            Take over what is ticked
          </button>
        )}
      </div>
    </Dialog>
  );
}
