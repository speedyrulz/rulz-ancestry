import { useEffect, useState } from 'react';
import type {
  CitationUseInfo,
  SourceCitationInfo,
  SourceDetails,
  SourceListPage,
  TreeState,
} from '../../../shared/ipc';
import { api, errorMessage } from '../api';
import { countOf, fullName, labelOf } from '../format';
import {
  CitationEditDialog,
  CitationText,
  EMPTY_SOURCE,
  SourceFields,
  sourceTitle,
  toSourceInput,
  type SourceFieldsValue,
} from './citations';
import { ConfirmDialog, Dialog, FormDialog, TextField, useSubmit } from './ui';

/** The sources of a tree: the list, one source with its citations, and adding one. */

const LIST_LIMIT = 200;
const CITATION_PAGE = 50;

interface SourcesDialogProps {
  tree: TreeState;
  onTree: (tree: TreeState) => void;
  /** Called to show a person named under a citation; the dialog closes. */
  onSelect: (personId: string) => void;
  onClose: () => void;
}

/** Lists the tree's sources; choosing one shows it with everything that cites it. */
export function SourcesDialog({ tree, onTree, onSelect, onClose }: SourcesDialogProps) {
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  if (sourceId !== null) {
    return (
      <SourceDialog
        sourceId={sourceId}
        tree={tree}
        onTree={onTree}
        onSelect={onSelect}
        onBack={() => setSourceId(null)}
        onClose={onClose}
      />
    );
  }
  return (
    <>
      <SourceListDialog
        tree={tree}
        onOpen={setSourceId}
        onAdd={() => setAdding(true)}
        onClose={onClose}
      />
      {adding && (
        <AddSourceDialog
          onClose={() => setAdding(false)}
          onAdded={(next, id) => {
            onTree(next);
            setSourceId(id);
          }}
        />
      )}
    </>
  );
}

interface SourceListDialogProps {
  tree: TreeState;
  onOpen: (sourceId: string) => void;
  onAdd: () => void;
  onClose: () => void;
}

