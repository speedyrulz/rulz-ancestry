import { CITATION_LIMITS, SOURCE_LIMITS } from '@rulz/core';
import { useEffect, useId, useState } from 'react';
import type {
  CitationInfo,
  CitationInput,
  CitationTarget,
  PersonCitationInfo,
  SourceInput,
  SourceSummary,
  TreeState,
} from '../../../shared/ipc';
import { api, errorMessage } from '../api';
import { countOf } from '../format';
import { Dialog, FormDialog, SelectField, TextAreaField, TextField, useSubmit } from './ui';

/**
 * Sources and citations as the forms hold them, and the dialogs that say
 * which sources a fact rests on.
 *
 * A source is where information comes from. A citation is one place in a
 * source, with what it says there; it can support several facts.
 */

/** Shown where a source has neither a title nor a short title. */
export const UNTITLED_SOURCE = 'Untitled source';

export function sourceTitle(title: string): string {
  return title === '' ? UNTITLED_SOURCE : title;
}

/** Shown where a citation does not say where in the source it is. */
export const NO_PAGE = 'No place in the source given';

type QualityChoice = '' | '0' | '1' | '2' | '3';

const QUALITY_OPTIONS: readonly (readonly [QualityChoice, string])[] = [
  ['', 'Not stated'],
  ['3', 'Direct and primary evidence'],
  ['2', 'Secondary evidence'],
  ['1', 'Questionable'],
  ['0', 'Unreliable'],
];

/** How far a citation can be trusted, in words; null when it is not stated. */
export function qualityLabel(quality: number | null): string | null {
  if (quality === null) return null;
  return QUALITY_OPTIONS.find(([value]) => value === String(quality))?.[1] ?? null;
}

export interface SourceFieldsValue {
  title: string;
  author: string;
  publication: string;
  abbreviation: string;
  text: string;
}

export const EMPTY_SOURCE: SourceFieldsValue = {
  title: '',
  author: '',
  publication: '',
  abbreviation: '',
  text: '',
};

export function toSourceInput(value: SourceFieldsValue): SourceInput {
  return { ...value };
}

interface SourceFieldsProps {
  value: SourceFieldsValue;
  onChange: (value: SourceFieldsValue) => void;
  /** Also show the short title and the text of the source; a new source rarely needs them. */
  full?: boolean;
  autoFocus?: boolean;
}

/** The fields of a source. */
export function SourceFields({
  value,
  onChange,
  full = false,
  autoFocus = false,
}: SourceFieldsProps) {
  const set = (key: keyof SourceFieldsValue, next: string) => onChange({ ...value, [key]: next });
  return (
    <>
      <TextField
        label="Title"
        value={value.title}
        onChange={(next) => set('title', next)}
        maxLength={SOURCE_LIMITS.title}
        placeholder="e.g. 1900 United States Federal Census"
        testId="source-title"
        autoFocus={autoFocus}
      />
      <TextField
        label="Author, or who made it"
        value={value.author}
        onChange={(next) => set('author', next)}
        maxLength={SOURCE_LIMITS.author}
        testId="source-author"
      />
      <TextAreaField
        label="Published by, where and when; or where it is kept"
        value={value.publication}
        onChange={(next) => set('publication', next)}
        maxLength={SOURCE_LIMITS.publication}
        rows={2}
        testId="source-publication"
      />
      {full && (
        <>
          <TextField
            label="Short title"
            value={value.abbreviation}
            onChange={(next) => set('abbreviation', next)}
            maxLength={SOURCE_LIMITS.abbreviation}
            testId="source-abbreviation"
          />
          <TextAreaField
            label="Text of the source"
            value={value.text}
            onChange={(next) => set('text', next)}
            maxLength={SOURCE_LIMITS.text}
            rows={4}
            testId="source-text"
          />
        </>
      )}
    </>
  );
}

export interface CitationFieldsValue {
  page: string;
  text: string;
  quality: QualityChoice;
  note: string;
}

export const EMPTY_CITATION: CitationFieldsValue = { page: '', text: '', quality: '', note: '' };

