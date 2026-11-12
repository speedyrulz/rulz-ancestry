import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type UIEvent } from 'react';
import type { PersonListPage, PersonSummary } from '../../../shared/ipc';
import { api, errorMessage } from '../api';
import { countOf, lifespan, listName } from '../format';

/** Rows fetched at a time while scrolling. */
const PAGE = 100;
/** The most rows the main process returns in one call. */
const MAX_PER_CALL = 500;

/** Fetches `count` rows from `offset`, in as many calls as that takes. */
async function fetchRows(query: string, offset: number, count: number): Promise<PersonListPage> {
  const persons: PersonSummary[] = [];
  let total = 0;
  while (persons.length < count) {
    const limit = Math.min(MAX_PER_CALL, count - persons.length);
    const page = await api.listPersons({ query, offset: offset + persons.length, limit });
    total = page.total;
    persons.push(...page.persons);
    if (page.persons.length < limit) break;
  }
  return { total, persons };
}

interface Loaded {
  /** The revision and query these rows were read for. */
  key: string;
  total: number;
  persons: PersonSummary[];
}

interface PersonListProps {
  /** Changes whenever the tree's contents change; the list then reloads. */
  revision: number;
  /** What is in the search box. The list is remounted when this changes. */
  query: string;
  selectedId: string | null;
  onSelect: (personId: string) => void;
}

/**
 * Everyone in the tree by surname, or the people a search found. Rows are
 * fetched a page at a time as the list is scrolled, so a tree of ten thousand
 * people opens as quickly as a tree of ten.
 */
export function PersonList({ revision, query, selectedId, onSelect }: PersonListProps) {
  const key = `${revision}|${query}`;
  const [list, setList] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** How many rows to bring back after a reload, so the scroll position survives an edit. */
  const shown = useRef(PAGE);
  const loadingMore = useRef(false);

  useEffect(() => {
    let cancelled = false;
    fetchRows(query, 0, shown.current).then(
      (page) => {
        if (cancelled) return;
        setList({ key, ...page });
        setError(null);
      },
      (failure: unknown) => {
        if (!cancelled) setError(errorMessage(failure));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [key, query]);

  const loadMore = useCallback(() => {
    if (!list || list.key !== key || loadingMore.current) return;
    if (list.persons.length >= list.total) return;
    loadingMore.current = true;
    fetchRows(query, list.persons.length, PAGE)
      .then(
        (page) => {
          setList((current) => {
            if (!current || current.key !== list.key) return current;
            const persons = [...current.persons, ...page.persons];
            shown.current = Math.max(PAGE, persons.length);
            return { key: current.key, total: page.total, persons };
          });
        },
        (failure: unknown) => setError(errorMessage(failure)),
      )
      .finally(() => {
        loadingMore.current = false;
      });
  }, [list, key, query]);

  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    const box = event.currentTarget;
    if (box.scrollTop + box.clientHeight >= box.scrollHeight - 400) loadMore();
  };

  /** Up and Down move between rows, as in any list. */
  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button.row')];
    const at = rows.findIndex((row) => row === document.activeElement);
    const next = rows[at + (event.key === 'ArrowDown' ? 1 : -1)];
    if (next) {
      event.preventDefault();
      next.focus();
    }
  };

  const searching = query.trim() !== '';
  const hasMore = list !== null && list.persons.length < list.total;

  return (
    <div className="person-list" onScroll={onScroll} data-testid="person-list">
      <p className="list-count" data-testid="person-count" aria-live="polite">
        {list === null
          ? 'Loading…'
          : searching
            ? `${list.total.toLocaleString()} found`
            : countOf(list.total, 'person', 'people')}
      </p>
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {list !== null && list.total === 0 && (
        <p className="muted list-empty" data-testid="person-list-empty">
          {searching
            ? 'Nobody in this tree has a name like that.'
            : 'Nobody is in this tree yet. Use “Add person” to begin.'}
        </p>
      )}
      <ul onKeyDown={onKeyDown}>
        {list?.persons.map((person) => (
          <li key={person.id}>
            <button
              type="button"
              className={person.id === selectedId ? 'row selected' : 'row'}
              aria-current={person.id === selectedId ? 'true' : undefined}
              onClick={() => onSelect(person.id)}
              data-testid="person-row"
            >
              <span className="row-name">{listName(person)}</span>
              <span className="row-life">{lifespan(person)}</span>
            </button>
          </li>
        ))}
      </ul>
      {hasMore && (
        <button type="button" className="more" onClick={loadMore} data-testid="person-list-more">
          Show more
        </button>
      )}
    </div>
  );
}
