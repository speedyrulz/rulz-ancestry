import { NAME_TYPES, NOTE_MAX, SEXES, type NameType } from '@rulz/core';
import { useEffect, useId, useState } from 'react';
import type {
  BackupInfo,
  EventInfo,
  EventInput,
  NameInput,
  PersonDraft,
  PersonNameInfo,
  PersonRef,
  PersonSummary,
  TreeState,
} from '../../../shared/ipc';
import { api, errorMessage } from '../api';
import {
  EMPTY_PERSON,
  FAMILY_EVENT_OPTIONS,
  NAME_TYPE_LABELS,
  PERSON_EVENT_OPTIONS,
  SEX_LABELS,
  countOf,
  formatSize,
  formatWhen,
  labelOf,
  lifespan,
  listName,
  toDraft,
  type PersonFieldsValue,
} from '../format';
import { DateField, Dialog, FormDialog, SelectField, TextAreaField, TextField } from './ui';

const SEX_OPTIONS = SEXES.map((sex) => [sex, SEX_LABELS[sex]] as const);
const NAME_TYPE_OPTIONS = NAME_TYPES.map((type) => [type, NAME_TYPE_LABELS[type]] as const);

interface PersonFieldsProps {
  value: PersonFieldsValue;
  onChange: (value: PersonFieldsValue) => void;
}

/** The fields for a new person: name, sex, birth and death. */
export function PersonFields({ value, onChange }: PersonFieldsProps) {
  const set = <K extends keyof PersonFieldsValue>(key: K, next: PersonFieldsValue[K]) =>
    onChange({ ...value, [key]: next });
  return (
    <div className="field-grid">
      <TextField
        label="Given names"
        value={value.given}
        onChange={(next) => set('given', next)}
        testId="person-given"
        autoFocus
      />
      <TextField
        label="Surname"
        value={value.surname}
        onChange={(next) => set('surname', next)}
        testId="person-surname"
      />
      <SelectField
        label="Sex"
        value={value.sex}
        options={SEX_OPTIONS}
        onChange={(next) => set('sex', next)}
        testId="person-sex"
      />
      <div />
      <DateField
        label="Birth date"
        value={value.birthDate}
        onChange={(next) => set('birthDate', next)}
        testId="person-birth-date"
      />
      <TextField
        label="Birth place"
        value={value.birthPlace}
        onChange={(next) => set('birthPlace', next)}
        testId="person-birth-place"
        maxLength={500}
      />
      <DateField
        label="Death date"
        value={value.deathDate}
        onChange={(next) => set('deathDate', next)}
        testId="person-death-date"
      />
      <TextField
        label="Death place"
        value={value.deathPlace}
        onChange={(next) => set('deathPlace', next)}
        testId="person-death-place"
        maxLength={500}
      />
    </div>
  );
}

interface AddPersonDialogProps {
  onSubmit: (draft: PersonDraft) => Promise<void>;
  onClose: () => void;
}

export function AddPersonDialog({ onSubmit, onClose }: AddPersonDialogProps) {
  const [value, setValue] = useState(EMPTY_PERSON);
  return (
    <FormDialog
      title="Add a person"
      submitLabel="Add person"
      onSubmit={() => onSubmit(toDraft(value))}
      onClose={onClose}
      testId="add-person-dialog"
      wide
    >
      <PersonFields value={value} onChange={setValue} />
    </FormDialog>
  );
}

interface RelativeDialogProps {
  title: string;
  submitLabel: string;
  /** The person the relative is being added to; they cannot be chosen as their own relative. */
  personId: string;
  /** What the new-person fields start with, e.g. the family surname for a child. */
  defaults?: Partial<PersonFieldsValue>;
  onSubmit: (ref: PersonRef) => Promise<void>;
  onClose: () => void;
}