function fieldsOf(citation: CitationInfo): CitationFieldsValue {
  const quality = citation.quality === null ? '' : String(citation.quality);
  return {
    page: citation.page,
    text: citation.text,
    quality: QUALITY_OPTIONS.some(([value]) => value === quality) ? (quality as QualityChoice) : '',
    note: citation.note,
  };
}

export function toCitationInput(value: CitationFieldsValue): CitationInput {
  return {
    page: value.page,
    text: value.text,
    quality: value.quality === '' ? null : Number(value.quality),
    note: value.note,
  };
}

interface CitationFieldsProps {
  value: CitationFieldsValue;
  onChange: (value: CitationFieldsValue) => void;
  autoFocus?: boolean;
}

/** The fields of a citation: where in the source, what it says, how far to trust it, and a note. */
export function CitationFields({ value, onChange, autoFocus = false }: CitationFieldsProps) {
  const set = <K extends keyof CitationFieldsValue>(key: K, next: CitationFieldsValue[K]) =>
    onChange({ ...value, [key]: next });
  return (
    <>
      <TextField
        label="Where in the source"
        value={value.page}
        onChange={(next) => set('page', next)}
        maxLength={CITATION_LIMITS.page}
        placeholder="e.g. page 12, entry 4; or sheet 4B, line 31"
        testId="citation-page"
        autoFocus={autoFocus}
      />
      <TextAreaField
        label="What it says there"
        value={value.text}
        onChange={(next) => set('text', next)}
        maxLength={CITATION_LIMITS.text}
        testId="citation-text"
      />
      <SelectField
        label="How far it can be trusted for this"
        value={value.quality}
        options={QUALITY_OPTIONS}
        onChange={(next) => set('quality', next)}
        testId="citation-quality"
      />
      <TextAreaField
        label="Your note"
        value={value.note}
        onChange={(next) => set('note', next)}
        maxLength={CITATION_LIMITS.note}
        rows={2}
        testId="citation-note"
      />
    </>
  );
}

interface CitationEditDialogProps {
  citation: CitationInfo;
  /** True when the citation supports more than one fact; the dialog then says so. */
  shared: boolean;
  /** Called with the tree's new state once the change is saved. */
  onTree: (tree: TreeState) => void;
  onClose: () => void;
}

/** Changes what a citation says. The change applies to every fact it supports. */
export function CitationEditDialog({ citation, shared, onTree, onClose }: CitationEditDialogProps) {
  const [value, setValue] = useState(() => fieldsOf(citation));
  return (
    <FormDialog
      title={`Citation of ${sourceTitle(citation.sourceTitle)}`}
      submitLabel="Save"
      onSubmit={async () => {
        onTree(await api.updateCitation(citation.id, toCitationInput(value)));
      }}
      onClose={onClose}
      testId="citation-dialog"
      wide
    >
      {shared && (
        <p className="hint" data-testid="citation-shared">
          This citation supports more than one fact. A change here applies to all of them.
        </p>
      )}
      <CitationFields value={value} onChange={setValue} autoFocus />
    </FormDialog>
  );
}

interface CitationTextProps {
  citation: CitationInfo;
}

/** What a citation says, for a list: the place in the source, then the words, the trust and the note. */
export function CitationText({ citation }: CitationTextProps) {
  const quality = qualityLabel(citation.quality);
  return (
    <>
      <span className={citation.page === '' ? 'muted' : undefined} data-testid="citation-where">
        {citation.page === '' ? NO_PAGE : citation.page}
      </span>
      {citation.text !== '' && <span className="citation-quote">“{citation.text}”</span>}
      {quality !== null && <span className="badge">{quality}</span>}
      {citation.note !== '' && <span className="citation-note">Note: {citation.note}</span>}
    </>
  );
}

interface AddCitationFormProps {
  target: CitationTarget;
  /** Whether the tree has any source yet; without one there is nothing to choose from. */
  anySource: boolean;
  /** The citations on this person's page that do not support this fact yet. */
  others: PersonCitationInfo[];
  onTree: (tree: TreeState) => void;
  /** Called when the citation was added, or the form was cancelled. */
  onDone: () => void;
}

