import { PEDIGREES, SEXES, describeDate, type Pedigree, type Sex } from '@rulz/core';
import { useEffect, useState } from 'react';
import type {
  CitationTarget,
  EventInfo,
  MediaInfo,
  MediaTarget,
  MergeInfo,
  PersonChange,
  PersonNameInfo,
  PersonPage,
  PersonSummary,
  TreeState,
} from '../../../shared/ipc';
import { api, errorMessage } from '../api';
import {
  NAME_TYPE_LABELS,
  PEDIGREE_LABELS,
  SEX_LABELS,
  countOf,
  fullName,
  labelOf,
  lifespan,
  type PersonFieldsValue,
} from '../format';
import { CitationEditDialog, CitationText, FactSourcesDialog, sourceTitle } from './citations';
import { EventDialog, NameDialog, RelativeDialog } from './dialogs';
import { MergeDialog } from './duplicates';
import { FilesButton, PersonMediaSection, TargetMediaDialog } from './media';
import { RelationshipDialog } from './relationship';
import { ConfirmDialog, SelectField } from './ui';

const SEX_OPTIONS = SEXES.map((sex) => [sex, SEX_LABELS[sex]] as const);
const LIVING_OPTIONS = [
  ['unknown', 'Not stated'],
  ['yes', 'Living'],
  ['no', 'Deceased'],
] as const;
type LivingChoice = (typeof LIVING_OPTIONS)[number][0];

const ROLES: Readonly<Record<'parent' | 'child' | 'sibling', Readonly<Record<Sex, string>>>> = {
  parent: { M: 'Father', F: 'Mother', X: 'Parent', U: 'Parent' },
  child: { M: 'Son', F: 'Daughter', X: 'Child', U: 'Child' },
  sibling: { M: 'Brother', F: 'Sister', X: 'Sibling', U: 'Sibling' },
};

/** Which dialog is open over the page. */
type Open =
  | { kind: 'name'; name?: PersonNameInfo }
  | { kind: 'event'; event?: EventInfo }
  | { kind: 'family-event'; familyId: string; event?: EventInfo }
  | { kind: 'parent'; familyId?: string }
  | { kind: 'partner'; familyId?: string }
  | { kind: 'child'; familyId?: string; surname: string }
  | { kind: 'relationship' }
  | { kind: 'merge' }
  | { kind: 'delete' }
  | { kind: 'sources'; target: CitationTarget; title: string }
  | { kind: 'media'; target: MediaTarget; title: string }
  | { kind: 'citation'; citationId: string };

interface PersonPageProps {
  personId: string;
  tree: TreeState;
  /** Called with the tree's new state after every edit. */
  onTree: (tree: TreeState) => void;
  /** Called to show another person, or nobody (null). */
  onSelect: (personId: string | null) => void;
  /** Called with a message when an edit made straight from the page fails. */
  onProblem: (message: string) => void;
  /** Called to show a chart of this person's relatives. */
  onChart: () => void;
  /** Called after this person was merged with another record, with the name of the one left. */
  onMerged: (info: MergeInfo, name: string) => void;
}

interface PersonLinkProps {
  person: PersonSummary;
  onSelect: (personId: string) => void;
  role?: string;
}

function PersonLink({ person, onSelect, role }: PersonLinkProps) {
  return (
    <>
      {role !== undefined && <span className="role">{role}</span>}
      <button
        type="button"
        className="link"
        onClick={() => onSelect(person.id)}
        data-testid="person-link"
      >
        {fullName(person)}
      </button>
      <span className="muted">{lifespan(person)}</span>
    </>
  );
}

interface SourcesButtonProps {
  /** How many citations support the fact. */
  count: number;
  onClick: () => void;
  testId: string;
}

/** Opens the list of sources a fact rests on; its label says how many there are. */
function SourcesButton({ count, onClick, testId }: SourcesButtonProps) {
  return (
    <button
      type="button"
      title={count === 0 ? 'Record where this comes from' : 'See where this comes from'}
      onClick={onClick}
      data-testid={testId}
    >
      {count === 0 ? 'Sources' : `Sources (${count.toLocaleString()})`}
    </button>
  );
}

