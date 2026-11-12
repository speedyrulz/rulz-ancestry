import { useEffect, useState } from 'react';
import type { PersonSummary, RelationshipInfo } from '../../../shared/ipc';
import { api, errorMessage } from '../api';
import { fullName, lifespan } from '../format';
import { PersonPicker } from './PersonPicker';
import { Dialog } from './ui';

/** "a first cousin" becomes "First cousin". */
function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The relationship as one sentence: "Mary Hale is John Hale's second cousin." */
export function relationshipSentence(info: RelationshipInfo): string {
  const person = fullName(info.person);
  const other = fullName(info.other);
  if (info.kind === 'self') return `${other} and ${person} are the same person.`;
  if (info.kind === 'none' || info.term === '') {
    return `No relationship was found between ${other} and ${person}.`;
  }
  return `${other} is ${person}’s ${info.term}.`;
}

interface RelationshipDialogProps {
  person: PersonSummary;
  onClose: () => void;
  /** Called to show one of the people named in the answer. */
  onSelect: (personId: string) => void;
}

/** Asks who to compare a person with, and says how the two are related. */
export function RelationshipDialog({ person, onClose, onSelect }: RelationshipDialogProps) {
  const [other, setOther] = useState<PersonSummary | null>(null);
  const [answer, setAnswer] = useState<
    { otherId: string; info: RelationshipInfo } | { otherId: string; error: string } | null
  >(null);
  const otherId = other?.id ?? null;

  useEffect(() => {
    if (otherId === null) return;
    let cancelled = false;
    api.getRelationship(person.id, otherId).then(
      (info) => {
        if (!cancelled) setAnswer({ otherId, info });
      },
      (failure: unknown) => {
        if (!cancelled) setAnswer({ otherId, error: errorMessage(failure) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [person.id, otherId]);

  const current = answer !== null && answer.otherId === otherId ? answer : null;
  const show = (personId: string) => {
    onClose();
    onSelect(personId);
  };

  return (
    <Dialog
      title={`How is someone related to ${fullName(person)}?`}
      onClose={onClose}
      testId="relationship-dialog"
      wide
    >
      <PersonPicker
        label="Find the other person by name"
        excludeId={person.id}
        chosenId={otherId}
        onChoose={setOther}
      />

      <div className="relationship" aria-live="polite">
        {otherId === null && <p className="muted">Choose a person to see how they are related.</p>}
        {otherId !== null && current === null && <p className="muted">Working it out…</p>}
        {current !== null && 'error' in current && (
          <p className="error" role="alert">
            {current.error}
          </p>
        )}
        {current !== null && 'info' in current && (
          <>
            <p className="relationship-answer" data-testid="relationship-answer">
              {relationshipSentence(current.info)}
            </p>
            {current.info.kind === 'none' && (
              <p className="hint">
                The app looks for ancestors the two share, and for a link through one marriage or
                partnership. More distant links by marriage are not found.
              </p>
            )}
            {/* In a direct line the "shared ancestor" is one of the two people themselves. */}
            {current.info.path.length > 2 &&
              current.info.commonAncestors.length > 0 &&
              !current.info.commonAncestors.some(
                (ancestor) =>
                  ancestor.id === current.info.person.id || ancestor.id === current.info.other.id,
              ) && (
                <p data-testid="relationship-common">
                  {current.info.commonAncestors.length === 1
                    ? 'Shared ancestor: '
                    : 'Shared ancestors: '}
                  {current.info.commonAncestors.map((ancestor, index) => (
                    <span key={ancestor.id}>
                      {index > 0 && ' and '}
                      <button type="button" className="link" onClick={() => show(ancestor.id)}>
                        {fullName(ancestor)}
                      </button>
                    </span>
                  ))}
                </p>
              )}
            {current.info.via !== null && (
              <p data-testid="relationship-via">
                Through{' '}
                <button
                  type="button"
                  className="link"
                  onClick={() => show(current.info.via?.id ?? '')}
                >
                  {fullName(current.info.via)}
                </button>
                .
              </p>
            )}
            {current.info.path.length > 2 && (
              <ol className="relationship-path" data-testid="relationship-path">
                {current.info.path.map((step, index) => (
                  <li key={`${step.id}-${index}`}>
                    <button type="button" className="link" onClick={() => show(step.id)}>
                      {fullName(step)}
                    </button>
                    <span className="muted">{lifespan(step)}</span>
                  </li>
                ))}
              </ol>
            )}
            {current.info.others.length > 0 && (
              <p data-testid="relationship-others">
                They are also related in{' '}
                {current.info.others.length === 1 ? 'another way' : 'other ways'}:{' '}
                {current.info.others.map(capital).join('; ')}.
              </p>
            )}
          </>
        )}
      </div>

      <div className="dialog-actions">
        <button
          type="button"
          className="primary"
          onClick={onClose}
          data-testid="relationship-close"
        >
          Close
        </button>
      </div>
    </Dialog>
  );
}