/** Adds a relative: either a new person, or someone who is already in the tree. */
export function RelativeDialog({
  title,
  submitLabel,
  personId,
  defaults,
  onSubmit,
  onClose,
}: RelativeDialogProps) {
  const [mode, setMode] = useState<'new' | 'existing'>('new');
  const [value, setValue] = useState<PersonFieldsValue>({ ...EMPTY_PERSON, ...defaults });
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<{ query: string; persons: PersonSummary[] } | null>(null);
  const [chosenId, setChosenId] = useState<string | null>(null);
  const groupName = useId();

  useEffect(() => {
    if (mode !== 'existing') return;
    let cancelled = false;
    // Wait for a pause in typing before asking.
    const timer = setTimeout(() => {
      api.listPersons({ query, offset: 0, limit: 25 }).then(
        (page) => {
          if (cancelled) return;
          setFound({ query, persons: page.persons.filter((person) => person.id !== personId) });
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
  }, [mode, query, personId]);

  const submit = () => {
    if (mode === 'new') return onSubmit({ create: toDraft(value) });
    if (chosenId === null) return Promise.reject(new Error('Choose a person from the list'));
    return onSubmit({ existingId: chosenId });
  };

  return (
    <FormDialog
      title={title}
      submitLabel={submitLabel}
      onSubmit={submit}
      onClose={onClose}
      testId="relative-dialog"
      disabled={mode === 'existing' && chosenId === null}
      wide
    >
      <div className="choice" role="radiogroup" aria-label="Who to add">
        <label>
          <input
            type="radio"
            name={`${groupName}-mode`}
            checked={mode === 'new'}
            onChange={() => setMode('new')}
            data-testid="relative-mode-new"
          />
          A new person
        </label>
        <label>
          <input
            type="radio"
            name={`${groupName}-mode`}
            checked={mode === 'existing'}
            onChange={() => setMode('existing')}
            data-testid="relative-mode-existing"
          />
          Someone already in this tree
        </label>
      </div>

      {mode === 'new' ? (
        <PersonFields value={value} onChange={setValue} />
      ) : (
        <>
          <TextField
            label="Find the person by name"
            value={query}
            onChange={(next) => {
              setQuery(next);
              setChosenId(null);
            }}
            testId="relative-search"
            autoFocus
          />
          <ul className="pick-list" data-testid="relative-results">
            {found === null && <li className="muted">Looking…</li>}
            {found !== null && found.persons.length === 0 && (
              <li className="muted">
                {found.query.trim() === '' ? 'Nobody else is in the tree yet.' : 'Nobody found.'}
              </li>
            )}
            {found?.persons.map((person) => (
              <li key={person.id}>
                <label>
                  <input
                    type="radio"
                    name={`${groupName}-person`}
                    checked={chosenId === person.id}
                    onChange={() => setChosenId(person.id)}
                  />
                  <span>{listName(person)}</span>
                  <span className="muted">{lifespan(person)}</span>
                </label>
              </li>
            ))}
          </ul>
        </>
      )}
    </FormDialog>
  );
}

interface NameDialogProps {
  /** The name being edited; absent when a name is being added. */
  name?: PersonNameInfo;
  onSubmit: (input: NameInput & { primary?: boolean }) => Promise<void>;
  onClose: () => void;
}

function knownNameType(type: string | undefined): NameType {
  return (NAME_TYPES as readonly string[]).includes(type ?? '') ? (type as NameType) : 'birth';
}

export function NameDialog({ name, onSubmit, onClose }: NameDialogProps) {
  const [type, setType] = useState<NameType>(knownNameType(name?.type ?? 'married'));
  const [prefix, setPrefix] = useState(name?.prefix ?? '');
  const [given, setGiven] = useState(name?.given ?? '');
  const [nickname, setNickname] = useState(name?.nickname ?? '');
  const [surname, setSurname] = useState(name?.surname ?? '');
  const [suffix, setSuffix] = useState(name?.suffix ?? '');
  const [primary, setPrimary] = useState(false);
  const adding = name === undefined;

  const submit = () => {
    const parts = [prefix, given, nickname, surname, suffix];
    if (parts.every((part) => part.trim() === '')) {
      return Promise.reject(new Error('Fill in at least one part of the name'));
    }
    const input: NameInput = { type, prefix, given, nickname, surname, suffix };
    return onSubmit(adding && primary ? { ...input, primary: true } : input);
  };

  return (
    <FormDialog
      title={adding ? 'Add a name' : 'Edit name'}
      submitLabel={adding ? 'Add name' : 'Save name'}
      onSubmit={submit}
      onClose={onClose}
      testId="name-dialog"
      wide
    >
      <div className="field-grid">
        <SelectField
          label="Kind of name"
          value={type}
          options={NAME_TYPE_OPTIONS}
          onChange={setType}
          testId="name-type"
        />
        <TextField
          label="Title (before the name)"
          value={prefix}
          onChange={setPrefix}
          maxLength={100}
        />
        <TextField
          label="Given names"
          value={given}
          onChange={setGiven}
          testId="name-given"
          autoFocus
        />
        <TextField label="Surname" value={surname} onChange={setSurname} testId="name-surname" />
        <TextField label="Nickname" value={nickname} onChange={setNickname} maxLength={100} />
        <TextField
          label="Suffix (after the name)"
          value={suffix}
          onChange={setSuffix}
          maxLength={100}
        />
      </div>
      {adding && (
        <label className="check">
          <input
            type="checkbox"
            checked={primary}
            onChange={(event) => setPrimary(event.target.checked)}
            data-testid="name-primary"
          />
          Show this name for the person in lists and charts
        </label>
      )}
    </FormDialog>
  );
}

const OTHER_TYPE = '__other__';

interface EventDialogProps {
  /** Whether the event belongs to one person or to a couple; decides the types offered. */
  kind: 'person' | 'family';
  /** The event being edited; absent when an event is being added. */
  event?: EventInfo;
  onSubmit: (input: EventInput) => Promise<void>;
  onClose: () => void;
}

export function EventDialog({ kind, event, onSubmit, onClose }: EventDialogProps) {
  const known = kind === 'person' ? PERSON_EVENT_OPTIONS : FAMILY_EVENT_OPTIONS;
  const startsCustom = event !== undefined && !known.includes(event.type);
  const [choice, setChoice] = useState(
    startsCustom ? OTHER_TYPE : (event?.type ?? known[0] ?? OTHER_TYPE),
  );
  const [custom, setCustom] = useState(startsCustom ? event.type : '');
  const [date, setDate] = useState(event?.dateText ?? '');
  const [place, setPlace] = useState(event?.placeText ?? '');
  const [description, setDescription] = useState(event?.description ?? '');
  const [note, setNote] = useState(event?.note ?? '');
  const descriptionId = useId();
  const adding = event === undefined;

  const options = [
    ...known.map((type) => [type, labelOf(type)] as const),
    [OTHER_TYPE, 'Other…'] as const,
  ];

  const submit = () => {
    const type = choice === OTHER_TYPE ? custom.trim() : choice;
    if (type === '') return Promise.reject(new Error('Say what kind of event this is'));
    return onSubmit({ type, date, place, description, note });
  };

  return (
    <FormDialog
      title={adding ? 'Add an event' : 'Edit event'}
      submitLabel={adding ? 'Add event' : 'Save event'}
      onSubmit={submit}
      onClose={onClose}
      testId="event-dialog"
      wide
    >
      <div className="field-grid">
        <SelectField
          label="Event"
          value={choice}
          options={options}
          onChange={setChoice}
          testId="event-type"
        />
        {choice === OTHER_TYPE ? (
          <TextField
            label="Kind of event"
            value={custom}
            onChange={setCustom}
            testId="event-custom-type"
            maxLength={60}
          />
        ) : (
          <div />
        )}
        <DateField label="Date" value={date} onChange={setDate} testId="event-date" />
        <TextField
          label="Place"
          value={place}
          onChange={setPlace}
          testId="event-place"
          maxLength={500}
        />
      </div>
      <div className="field">
        <label htmlFor={descriptionId}>Details</label>
        <textarea
          id={descriptionId}
          rows={3}
          maxLength={5000}
          value={description}
          data-testid="event-description"
          onChange={(change) => setDescription(change.target.value)}
        />
      </div>
      <TextAreaField
        label="Note"
        value={note}
        onChange={setNote}
        maxLength={NOTE_MAX}
        testId="event-note"
      />
    </FormDialog>
  );
}

interface NoteDialogProps {
  /** For example "Note on Ann Lee". */
  title: string;
  note: string;
  onSubmit: (note: string) => Promise<void>;
  onClose: () => void;
}

/** Edits a note of any number of lines. */
export function NoteDialog({ title, note, onSubmit, onClose }: NoteDialogProps) {
  const [value, setValue] = useState(note);
  return (
    <FormDialog
      title={title}
      submitLabel="Save note"
      onSubmit={() => onSubmit(value)}
      onClose={onClose}
      testId="note-dialog"
      wide
    >
      <TextAreaField
        label="Note"
        value={value}
        onChange={setValue}
        rows={12}
        maxLength={NOTE_MAX}
        testId="note-text"
      />
    </FormDialog>
  );
}

interface BackupsDialogProps {
  tree: TreeState;
  /** Called with the tree's new state after a backup or a restore. */
  onTree: (tree: TreeState) => void;
  onClose: () => void;
}

/** Lists the open tree's backups, makes one on request, and restores one. */
export function BackupsDialog({ tree, onTree, onClose }: BackupsDialogProps) {
  const [backups, setBackups] = useState<BackupInfo[] | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [confirming, setConfirming] = useState<BackupInfo | null>(null);
  const [busy, setBusy] = useState(false);

  // Reload the list when the dialog opens and whenever the newest backup changes.
  useEffect(() => {
    let cancelled = false;
    api.listBackups().then(
      (list) => {
        if (!cancelled) setBackups(list);
      },
      (error: unknown) => {
        if (!cancelled) setMessage({ text: errorMessage(error), error: true });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [tree.lastBackupAt, tree.revision]);

  const run = async (action: () => Promise<string>) => {
    setBusy(true);
    setMessage(null);
    try {
      setMessage({ text: await action(), error: false });
    } catch (error) {
      setMessage({ text: errorMessage(error), error: true });
    } finally {
      setBusy(false);
    }
  };

  const backupNow = () =>
    run(async () => {
      const result = await api.backupNow();
      onTree(result.tree);
      return result.created
        ? 'Backup made.'
        : tree.undo === null && tree.redo === null && tree.persons === 0
          ? 'There is nothing to back up yet.'
          : 'The newest backup already holds the tree as it is now.';
    });

  const restore = (backup: BackupInfo) =>
    run(async () => {
      setConfirming(null);
      onTree(await api.restoreBackup(backup.name));
      return `The tree is now as it was on ${formatWhen(backup.at)}.`;
    });

  return (
    <Dialog title="Backups" onClose={onClose} testId="backups-dialog" wide>
      <p className="dialog-text">
        The app backs up this tree when you close it or quit, if anything has changed. It keeps the
        ten newest backups, and of older ones the last backup of each month for six months. They are
        in the “backups” folder inside the tree folder.
      </p>
      {tree.media > 0 && (
        <p className="dialog-text" data-testid="backups-media-note">
          A backup holds the people, events and sources of this tree. Its{' '}
          {countOf(tree.media, 'picture or document is a file', 'pictures and documents are files')}{' '}
          in the “media” folder beside it, and backups do not copy them. To keep them safe, copy the
          whole tree folder to another disk.
        </p>
      )}

      {message !== null && (
        <p
          className={message.error ? 'error' : 'notice'}
          role={message.error ? 'alert' : 'status'}
          data-testid="backups-message"
        >
          {message.text}
        </p>
      )}

      {confirming !== null ? (
        <div className="confirm-box" data-testid="restore-confirm">
          <p>
            Replace the tree with the backup from <strong>{formatWhen(confirming.at)}</strong>?
            Everything changed since then will be taken out. The tree as it is now is backed up
            first, so you can come back to it.
          </p>
          <div className="dialog-actions">
            <button type="button" onClick={() => setConfirming(null)} disabled={busy}>
              Cancel
            </button>
            <button
              type="button"
              className="danger"
              disabled={busy}
              data-testid="restore-confirm-button"
              onClick={() => void restore(confirming)}
            >
              Restore this backup
            </button>
          </div>
        </div>
      ) : (
        <>
          <table className="table" data-testid="backups-list">
            <thead>
              <tr>
                <th scope="col">Made</th>
                <th scope="col">Size</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {backups === null && (
                <tr>
                  <td colSpan={3} className="muted">
                    Loading…
                  </td>
                </tr>
              )}
              {backups?.length === 0 && (
                <tr>
                  <td colSpan={3} className="muted">
                    No backups yet.
                  </td>
                </tr>
              )}
              {backups?.map((backup) => (
                <tr key={backup.name} data-testid="backup-row">
                  <td>{formatWhen(backup.at)}</td>
                  <td>{formatSize(backup.size)}</td>
                  <td className="row-actions">
                    <button type="button" disabled={busy} onClick={() => setConfirming(backup)}>
                      Restore…
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="dialog-actions">
            <button type="button" disabled={busy} onClick={() => void api.showBackupsFolder()}>
              Open backups folder
            </button>
            <button
              type="button"
              disabled={busy}
              data-testid="backup-now"
              onClick={() => void backupNow()}
            >
              Back up now
            </button>
            <button type="button" className="primary" onClick={onClose} data-testid="backups-close">
              Done
            </button>
          </div>
        </>
      )}
    </Dialog>
  );
}