interface EventRowsProps {
  events: EventInfo[];
  /** How many citations support an event. */
  sourceCount: (eventId: string) => number;
  onSources: (event: EventInfo) => void;
  /** How many pictures and documents are attached to an event. */
  mediaCount: (eventId: string) => number;
  onMedia: (event: EventInfo) => void;
  onEdit: (event: EventInfo) => void;
  onDelete: (event: EventInfo) => void;
}

function EventRows({
  events,
  sourceCount,
  onSources,
  mediaCount,
  onMedia,
  onEdit,
  onDelete,
}: EventRowsProps) {
  return (
    <>
      {events.map((event) => {
        const reading =
          event.dateQualifier === null
            ? null
            : describeDate({
                qualifier: event.dateQualifier,
                calendar: event.dateCalendar,
                minJdn: event.dateMinJdn,
                maxJdn: event.dateMaxJdn,
              });
        return (
          <tr key={event.id} data-testid="event-row">
            <th scope="row">{labelOf(event.type)}</th>
            <td title={reading === null ? undefined : `Read as: ${reading}`}>
              {event.dateText}
              {event.dateText !== '' && reading === null && (
                <span className="muted"> (not read as a date)</span>
              )}
            </td>
            <td>{event.placeText}</td>
            <td>{event.description}</td>
            <td className="row-actions">
              <SourcesButton
                count={sourceCount(event.id)}
                onClick={() => onSources(event)}
                testId="event-sources"
              />
              <FilesButton
                count={mediaCount(event.id)}
                onClick={() => onMedia(event)}
                testId="event-media"
              />
              <button type="button" onClick={() => onEdit(event)} data-testid="edit-event">
                Edit
              </button>
              <button type="button" onClick={() => onDelete(event)} data-testid="delete-event">
                Delete
              </button>
            </td>
          </tr>
        );
      })}
    </>
  );
}

const EVENT_HEAD = (
  <thead>
    <tr>
      <th scope="col">Event</th>
      <th scope="col">Date</th>
      <th scope="col">Place</th>
      <th scope="col">Details</th>
      <th scope="col">
        <span className="visually-hidden">Actions</span>
      </th>
    </tr>
  </thead>
);

