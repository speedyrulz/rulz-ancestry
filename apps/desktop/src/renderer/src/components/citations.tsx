import { CITATION_LIMITS, SOURCE_LIMITS, webAddressProblem } from '@rulz/core';
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
import { MediaStrip } from './media';
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
  note: string;
}

export const EMPTY_SOURCE: SourceFieldsValue = {
  title: '',
  author: '',
  publication: '',
  abbreviation: '',
  text: '',
  note: '',
};

export function toSourceInput(value: SourceFieldsValue): SourceInput {
  return { ...value };
}

interface SourceFieldsProps {
  value: SourceFieldsValue;
  onChange: (value: SourceFieldsValue) => void;
  /** Also show the short title, the text of the source and the note; a new source rarely needs them. */
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
          <TextAreaField
            label="Note"
            value={value.note}
            onChange={(next) => set('note', next)}
            maxLength={SOURCE_LIMITS.note}
            rows={3}
            testId="source-note"
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
  url: string;
  /** `YYYY-MM-DD`, as a date field holds it; empty when not stated. */
  accessedAt: string;
}

export const EMPTY_CITATION: CitationFieldsValue = {
  page: '',
  text: '',
  quality: '',
  note: '',
  url: '',
  accessedAt: '',
};

/** Today on this PC's clock, as a date field holds it. */
export function today(): string {
  const now = new Date();
  const two = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
}

/** A day of a date field in words, e.g. "13 November 2026". */
function dayWords(day: string): string {
  const [year, month, date] = day.split('-').map(Number);
  if (year === undefined || month === undefined || date === undefined) return day;
  const at = new Date(year, month - 1, date);
  return Number.isNaN(at.getTime())
    ? day
    : at.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

/**
 * Why the address in a form cannot be saved; null when it can. An address
 * that came with an imported file and has not been changed is left as it is.
 */
function addressProblem(url: string, unchanged: string | undefined): string | null {
  return unchanged !== undefined && url.trim() === unchanged ? null : webAddressProblem(url);
}

function fieldsOf(citation: CitationInfo): CitationFieldsValue {
  const quality = citation.quality === null ? '' : String(citation.quality);
  return {
    page: citation.page,
    text: citation.text,
    quality: QUALITY_OPTIONS.some(([value]) => value === quality) ? (quality as QualityChoice) : '',
    note: citation.note,
    url: citation.url,
    accessedAt: citation.accessedAt,
  };
}

export function toCitationInput(value: CitationFieldsValue): CitationInput {
  return {
    page: value.page,
    text: value.text,
    quality: value.quality === '' ? null : Number(value.quality),
    note: value.note,
    url: value.url.trim(),
    accessedAt: value.accessedAt,
  };
}

interface CitationFieldsProps {
  value: CitationFieldsValue;
  onChange: (value: CitationFieldsValue) => void;
  autoFocus?: boolean;
  /** Put the web address first: the form is for a page of the web. */
  addressFirst?: boolean;
  /** The address the citation has now, which is not held against the rules for a new one. */
  unchangedUrl?: string;
}

/**
 * The fields of a citation: where in the source, what it says, how far to
 * trust it, a note, and for a page of the web its address and the day it was
 * looked at.
 */
export function CitationFields({
  value,
  onChange,
  autoFocus = false,
  addressFirst = false,
  unchangedUrl,
}: CitationFieldsProps) {
  const set = <K extends keyof CitationFieldsValue>(key: K, next: CitationFieldsValue[K]) =>
    onChange({ ...value, [key]: next });
  const dayId = useId();
  const problem = addressProblem(value.url, unchangedUrl);
  const address = (
    <>
      <TextField
        label={addressFirst ? 'Address of the page' : 'Web address, if it is a page on the web'}
        value={value.url}
        onChange={(next) => set('url', next)}
        maxLength={CITATION_LIMITS.url}
        placeholder="https://…"
        testId="citation-url"
        autoFocus={autoFocus && addressFirst}
        hint={
          problem !== null ? (
            <p className="error" data-testid="citation-url-problem">
              {problem}
            </p>
          ) : undefined
        }
      />
      <div className="field">
        <label htmlFor={dayId}>The day you looked at the page</label>
        <input
          id={dayId}
          type="date"
          value={value.accessedAt}
          min="0001-01-01"
          max="9999-12-31"
          data-testid="citation-accessed"
          onChange={(event) => set('accessedAt', event.target.value)}
        />
      </div>
    </>
  );
  return (
    <>
      {addressFirst && address}
      <TextField
        label="Where in the source"
        value={value.page}
        onChange={(next) => set('page', next)}
        maxLength={CITATION_LIMITS.page}
        placeholder={
          addressFirst
            ? 'e.g. the title of the page, or the number of the record'
            : 'e.g. page 12, entry 4; or sheet 4B, line 31'
        }
        testId="citation-page"
        autoFocus={autoFocus && !addressFirst}
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
      {!addressFirst && address}
    </>
  );
}

interface CitationEditDialogProps {
  citation: CitationInfo;
  /** True when the citation supports more than one fact; the dialog then says so. */
  shared: boolean;
  /** Goes up when the tree changes, so the citation's pictures are read again. */
  revision: number;
  /** Called with the tree's new state once the change is saved. */
  onTree: (tree: TreeState) => void;
  onClose: () => void;
}

/** Changes what a citation says. The change applies to every fact it supports. */
export function CitationEditDialog({
  citation,
  shared,
  revision,
  onTree,
  onClose,
}: CitationEditDialogProps) {
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
      before={
        // A scan of the place in the source the citation is about. It is added
        // and removed at once, not with the Save button of the form below.
        <MediaStrip
          target={{ type: 'citation', id: citation.id }}
          revision={revision}
          onTree={onTree}
          addLabel="Add a picture or a scan of it"
        />
      }
    >
      {shared && (
        <p className="hint" data-testid="citation-shared">
          This citation supports more than one fact. A change here applies to all of them.
        </p>
      )}
      <CitationFields value={value} onChange={setValue} autoFocus unchangedUrl={citation.url} />
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
      {(citation.url !== '' || citation.accessedAt !== '') && (
        <span className="citation-address" data-testid="citation-address">
          {/* Only an https address is opened; anything else is shown as text to copy. */}
          {/^https:\/\//i.test(citation.url) && webAddressProblem(citation.url) === null ? (
            <a href={citation.url} target="_blank" rel="noreferrer">
              {citation.url}
            </a>
          ) : (
            citation.url
          )}
          {citation.accessedAt !== '' && (
            <span className="muted"> Looked at on {dayWords(citation.accessedAt)}.</span>
          )}
        </span>
      )}
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
  /**
   * Set when the form is for a page of the web: the address comes first and
   * must be given. With a `site` the app knows, the tree's one source for
   * that site is offered first.
   */
  clip?: { site: { id: string; name: string } | null };
}