function SourceListDialog({ tree, onOpen, onAdd, onClose }: SourceListDialogProps) {
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<
    { key: string; page: SourceListPage } | { key: string; error: string } | null
  >(null);
  const key = `${query}|${tree.revision}`;

  useEffect(() => {
    let cancelled = false;
    // Wait for a pause in typing before asking.
    const timer = setTimeout(() => {
      api.listSources({ query, offset: 0, limit: LIST_LIMIT }).then(
        (page) => {
          if (!cancelled) setFound({ key, page });
        },
        (failure: unknown) => {
          if (!cancelled) setFound({ key, error: errorMessage(failure) });
        },
      );
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [key, query]);

  // Only the answer to what is in the box now is shown; an older one could be clicked by mistake.
  const shown = found !== null && found.key === key ? found : null;

  return (
    <Dialog title="Sources" onClose={onClose} testId="sources-dialog" wide>
      <p className="dialog-text">
        A source is where information comes from: a census, a register, a certificate, a book, a web
        page. Facts about people point at the sources they rest on.
      </p>
      <TextField
        label="Find a source by title or author"
        value={query}
        onChange={setQuery}
        testId="sources-search"
        autoFocus
      />
      <div className="scroll-box sources-box">
        {shown === null && <p className="muted pad">Looking…</p>}
        {shown !== null && 'error' in shown && (
          <p className="error" role="alert">
            {shown.error}
          </p>
        )}
        {shown !== null && 'page' in shown && shown.page.sources.length === 0 && (
          <p className="muted pad" data-testid="sources-empty">
            {query.trim() === ''
              ? 'This tree has no sources yet.'
              : 'No source has that in its title or author.'}
          </p>
        )}
        {shown !== null && 'page' in shown && shown.page.sources.length > 0 && (
          <table className="table" data-testid="sources-list">
            <thead>
              <tr>
                <th scope="col">Title</th>
                <th scope="col">Author</th>
                <th scope="col">Cited</th>
              </tr>
            </thead>
            <tbody>
              {shown.page.sources.map((source) => (
                <tr key={source.id} data-testid="source-row">
                  <td>
                    <button
                      type="button"
                      className="link"
                      onClick={() => onOpen(source.id)}
                      data-testid="open-source"
                    >
                      {sourceTitle(source.title)}
                    </button>
                  </td>
                  <td>{source.author}</td>
                  <td data-testid="source-cited">{countOf(source.citations, 'time', 'times')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {shown !== null && 'page' in shown && shown.page.total > shown.page.sources.length && (
        <p className="hint">
          The first {shown.page.sources.length.toLocaleString()} of{' '}
          {countOf(shown.page.total, 'source', 'sources')} are listed. Type part of a title to find
          another.
        </p>
      )}
      <div className="dialog-actions">
        <button type="button" onClick={onAdd} data-testid="add-source">
          Add a source
        </button>
        <button type="button" className="primary" onClick={onClose} data-testid="sources-close">
          Close
        </button>
      </div>
    </Dialog>
  );
}

interface AddSourceDialogProps {
  onAdded: (tree: TreeState, sourceId: string) => void;
  onClose: () => void;
}

function AddSourceDialog({ onAdded, onClose }: AddSourceDialogProps) {
  const [value, setValue] = useState(EMPTY_SOURCE);
  return (
    <FormDialog
      title="Add a source"
      submitLabel="Add source"
      onSubmit={async () => {
        const change = await api.createSource(toSourceInput(value));
        onAdded(change.tree, change.sourceId);
      }}
      onClose={onClose}
      testId="add-source-dialog"
      wide
    >
      <SourceFields value={value} onChange={setValue} full autoFocus />
    </FormDialog>
  );
}

/** "the birth of", "the name of", "the family of": what a citation supports, before the names. */
function wordingOf(use: CitationUseInfo): string {
  if (use.what === 'person') return '';
  if (use.what === 'name') return 'The name of ';
  if (use.what === 'family') return 'The family of ';
  return `${labelOf(use.what)} of `;
}

interface CitationUsesProps {
  citation: SourceCitationInfo;
  onSelect: (personId: string) => void;
}

function CitationUses({ citation, onSelect }: CitationUsesProps) {
  return (
    <ul className="plain uses" data-testid="citation-uses">
      {citation.uses.map((use) => (
        <li key={`${use.type}-${use.id}`}>
          {wordingOf(use)}
          {use.persons.length === 0 && <span className="muted">someone not named</span>}
          {use.persons.map((person, index) => (
            <span key={person.id}>
              {index > 0 && ' and '}
              <button
                type="button"
                className="link"
                onClick={() => onSelect(person.id)}
                data-testid="citation-person"
              >
                {fullName(person)}
              </button>
            </span>
          ))}
        </li>
      ))}
    </ul>
  );
}

interface SourceDialogProps {
  sourceId: string;
  tree: TreeState;
  onTree: (tree: TreeState) => void;
  onSelect: (personId: string) => void;
  onBack: () => void;
  onClose: () => void;
}

/** One source: its details, which can be edited, and every citation of it. */
function SourceDialog({ sourceId, tree, onTree, onSelect, onBack, onClose }: SourceDialogProps) {
  const [limit, setLimit] = useState(CITATION_PAGE);
  const key = `${sourceId}|${tree.revision}|${limit}`;
  const [loaded, setLoaded] = useState<
    { key: string; details: SourceDetails | null } | { key: string; error: string } | null
  >(null);
  /**
   * What has been typed over the stored details. It stays on screen after it
   * is saved, so the fields do not jump back for a moment while the source is
   * read again.
   */
  const [edits, setEdits] = useState<{ value: SourceFieldsValue; saved: boolean } | null>(null);
  const [open, setOpen] = useState<
    | { kind: 'delete' }
    | { kind: 'citation'; id: string }
    | { kind: 'delete-citation'; id: string }
    | null
  >(null);

  useEffect(() => {
    let cancelled = false;
    api.getSource(sourceId, { offset: 0, limit }).then(
      (details) => {
        if (!cancelled) setLoaded({ key, details });
      },
      (failure: unknown) => {
        if (!cancelled) setLoaded({ key, error: errorMessage(failure) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [key, sourceId, limit]);

  const details = loaded !== null && 'details' in loaded ? loaded.details : null;
  const stored: SourceFieldsValue | null = details
    ? {
        title: details.source.title,
        author: details.source.author,
        publication: details.source.publication,
        abbreviation: details.source.abbreviation,
        text: details.source.text,
      }
    : null;
  const value = edits?.value ?? stored ?? EMPTY_SOURCE;
  const unsaved = edits !== null && !edits.saved;

  const save = useSubmit(async () => {
    onTree(await api.updateSource(sourceId, toSourceInput(value)));
    setEdits({ value, saved: true });
  });

  if (loaded === null) {
    return (
      <Dialog title="Source" onClose={onClose} testId="source-dialog" wide>
        <p className="muted">Loading…</p>
      </Dialog>
    );
  }
  if ('error' in loaded || details === null) {
    return (
      <Dialog title="Source" onClose={onClose} testId="source-dialog" wide>
        <p className={'error' in loaded ? 'error' : 'muted'} data-testid="source-gone">
          {'error' in loaded ? loaded.error : 'This source is not in the tree any more.'}
        </p>
        <div className="dialog-actions">
          <button type="button" className="primary" onClick={onBack} data-testid="source-back">
            All sources
          </button>
        </div>
      </Dialog>
    );
  }

  const title = sourceTitle(
    details.source.title !== '' ? details.source.title : details.source.abbreviation,
  );
  const citation = (id: string) => details.citations.find((entry) => entry.id === id) ?? null;
  const editing = open?.kind === 'citation' ? citation(open.id) : null;
  const deleting = open?.kind === 'delete-citation' ? citation(open.id) : null;

  return (
    <Dialog title={title} onClose={onClose} testId="source-dialog" wide>
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (!save.busy && unsaved) void save.submit();
        }}
      >
        <SourceFields
          value={value}
          onChange={(next) => setEdits({ value: next, saved: false })}
          full
        />
        {save.error !== null && (
          <p className="error" role="alert" data-testid="dialog-error">
            {save.error}
          </p>
        )}
        <div className="actions">
          <button
            type="submit"
            className="primary"
            disabled={save.busy || !unsaved}
            data-testid="source-save"
          >
            Save changes
          </button>
          <button
            type="button"
            className="danger"
            onClick={() => setOpen({ kind: 'delete' })}
            data-testid="delete-source"
          >
            Delete source
          </button>
        </div>
      </form>

      <h3 data-testid="source-citation-count">
        {details.citationCount === 0
          ? 'Not cited yet'
          : `Cited ${countOf(details.citationCount, 'time', 'times')}`}
      </h3>
      {details.citationCount === 0 ? (
        <p className="hint">
          To cite this source, open a person and choose “Sources” beside the name or event it tells
          you about.
        </p>
      ) : (
        <div className="scroll-box">
          <table className="table" data-testid="source-citations">
            <thead>
              <tr>
                <th scope="col">Where in the source, and what it says</th>
                <th scope="col">Supports</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {details.citations.map((entry) => (
                <tr key={entry.id} data-testid="source-citation">
                  <td>
                    <div className="citation">
                      <CitationText citation={entry} />
                    </div>
                  </td>
                  <td>
                    <CitationUses
                      citation={entry}
                      onSelect={(personId) => {
                        onClose();
                        onSelect(personId);
                      }}
                    />
                  </td>
                  <td className="row-actions">
                    <button
                      type="button"
                      onClick={() => setOpen({ kind: 'citation', id: entry.id })}
                      data-testid="edit-citation"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => setOpen({ kind: 'delete-citation', id: entry.id })}
                      data-testid="delete-citation"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {details.citationCount > details.citations.length && (
        <div className="actions">
          <span className="muted">
            {details.citations.length.toLocaleString()} of {details.citationCount.toLocaleString()}{' '}
            shown.
          </span>
          <button
            type="button"
            onClick={() => setLimit(Math.min(limit + CITATION_PAGE, 200))}
            disabled={limit >= 200}
            data-testid="more-citations"
          >
            Show more
          </button>
        </div>
      )}

      {details.keptLines.length > 0 && (
        <details data-testid="source-kept">
          <summary>
            {countOf(details.keptLines.length, 'item', 'items')} from the imported file that the app
            has no fields for yet
          </summary>
          <p className="hint">
            These are kept exactly as they were written and go back into an export. They cannot be
            edited here yet.
          </p>
          {details.keptLines.map((lines, index) => (
            <pre key={index} className="kept-lines" data-testid="kept-lines">
              {lines}
            </pre>
          ))}
        </details>
      )}

      <div className="dialog-actions">
        <button type="button" onClick={onBack} data-testid="source-back">
          All sources
        </button>
        <button type="button" className="primary" onClick={onClose} data-testid="source-close">
          Close
        </button>
      </div>

      {editing !== null && (
        <CitationEditDialog
          citation={editing}
          shared={editing.uses.length > 1}
          onTree={onTree}
          onClose={() => setOpen(null)}
        />
      )}
      {deleting !== null && (
        <ConfirmDialog
          title="Delete this citation?"
          confirmLabel="Delete citation"
          onClose={() => setOpen(null)}
          onConfirm={async () => {
            onTree(await api.deleteCitation(deleting.id));
          }}
        >
          <p>
            It is taken away from{' '}
            {deleting.uses.length === 1
              ? 'the fact it supports'
              : `all ${deleting.uses.length.toLocaleString()} facts it supports`}
            . The source itself stays.
          </p>
          <p>You can bring it back with Undo.</p>
        </ConfirmDialog>
      )}
      {open?.kind === 'delete' && (
        <ConfirmDialog
          title={`Delete ${title}?`}
          confirmLabel="Delete source"
          onClose={() => setOpen(null)}
          onConfirm={async () => {
            onTree(await api.deleteSource(sourceId));
            onBack();
          }}
        >
          <p>
            {details.citationCount === 0
              ? 'Nothing cites this source.'
              : `${countOf(details.citationCount, 'citation', 'citations')} of this source ${
                  details.citationCount === 1 ? 'is' : 'are'
                } deleted with it, so the facts they support lose this source.`}
          </p>
          <p>You can bring it back with Undo.</p>
        </ConfirmDialog>
      )}
    </Dialog>
  );
}