/** One person: their details, names, events, parents, partners and children, all editable. */
export function PersonPageView({
  personId,
  tree,
  onTree,
  onSelect,
  onProblem,
  onChart,
  onMerged,
}: PersonPageProps) {
  const key = `${personId}|${tree.revision}`;
  const [loaded, setLoaded] = useState<{
    key: string;
    personId: string;
    page: PersonPage | null;
  } | null>(null);
  const [open, setOpen] = useState<Open | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.getPersonPage(personId).then(
      (page) => {
        if (!cancelled) setLoaded({ key, personId, page });
      },
      (failure: unknown) => {
        if (!cancelled) onProblem(errorMessage(failure));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [key, personId, onProblem]);

  // While an edit is being read back, keep showing the page as it was.
  if (loaded === null || loaded.personId !== personId) {
    return (
      <div className="person-page" data-testid="person-page-loading">
        <p className="muted">Loading…</p>
      </div>
    );
  }
  const page = loaded.page;
  if (page === null) {
    return (
      <div className="person-page" data-testid="person-gone">
        <p className="muted">
          This person is not in the tree any more. Choose someone from the list.
        </p>
      </div>
    );
  }

  const { summary, person } = page;
  const name = fullName(summary);

  /** Applies an edit made in a dialog. Throws on failure, and the dialog shows why. */
  const apply = async (edit: Promise<TreeState | PersonChange>) => {
    const result = await edit;
    onTree('tree' in result ? result.tree : result);
  };
  /** Applies an edit made straight from the page, and reports a failure. */
  const direct = (edit: Promise<TreeState | PersonChange>) => {
    apply(edit).catch((failure: unknown) => onProblem(errorMessage(failure)));
  };

  const living: LivingChoice = person.living === null ? 'unknown' : person.living ? 'yes' : 'no';
  const soloFamily = page.partnerFamilies.find((family) => family.partner === null);
  const parentsFull =
    page.parentFamilies.length > 0 &&
    page.parentFamilies.every((family) => family.parents.length >= 2);
  const ownSurname = summary.name?.surname ?? '';
  /** The surname a child most likely takes: the father's, where one is known. */
  const childSurname = (partner: PersonSummary | null) =>
    person.sex !== 'M' && partner?.sex === 'M' ? (partner.name?.surname ?? ownSurname) : ownSurname;

  const relativeDefaults = (surname: string): Partial<PersonFieldsValue> =>
    surname === '' ? {} : { surname };

  /** How many citations support one fact of this page. */
  const sourceCount = (type: CitationTarget['type'], id: string): number =>
    page.citations.filter((citation) =>
      citation.uses.some((use) => use.type === type && use.id === id),
    ).length;
  const showSources = (target: CitationTarget, title: string) =>
    setOpen({ kind: 'sources', target, title });
  const eventSources = (event: EventInfo, of: string) =>
    showSources(
      { type: 'event', id: event.id },
      `Sources for the ${labelOf(event.type).toLowerCase()} of ${of}`,
    );
  /** "John Hale and Mary Stone", or the person alone when the partner is not known. */
  const couple = (partner: PersonSummary | null) =>
    partner ? `${name} and ${fullName(partner)}` : name;
  const familyEvents = page.partnerFamilies.flatMap((family) => family.events);
  /** What a citation supports, in a word or two. */
  const factLabel = (use: CitationTarget): string => {
    if (use.type === 'person') return 'This person in general';
    if (use.type === 'name') return 'Name';
    if (use.type === 'family') {
      const partner = page.partnerFamilies.find((family) => family.familyId === use.id)?.partner;
      return partner ? `Family with ${fullName(partner)}` : 'Family';
    }
    const event = [...page.events, ...familyEvents].find((entry) => entry.id === use.id);
    return event ? labelOf(event.type) : 'Event';
  };
  const editedCitation =
    open?.kind === 'citation'
      ? (page.citations.find((citation) => citation.id === open.citationId) ?? null)
      : null;

  /** How many pictures and documents are attached to one thing of this page. */
  const mediaCount = (type: MediaTarget['type'], id: string): number =>
    page.media.filter((media) => media.uses.some((use) => use.type === type && use.id === id))
      .length;
  const showMedia = (target: MediaTarget, title: string) =>
    setOpen({ kind: 'media', target, title });
  const eventMedia = (event: EventInfo, of: string) =>
    showMedia(
      { type: 'event', id: event.id },
      `Pictures and documents of the ${labelOf(event.type).toLowerCase()} of ${of}`,
    );
  /** What a file is attached to on this page, in a few words. */
  const mediaNote = (media: MediaInfo): string => {
    const uses = page.media.find((entry) => entry.id === media.id)?.uses ?? [];
    return uses
      .map((use) => {
        if (use.type === 'citation') {
          const citation = page.citations.find((entry) => entry.id === use.id);
          return `Source: ${sourceTitle(citation?.sourceTitle ?? '')}`;
        }
        // A file of the person as a whole needs no label; the page is theirs.
        if (use.type === 'person' || use.type === 'source') return '';
        return factLabel({ type: use.type, id: use.id });
      })
      .filter((label) => label !== '')
      .join(', ');
  };

  return (
    <div className="person-page" data-testid="person-page">
      <header className="person-head">
        <div>
          <h2 data-testid="person-name">{name}</h2>
          <p className="muted" data-testid="person-lifespan">
            {lifespan(summary) || 'No birth or death recorded'}
          </p>
        </div>
        <div className="person-actions">
          <button
            type="button"
            title="Draw this person's ancestors and descendants"
            onClick={onChart}
            data-testid="open-chart"
          >
            Chart
          </button>
          <button
            type="button"
            title="See how someone else in the tree is related to this person"
            onClick={() => setOpen({ kind: 'relationship' })}
            data-testid="open-relationship"
          >
            Relationship
          </button>
          <button
            type="button"
            title="Use this when the same person is in the tree twice"
            onClick={() => setOpen({ kind: 'merge' })}
            data-testid="open-merge"
          >
            Merge
          </button>
          <button
            type="button"
            className="danger"
            onClick={() => setOpen({ kind: 'delete' })}
            data-testid="delete-person"
          >
            Delete person
          </button>
        </div>
      </header>

      <section>
        <h3>Details</h3>
        <div className="field-grid narrow">
          <SelectField
            label="Sex"
            value={person.sex}
            options={SEX_OPTIONS}
            onChange={(sex) => direct(api.updatePerson(person.id, { sex }))}
            testId="detail-sex"
          />
          <SelectField
            label="Living or deceased"
            value={living}
            options={LIVING_OPTIONS}
            onChange={(choice) =>
              direct(
                api.updatePerson(person.id, {
                  living: choice === 'unknown' ? null : choice === 'yes',
                }),
              )
            }
            testId="detail-living"
          />
        </div>
      </section>

      <section data-testid="names-section">
        <h3>Names</h3>
        {page.names.length === 0 ? (
          <p className="muted">No name recorded.</p>
        ) : (
          <table className="table">
            <tbody>
              {page.names.map((entry) => (
                <tr key={entry.id} data-testid="name-row">
                  <th scope="row">{labelOf(entry.type, NAME_TYPE_LABELS)}</th>
                  <td>
                    {fullName({ name: entry })}
                    {entry.isPrimary && page.names.length > 1 && (
                      <span className="badge">Shown name</span>
                    )}
                  </td>
                  <td className="row-actions">
                    <SourcesButton
                      count={sourceCount('name', entry.id)}
                      onClick={() =>
                        showSources(
                          { type: 'name', id: entry.id },
                          `Sources for the name ${fullName({ name: entry })}`,
                        )
                      }
                      testId="name-sources"
                    />
                    {!entry.isPrimary && (
                      <button
                        type="button"
                        onClick={() => direct(api.setPrimaryName(entry.id))}
                        data-testid="make-primary"
                      >
                        Show this name
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setOpen({ kind: 'name', name: entry })}
                      data-testid="edit-name"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => direct(api.deleteName(entry.id))}
                      data-testid="delete-name"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="actions">
          <button type="button" onClick={() => setOpen({ kind: 'name' })} data-testid="add-name">
            Add a name
          </button>
        </div>
      </section>

      <section data-testid="events-section">
        <h3>Events</h3>
        {page.events.length === 0 ? (
          <p className="muted">No events recorded.</p>
        ) : (
          <table className="table">
            {EVENT_HEAD}
            <tbody>
              <EventRows
                events={page.events}
                sourceCount={(eventId) => sourceCount('event', eventId)}
                onSources={(event) => eventSources(event, name)}
                mediaCount={(eventId) => mediaCount('event', eventId)}
                onMedia={(event) => eventMedia(event, name)}
                onEdit={(event) => setOpen({ kind: 'event', event })}
                onDelete={(event) => direct(api.deleteEvent(event.id))}
              />
            </tbody>
          </table>
        )}
        <div className="actions">
          <button type="button" onClick={() => setOpen({ kind: 'event' })} data-testid="add-event">
            Add an event
          </button>
        </div>
      </section>

      <section data-testid="parents-section">
        <h3>Parents</h3>
        {page.parentFamilies.length === 0 && <p className="muted">No parents recorded.</p>}
        {page.parentFamilies.map((family) => (
          <div className="family" key={family.familyId} data-testid="parent-family">
            <ul className="people">
              {family.parents.length === 0 && <li className="muted">Parents not known</li>}
              {family.parents.map((parent) => (
                <li key={parent.id}>
                  <PersonLink person={parent} onSelect={onSelect} role={ROLES.parent[parent.sex]} />
                </li>
              ))}
              {family.siblings.map((sibling) => (
                <li key={sibling.id}>
                  <PersonLink
                    person={sibling}
                    onSelect={onSelect}
                    role={ROLES.sibling[sibling.sex]}
                  />
                </li>
              ))}
            </ul>
            <div className="actions">
              <label className="inline">
                Link to these parents
                <select
                  value={family.pedigree}
                  data-testid="pedigree"
                  onChange={(event) =>
                    direct(
                      api.setPedigree(family.familyId, person.id, event.target.value as Pedigree),
                    )
                  }
                >
                  {!(PEDIGREES as readonly string[]).includes(family.pedigree) && (
                    <option value={family.pedigree}>{labelOf(family.pedigree)}</option>
                  )}
                  {PEDIGREES.map((pedigree) => (
                    <option key={pedigree} value={pedigree}>
                      {PEDIGREE_LABELS[pedigree]}
                    </option>
                  ))}
                </select>
              </label>
              {family.parents.length < 2 && (
                <button
                  type="button"
                  onClick={() => setOpen({ kind: 'parent', familyId: family.familyId })}
                  data-testid="add-other-parent"
                >
                  {family.parents.length === 0 ? 'Add a parent' : 'Add the other parent'}
                </button>
              )}
              <button
                type="button"
                onClick={() => direct(api.removeChild(family.familyId, person.id))}
                data-testid="remove-from-parents"
              >
                Remove {name} from this family
              </button>
            </div>
          </div>
        ))}
        {(page.parentFamilies.length === 0 || parentsFull) && (
          <div className="actions">
            <button
              type="button"
              onClick={() => setOpen({ kind: 'parent' })}
              data-testid="add-parent"
            >
              {parentsFull ? 'Add another set of parents' : 'Add a parent'}
            </button>
          </div>
        )}
      </section>

      <section data-testid="partners-section">
        <h3>Partners and children</h3>
        {page.partnerFamilies.length === 0 && (
          <p className="muted">No partners or children recorded.</p>
        )}
        {page.partnerFamilies.map((family) => (
          <div className="family" key={family.familyId} data-testid="partner-family">
            <ul className="people">
              <li>
                {family.partner ? (
                  <PersonLink person={family.partner} onSelect={onSelect} role="Partner" />
                ) : (
                  <span className="muted">Partner not known</span>
                )}
              </li>
              {family.children.map((child) => (
                <li key={child.person.id} data-testid="child-row">
                  <PersonLink
                    person={child.person}
                    onSelect={onSelect}
                    role={ROLES.child[child.person.sex]}
                  />
                  {child.pedigree !== 'birth' && (
                    <span className="badge">{labelOf(child.pedigree, PEDIGREE_LABELS)}</span>
                  )}
                  <button
                    type="button"
                    className="small"
                    onClick={() => direct(api.removeChild(family.familyId, child.person.id))}
                    data-testid="remove-child"
                  >
                    Remove from family
                  </button>
                </li>
              ))}
            </ul>
            {family.events.length > 0 && (
              <table className="table">
                {EVENT_HEAD}
                <tbody>
                  <EventRows
                    events={family.events}
                    sourceCount={(eventId) => sourceCount('event', eventId)}
                    onSources={(event) => eventSources(event, couple(family.partner))}
                    mediaCount={(eventId) => mediaCount('event', eventId)}
                    onMedia={(event) => eventMedia(event, couple(family.partner))}
                    onEdit={(event) =>
                      setOpen({ kind: 'family-event', familyId: family.familyId, event })
                    }
                    onDelete={(event) => direct(api.deleteEvent(event.id))}
                  />
                </tbody>
              </table>
            )}
            <div className="actions">
              <button
                type="button"
                onClick={() =>
                  setOpen({
                    kind: 'child',
                    familyId: family.familyId,
                    surname: childSurname(family.partner),
                  })
                }
                data-testid="add-child-to-family"
              >
                Add a child
              </button>
              <button
                type="button"
                onClick={() => setOpen({ kind: 'family-event', familyId: family.familyId })}
                data-testid="add-family-event"
              >
                Add a marriage or other event
              </button>
              <SourcesButton
                count={sourceCount('family', family.familyId)}
                onClick={() =>
                  showSources(
                    { type: 'family', id: family.familyId },
                    `Sources for the family of ${couple(family.partner)}`,
                  )
                }
                testId="family-sources"
              />
              <FilesButton
                count={mediaCount('family', family.familyId)}
                onClick={() =>
                  showMedia(
                    { type: 'family', id: family.familyId },
                    `Pictures and documents of the family of ${couple(family.partner)}`,
                  )
                }
                testId="family-media"
              />
              {family.partner ? (
                <button
                  type="button"
                  onClick={() =>
                    direct(api.removePartner(family.familyId, family.partner?.id ?? ''))
                  }
                  data-testid="remove-partner"
                >
                  Remove partner from family
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setOpen({ kind: 'partner', familyId: family.familyId })}
                  data-testid="add-partner-to-family"
                >
                  Add the partner
                </button>
              )}
            </div>
          </div>
        ))}
        <div className="actions">
          <button
            type="button"
            onClick={() => setOpen({ kind: 'partner' })}
            data-testid="add-partner"
          >
            Add a partner
          </button>
          {soloFamily === undefined && (
            <button
              type="button"
              onClick={() => setOpen({ kind: 'child', surname: ownSurname })}
              data-testid="add-child"
            >
              {page.partnerFamilies.length === 0
                ? 'Add a child'
                : 'Add a child with a partner not known'}
            </button>
          )}
        </div>
      </section>

      <section data-testid="sources-section">
        <h3>Sources</h3>
        {page.citations.length === 0 ? (
          <p className="muted">
            No sources recorded. Use “Sources” beside a name or an event to say where it comes from.
          </p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Source</th>
                <th scope="col">Where in it, and what it says</th>
                <th scope="col">Supports</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {page.citations.map((citation) => (
                <tr key={citation.id} data-testid="person-citation">
                  <th scope="row">{sourceTitle(citation.sourceTitle)}</th>
                  <td>
                    <div className="citation">
                      <CitationText citation={citation} />
                    </div>
                  </td>
                  <td data-testid="person-citation-uses">
                    {citation.uses.map(factLabel).join(', ')}
                  </td>
                  <td className="row-actions">
                    <button
                      type="button"
                      onClick={() => setOpen({ kind: 'citation', citationId: citation.id })}
                      data-testid="edit-person-citation"
                    >
                      Edit
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="actions">
          <SourcesButton
            count={sourceCount('person', person.id)}
            onClick={() =>
              showSources({ type: 'person', id: person.id }, `Sources for ${name} in general`)
            }
            testId="person-sources"
          />
          <span className="muted">for {name} in general, not one name or event</span>
        </div>
      </section>

      <PersonMediaSection
        items={page.media}
        noteOf={mediaNote}
        personId={person.id}
        name={name}
        revision={tree.revision}
        onTree={onTree}
        onSelect={onSelect}
      />

      {page.keptLines.length > 0 && (
        <section data-testid="kept-section">
          <h3>Other details from the imported file</h3>
          <details>
            <summary data-testid="kept-summary">
              {countOf(page.keptLines.length, 'item', 'items')} that the app has no fields for yet
            </summary>
            <p className="hint">
              These are notes, pictures and other details from the file this person was imported
              from. The app keeps them exactly as they were written and puts them back when the tree
              is exported. They cannot be edited here yet.
            </p>
            {page.keptLines.map((lines, index) => (
              <pre key={index} className="kept-lines" data-testid="kept-lines">
                {lines}
              </pre>
            ))}
          </details>
        </section>
      )}

      {open?.kind === 'name' && (
        <NameDialog
          {...(open.name ? { name: open.name } : {})}
          onClose={() => setOpen(null)}
          onSubmit={(input) =>
            apply(open.name ? api.updateName(open.name.id, input) : api.addName(person.id, input))
          }
        />
      )}
      {open?.kind === 'event' && (
        <EventDialog
          kind="person"
          {...(open.event ? { event: open.event } : {})}
          onClose={() => setOpen(null)}
          onSubmit={(input) =>
            apply(
              open.event
                ? api.updateEvent(open.event.id, input)
                : api.addPersonEvent(person.id, input),
            )
          }
        />
      )}
      {open?.kind === 'family-event' && (
        <EventDialog
          kind="family"
          {...(open.event ? { event: open.event } : {})}
          onClose={() => setOpen(null)}
          onSubmit={(input) =>
            apply(
              open.event
                ? api.updateEvent(open.event.id, input)
                : api.addFamilyEvent(open.familyId, input),
            )
          }
        />
      )}
      {open?.kind === 'parent' && (
        <RelativeDialog
          title={`Add a parent of ${name}`}
          submitLabel="Add parent"
          personId={person.id}
          defaults={relativeDefaults(ownSurname)}
          onClose={() => setOpen(null)}
          onSubmit={(ref) =>
            apply(api.addParent(person.id, ref, open.familyId ? { familyId: open.familyId } : {}))
          }
        />
      )}
      {open?.kind === 'partner' && (
        <RelativeDialog
          title={`Add a partner of ${name}`}
          submitLabel="Add partner"
          personId={person.id}
          onClose={() => setOpen(null)}
          onSubmit={(ref) =>
            apply(api.addPartner(person.id, ref, open.familyId ? { familyId: open.familyId } : {}))
          }
        />
      )}
      {open?.kind === 'child' && (
        <RelativeDialog
          title={`Add a child of ${name}`}
          submitLabel="Add child"
          personId={person.id}
          defaults={relativeDefaults(open.surname)}
          onClose={() => setOpen(null)}
          onSubmit={(ref) =>
            apply(api.addChild(person.id, ref, open.familyId ? { familyId: open.familyId } : {}))
          }
        />
      )}
      {open?.kind === 'relationship' && (
        <RelationshipDialog person={summary} onClose={() => setOpen(null)} onSelect={onSelect} />
      )}
      {open?.kind === 'merge' && (
        <MergeDialog
          personId={person.id}
          revision={tree.revision}
          onMerged={onMerged}
          onClose={() => setOpen(null)}
        />
      )}
      {open?.kind === 'sources' && (
        <FactSourcesDialog
          title={open.title}
          target={open.target}
          citations={page.citations}
          tree={tree}
          onTree={onTree}
          onClose={() => setOpen(null)}
        />
      )}
      {editedCitation !== null && (
        <CitationEditDialog
          citation={editedCitation}
          shared={editedCitation.uses.length > 1}
          revision={tree.revision}
          onTree={onTree}
          onClose={() => setOpen(null)}
        />
      )}
      {open?.kind === 'media' && (
        <TargetMediaDialog
          title={open.title}
          target={open.target}
          revision={tree.revision}
          onTree={onTree}
          onSelect={(id) => {
            setOpen(null);
            onSelect(id);
          }}
          onClose={() => setOpen(null)}
        />
      )}
      {open?.kind === 'delete' && (
        <ConfirmDialog
          title={`Delete ${name}?`}
          confirmLabel="Delete person"
          onClose={() => setOpen(null)}
          onConfirm={async () => {
            await apply(api.deletePerson(person.id));
            onSelect(null);
          }}
        >
          <p>
            Their names, events and family links are deleted with them. Their relatives stay in the
            tree.
          </p>
          <p>You can bring them back with Undo.</p>
        </ConfirmDialog>
      )}
    </div>
  );
}
