import { PEDIGREES, SEXES, describeDate, type Pedigree, type Sex } from '@rulz/core';
import { useEffect, useState } from 'react';
import type {
  EventInfo,
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
  fullName,
  labelOf,
  lifespan,
  type PersonFieldsValue,
} from '../format';
import { EventDialog, NameDialog, RelativeDialog } from './dialogs';
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
  | { kind: 'delete' };

interface PersonPageProps {
  personId: string;
  tree: TreeState;
  /** Called with the tree's new state after every edit. */
  onTree: (tree: TreeState) => void;
  /** Called to show another person, or nobody (null). */
  onSelect: (personId: string | null) => void;
  /** Called with a message when an edit made straight from the page fails. */
  onProblem: (message: string) => void;
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

interface EventRowsProps {
  events: EventInfo[];
  onEdit: (event: EventInfo) => void;
  onDelete: (event: EventInfo) => void;
}

function EventRows({ events, onEdit, onDelete }: EventRowsProps) {
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
export function PersonPageView({ personId, tree, onTree, onSelect, onProblem }: PersonPageProps) {
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

  return (
    <div className="person-page" data-testid="person-page">
      <header className="person-head">
        <div>
          <h2 data-testid="person-name">{name}</h2>
          <p className="muted" data-testid="person-lifespan">
            {lifespan(summary) || 'No birth or death recorded'}
          </p>
        </div>
        <button
          type="button"
          className="danger"
          onClick={() => setOpen({ kind: 'delete' })}
          data-testid="delete-person"
        >
          Delete person
        </button>
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
