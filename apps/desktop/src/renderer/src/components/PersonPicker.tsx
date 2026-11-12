import { useEffect, useId, useState } from 'react';
import type { PersonSummary } from '../../../shared/ipc';
import { api } from '../api';
import { lifespan, listName } from '../format';
import { TextField } from './ui';

interface PersonPickerProps {
  label: string;
  /** Someone who cannot be chosen: the person the choice is being made for. */
  excludeId: string;
  chosenId: string | null;
  onChoose: (person: PersonSummary | null) => void;
}

/** A search box and the people it finds, of whom one can be chosen. */
export function PersonPicker({ label, excludeId, chosenId, onChoose }: PersonPickerProps) {
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<{ query: string; persons: PersonSummary[] } | null>(null);
  const groupName = useId();

  useEffect(() => {
    let cancelled = false;
    // Wait for a pause in typing before asking.
    const timer = setTimeout(() => {
      api.listPersons({ query, offset: 0, limit: 25 }).then(
        (page) => {
          if (cancelled) return;
          setFound({ query, persons: page.persons.filter((person) => person.id !== excludeId) });
        },
        () => {
          if (!cancelled) setFound({ query, persons: [] });
        },
      );
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, excludeId]);

  // Results for an earlier spelling are not offered: a click meant for the new
  // list could land on the old one.
  const shown = found !== null && found.query === query ? found : null;

  return (
    <>
      <TextField
        label={label}
        value={query}
        onChange={(next) => {
          setQuery(next);
          onChoose(null);
        }}
        testId="picker-search"
        autoFocus
      />
      <ul className="pick-list" data-testid="picker-results">
        {shown === null && <li className="muted">Looking…</li>}
        {shown !== null && shown.persons.length === 0 && (
          <li className="muted">
            {shown.query.trim() === '' ? 'Nobody else is in the tree yet.' : 'Nobody found.'}
          </li>
        )}
        {shown?.persons.map((person) => (
          <li key={person.id}>
            <label>
              <input
                type="radio"
                name={groupName}
                checked={chosenId === person.id}
                onChange={() => onChoose(person)}
                data-testid="picker-option"
              />
              <span>{listName(person)}</span>
              <span className="muted">{lifespan(person)}</span>
            </label>
          </li>
        ))}
      </ul>
    </>
  );
}