/** Cites a source for a fact: an existing source or a new one, and where in it. */
function AddCitationForm({ target, anySource, others, onTree, onDone }: AddCitationFormProps) {
  const [mode, setMode] = useState<'existing' | 'new'>(anySource ? 'existing' : 'new');
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<{ query: string; sources: SourceSummary[] } | null>(null);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [source, setSource] = useState(EMPTY_SOURCE);
  /** A citation of the chosen source to use again, or null for a new one. */
  const [reuseId, setReuseId] = useState<string | null>(null);
  const [citation, setCitation] = useState(EMPTY_CITATION);
  const group = useId();

  useEffect(() => {
    if (mode !== 'existing') return;
    let cancelled = false;
    // Wait for a pause in typing before asking.
    const timer = setTimeout(() => {
      api.listSources({ query, offset: 0, limit: 25 }).then(
        (page) => {
          if (!cancelled) setFound({ query, sources: page.sources });
        },
        () => {
          if (!cancelled) setFound({ query, sources: [] });
        },
      );
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [mode, query]);

  // Only the answer to what is in the box now is shown; an older one could be clicked by mistake.
  const shown = found !== null && found.query === query ? found : null;
  const reusable =
    mode === 'existing' && sourceId !== null
      ? others.filter((other) => other.sourceId === sourceId)
      : [];
  const reuse = reusable.find((other) => other.id === reuseId) ?? null;
  const ready = mode === 'new' ? source.title.trim() !== '' : sourceId !== null;

  const { busy, error, submit } = useSubmit(async () => {
    if (reuse !== null) {
      onTree(await api.linkCitation(reuse.id, target));
    } else if (mode === 'new') {
      onTree(
        await api.addCitation(target, { create: toSourceInput(source) }, toCitationInput(citation)),
      );
    } else if (sourceId !== null) {
      onTree(await api.addCitation(target, { sourceId }, toCitationInput(citation)));
    }
  });

  return (
    <form
      noValidate
      data-testid="add-citation-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (busy || !ready) return;
        void submit().then((done) => {
          if (done) onDone();
        });
      }}
    >
      <div className="choice" role="radiogroup" aria-label="Which source">
        <label>
          <input
            type="radio"
            name={`${group}-mode`}
            checked={mode === 'existing'}
            disabled={!anySource}
            onChange={() => setMode('existing')}
            data-testid="citation-mode-existing"
          />
          A source already in this tree
        </label>
        <label>
          <input
            type="radio"
            name={`${group}-mode`}
            checked={mode === 'new'}
            onChange={() => setMode('new')}
            data-testid="citation-mode-new"
          />
          A new source
        </label>
      </div>

      {mode === 'new' ? (
        <SourceFields value={source} onChange={setSource} autoFocus />
      ) : (
        <>
          <TextField
            label="Find the source by title or author"
            value={query}
            onChange={(next) => {
              setQuery(next);
              setSourceId(null);
              setReuseId(null);
            }}
            testId="source-search"
            autoFocus
          />
          <ul className="pick-list" data-testid="source-results">
            {shown === null && <li className="muted">Looking…</li>}
            {shown !== null && shown.sources.length === 0 && (
              <li className="muted">No source found.</li>
            )}
            {shown?.sources.map((entry) => (
              <li key={entry.id}>
                <label data-testid="source-option">
                  <input
                    type="radio"
                    name={`${group}-source`}
                    checked={sourceId === entry.id}
                    onChange={() => {
                      setSourceId(entry.id);
                      setReuseId(null);
                    }}
                  />
                  <span>{sourceTitle(entry.title)}</span>
                  <span className="muted">{entry.author}</span>
                </label>
              </li>
            ))}
          </ul>
        </>
      )}

      {reusable.length > 0 && (
        <fieldset className="options" data-testid="citation-reuse">
          <legend>This source is already cited on this page</legend>
          {reusable.map((other) => (
            <label key={other.id}>
              <input
                type="radio"
                name={`${group}-reuse`}
                checked={reuseId === other.id}
                onChange={() => setReuseId(other.id)}
                data-testid="citation-reuse-option"
              />
              <span>
                Use the same citation: <strong>{other.page === '' ? NO_PAGE : other.page}</strong>
              </span>
            </label>
          ))}
          <label>
            <input
              type="radio"
              name={`${group}-reuse`}
              checked={reuse === null}
              onChange={() => setReuseId(null)}
              data-testid="citation-reuse-none"
            />
            <span>Another place in this source</span>
          </label>
        </fieldset>
      )}

      {reuse === null && <CitationFields value={citation} onChange={setCitation} />}

      {error !== null && (
        <p className="error" role="alert" data-testid="dialog-error">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <button type="button" onClick={onDone} disabled={busy} data-testid="citation-cancel">
          Cancel
        </button>
        <button
          type="submit"
          className="primary"
          disabled={busy || !ready}
          data-testid="citation-submit"
        >
          Add
        </button>
      </div>
    </form>
  );
}

interface FactSourcesDialogProps {
  /** What the sources are for, e.g. "Sources for the birth of John Hale". */
  title: string;
  target: CitationTarget;
  /** Every citation on the person's page; those that support `target` are listed. */
  citations: PersonCitationInfo[];
  tree: TreeState;
  onTree: (tree: TreeState) => void;
  onClose: () => void;
}

/** Lists the citations that support one fact, and adds, edits and removes them. */
export function FactSourcesDialog({
  title,
  target,
  citations,
  tree,
  onTree,
  onClose,
}: FactSourcesDialogProps) {
  const supports = (citation: PersonCitationInfo) =>
    citation.uses.some((use) => use.type === target.type && use.id === target.id);
  const own = citations.filter(supports);
  const others = citations.filter((citation) => !supports(citation));
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const editing = own.find((citation) => citation.id === editingId) ?? null;

  const remove = (citation: PersonCitationInfo) => {
    setProblem(null);
    api.unlinkCitation(citation.id, target).then(onTree, (failure: unknown) => {
      setProblem(errorMessage(failure));
    });
  };

  return (
    <Dialog title={title} onClose={onClose} testId="fact-sources-dialog" wide>
      {adding ? (
        <AddCitationForm
          target={target}
          anySource={tree.sources > 0}
          others={others}
          onTree={onTree}
          onDone={() => setAdding(false)}
        />
      ) : (
        <>
          {own.length === 0 ? (
            <p className="muted" data-testid="fact-sources-empty">
              No source is recorded for this yet.
            </p>
          ) : (
            <ul className="citation-list" data-testid="fact-sources-list">
              {own.map((citation) => (
                <li key={citation.id} data-testid="fact-source">
                  <div className="citation">
                    <strong data-testid="fact-source-title">
                      {sourceTitle(citation.sourceTitle)}
                    </strong>
                    <CitationText citation={citation} />
                    {citation.uses.length > 1 && (
                      <span className="muted">
                        Also supports{' '}
                        {countOf(citation.uses.length - 1, 'other fact', 'other facts')} on this
                        page.
                      </span>
                    )}
                  </div>
                  <div className="row-actions">
                    <button
                      type="button"
                      onClick={() => setEditingId(citation.id)}
                      data-testid="edit-citation"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => remove(citation)}
                      data-testid="remove-citation"
                    >
                      Remove
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {problem !== null && (
            <p className="error" role="alert" data-testid="dialog-error">
              {problem}
            </p>
          )}
          <div className="dialog-actions">
            <button type="button" onClick={() => setAdding(true)} data-testid="add-citation">
              Add a source
            </button>
            <button
              type="button"
              className="primary"
              onClick={onClose}
              data-testid="fact-sources-close"
            >
              Done
            </button>
          </div>
        </>
      )}
      {editing !== null && (
        <CitationEditDialog
          citation={editing}
          shared={editing.uses.length > 1}
          onTree={onTree}
          onClose={() => setEditingId(null)}
        />
      )}
    </Dialog>
  );
}