/** Cites a source for a fact: an existing source or a new one, and where in it. */
function AddCitationForm({
  target,
  anySource,
  others,
  onTree,
  onDone,
  clip,
}: AddCitationFormProps) {
  const site = clip?.site ?? null;
  const [mode, setMode] = useState<'site' | 'existing' | 'new'>(
    site !== null ? 'site' : anySource ? 'existing' : 'new',
  );
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<{ query: string; sources: SourceSummary[] } | null>(null);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [source, setSource] = useState(EMPTY_SOURCE);
  /** A citation of the chosen source to use again, or null for a new one. */
  const [reuseId, setReuseId] = useState<string | null>(null);
  const [citation, setCitation] = useState<CitationFieldsValue>(() =>
    clip === undefined ? EMPTY_CITATION : { ...EMPTY_CITATION, accessedAt: today() },
  );
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
  const sourceReady =
    mode === 'site' ? true : mode === 'new' ? source.title.trim() !== '' : sourceId !== null;
  // A citation that is used again brings its own address.
  const addressReady =
    reuse !== null ||
    (webAddressProblem(citation.url) === null &&
      (clip === undefined || citation.url.trim() !== ''));
  const ready = sourceReady && addressReady;

  const { busy, error, submit } = useSubmit(async () => {
    if (reuse !== null) {
      onTree(await api.linkCitation(reuse.id, target));
    } else if (mode === 'site' && site !== null) {
      onTree(await api.addCitation(target, { siteId: site.id }, toCitationInput(citation)));
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
        {site !== null && (
          <label>
            <input
              type="radio"
              name={`${group}-mode`}
              checked={mode === 'site'}
              onChange={() => setMode('site')}
              data-testid="citation-mode-site"
            />
            {site.name}
          </label>
        )}
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

      {mode === 'site' ? (
        <p className="hint">
          Every page of {site?.name} you cite goes under one source in this tree, called{' '}
          {site?.name}.
        </p>
      ) : mode === 'new' ? (
        <SourceFields value={source} onChange={setSource} autoFocus={clip === undefined} />
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
            autoFocus={clip === undefined}
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

      {reuse === null && (
        <CitationFields
          value={citation}
          onChange={setCitation}
          addressFirst={clip !== undefined}
          autoFocus={clip !== undefined}
        />
      )}

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

interface ClipDialogProps {
  personId: string;
  /** The person's name, for the title. */
  name: string;
  /** The site the page is on, when it is one the app knows; null for any other. */
  site: { id: string; name: string } | null;
  /** Whether the tree has any source yet. */
  anySource: boolean;
  /** The citations on the person's page. */
  citations: PersonCitationInfo[];
  onTree: (tree: TreeState) => void;
  onClose: () => void;
}

/**
 * Makes a citation of a page the user found in their own browser: they paste
 * its address and say what it shows. The app does not open or read the page.
 * The citation is for the person as a whole; it can be used for single facts
 * afterwards.
 */
export function ClipDialog({
  personId,
  name,
  site,
  anySource,
  citations,
  onTree,
  onClose,
}: ClipDialogProps) {
  const target: CitationTarget = { type: 'person', id: personId };
  return (
    <Dialog title={`Cite a web page for ${name}`} onClose={onClose} testId="clip-dialog" wide>
      <p className="hint">
        Copy the address of the page from your browser and paste it here. The app does not open or
        read the page: it keeps the address, the day, and what you write below.
      </p>
      <AddCitationForm
        target={target}
        anySource={anySource}
        others={citations.filter(
          (citation) => !citation.uses.some((use) => use.type === 'person' && use.id === personId),
        )}
        onTree={onTree}
        onDone={onClose}
        clip={{ site }}
      />
    </Dialog>
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
                    <MediaStrip
                      target={{ type: 'citation', id: citation.id }}
                      revision={tree.revision}
                      onTree={onTree}
                      addLabel="Add a picture or a scan of it"
                    />
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
          revision={tree.revision}
          onTree={onTree}
          onClose={() => setEditingId(null)}
        />
      )}
    </Dialog>
  );
}
