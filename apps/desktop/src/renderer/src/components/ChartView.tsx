import {
  FAN_MAX_GENERATIONS,
  layoutDescendants,
  layoutFan,
  layoutHourglass,
  layoutPedigree,
  type AncestorSlot,
  type BoxChart,
  type DescendantNode,
  type FanChart,
  type FanSegment,
} from '@rulz/core';
import { Maximize, Minus, Plus, Printer } from 'lucide-react';
import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import type { ChartInfo, PersonSummary } from '../../../shared/ipc';
import { api, errorMessage } from '../api';
import { NO_NAME, fullName, lifespan } from '../format';
import { ChartExportDialog } from './reports';
import { IconButton } from './ui';

export type ChartKind = 'pedigree' | 'descendants' | 'hourglass' | 'fan';

const KINDS: readonly (readonly [ChartKind, string, string])[] = [
  ['pedigree', 'Ancestors', 'The person on the left, their parents and grandparents to the right'],
  [
    'descendants',
    'Descendants',
    'The person on the left, their children and grandchildren to the right',
  ],
  ['hourglass', 'Hourglass', 'Ancestors to the right of the person and descendants to the left'],
  ['fan', 'Fan', 'Ancestors in rings above the person, the father’s side on the left'],
];

const ZOOMS = [0.4, 0.5, 0.65, 0.8, 1, 1.25, 1.5] as const;
const MIN_GENERATIONS = 2;
const MAX_GENERATIONS = 8;
const DEFAULT_GENERATIONS = 4;

interface ChartViewProps {
  personId: string;
  /** Goes up with every change to the tree, so the chart is read again. */
  revision: number;
  /** Called to put another person at the centre of the chart. */
  onSelect: (personId: string) => void;
  /** Called to show the details of the person at the centre. */
  onDetails: () => void;
  onProblem: (message: string) => void;
}

/** What is asked of the main process for each kind of chart. */
function requestFor(
  kind: ChartKind,
  generations: number,
): { ancestors: number; descendants: number } {
  const beyond = generations - 1;
  if (kind === 'descendants') return { ancestors: 0, descendants: beyond };
  if (kind === 'hourglass') return { ancestors: beyond, descendants: beyond };
  return {
    ancestors: kind === 'fan' ? Math.min(beyond, FAN_MAX_GENERATIONS) : beyond,
    descendants: 0,
  };
}

function shorten(text: string, chars: number): string {
  return text.length <= chars ? text : `${text.slice(0, Math.max(1, chars - 1)).trimEnd()}…`;
}

/** The lines of text for one place in the fan: as much of the name and years as fits. */
function fanLines(person: PersonSummary, segment: Pick<FanSegment, 'lines' | 'chars'>): string[] {
  const years = lifespan(person);
  const name = fullName(person);
  const given = [person.name?.given, person.name?.nickname ? `"${person.name.nickname}"` : '']
    .filter((part) => part !== undefined && part !== '')
    .join(' ');
  const surname = person.name?.surname ?? '';
  let lines: string[];
  if (segment.lines >= 3 && given !== '' && surname !== '' && name.length > segment.chars) {
    lines = [given, surname, years];
  } else if (segment.lines >= 2) {
    lines = [name, years];
  } else {
    lines = [name];
  }
  return lines.filter((line) => line !== '').map((line) => shorten(line, segment.chars));
}

/**
 * The name of a place in the fan for a screen reader: what is written there, which is
 * what a voice-control user says, and the whole name and years where the writing is cut short.
 */
function fanLabel(lines: readonly string[], person: PersonSummary): string {
  const written = lines.join(' ');
  const whole = [fullName(person), lifespan(person)].filter(Boolean).join(' ');
  return written === whole ? whole : `${written}: ${whole}`;
}

const FAN_LINE_HEIGHT = 15;

interface FanProps {
  layout: FanChart;
  persons: ReadonlyMap<string, PersonSummary>;
  root: PersonSummary | null;
  /** What the chart is called to a screen reader. */
  name: string;
  onPick: (personId: string) => void;
}

function Fan({ layout, persons, root, name, onPick }: FanProps) {
  const text = (lines: readonly string[]) =>
    lines.map((line, index) => (
      <Fragment key={index}>
        {/* A space with no width, so that the lines read as words apart to assistive technology. */}
        {index > 0 && <tspan className="fan-gap"> </tspan>}
        <tspan
          x={0}
          dy={index === 0 ? -((lines.length - 1) * FAN_LINE_HEIGHT) / 2 + 4 : FAN_LINE_HEIGHT}
          className={index === lines.length - 1 && lines.length > 1 ? 'fan-years' : undefined}
        >
          {line}
        </tspan>
      </Fragment>
    ));
  const rootLines = root
    ? fanLines(root, { lines: 3, chars: Math.floor((layout.rootRadius * 2 - 16) / 6.6) })
    : [];
  return (
    <svg
      className="fan"
      width={layout.width}
      height={layout.height}
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      role="group"
      aria-label={name}
    >
      {layout.segments.map((segment) => {
        const person = segment.personId === null ? null : (persons.get(segment.personId) ?? null);
        if (!person) {
          return <path key={segment.key} d={segment.d} className="fan-empty" />;
        }
        const lines = fanLines(person, segment);
        const label = fanLabel(lines, person);
        return (
          <g
            key={segment.key}
            className={`fan-segment sex-${person.sex}`}
            role="button"
            tabIndex={0}
            aria-label={label}
            data-testid="fan-segment"
            data-person={person.id}
            data-slot={segment.slot}
            onClick={() => onPick(person.id)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              onPick(person.id);
            }}
          >
            <title>{label}</title>
            <path d={segment.d} />
            <text
              transform={`translate(${segment.textX} ${segment.textY}) rotate(${segment.rotate})`}
              textAnchor="middle"
              aria-hidden="true"
            >
              {text(lines)}
              {segment.more && <tspan className="fan-years"> …</tspan>}
            </text>
          </g>
        );
      })}
      {root && (
        <g
          className={`fan-segment fan-root sex-${root.sex}`}
          role="button"
          tabIndex={0}
          aria-label={`${fanLabel(rootLines, root)}: show details`}
          data-testid="fan-root"
          data-person={root.id}
          onClick={() => onPick(root.id)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            onPick(root.id);
          }}
        >
          <circle cx={layout.centerX} cy={layout.centerY} r={layout.rootRadius} />
          <text
            transform={`translate(${layout.centerX} ${layout.centerY})`}
            textAnchor="middle"
            aria-hidden="true"
          >
            {text(rootLines)}
          </text>
        </g>
      )}
    </svg>
  );
}

interface BoxesProps {
  layout: BoxChart;
  persons: ReadonlyMap<string, PersonSummary>;
  onPick: (personId: string) => void;
}

const ROLE_HINTS = {
  root: 'Show details',
  ancestor: 'Put at the centre of the chart',
  descendant: 'Put at the centre of the chart',
  partner: 'Put at the centre of the chart',
} as const;

function Boxes({ layout, persons, onPick }: BoxesProps) {
  return (
    <>
      <svg
        className="chart-lines"
        width={layout.width}
        height={layout.height}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        aria-hidden="true"
      >
        {layout.lines.map((line) => (
          <path key={line.key} d={line.d} />
        ))}
      </svg>
      {layout.boxes.map((box) => {
        const person = persons.get(box.personId);
        const name = person ? fullName(person) : NO_NAME;
        const years = person ? lifespan(person) : '';
        return (
          <button
            key={box.key}
            type="button"
            className={`chart-box ${box.role} sex-${person?.sex ?? 'U'}`}
            style={{ left: box.x, top: box.y, width: layout.boxWidth, height: layout.boxHeight }}
            title={`${name}${years === '' ? '' : `, ${years}`}. ${ROLE_HINTS[box.role]}.`}
            data-testid="chart-box"
            data-person={box.personId}
            data-role={box.role}
            onClick={() => onPick(box.personId)}
          >
            <span className="chart-name">{name}</span>
            <span className="chart-years">
              {years}
              {box.more && (
                <span className="chart-more" title="The tree goes on beyond this chart">
                  {' '}
                  more…
                </span>
              )}
            </span>
          </button>
        );
      })}
    </>
  );
}

/** What a person is called in the outline: Father, Mother or Parent, by the sex recorded. */
function parentRole(person: PersonSummary): string {
  return person.sex === 'M' ? 'Father' : person.sex === 'F' ? 'Mother' : 'Parent';
}

interface OutlinePersonProps {
  person: PersonSummary;
  role?: string;
  root?: boolean;
  more?: boolean;
  onPick: (personId: string) => void;
}

/** One person in the outline: the name moves the chart to them, like their box does. */
function OutlinePerson({ person, role, root = false, more = false, onPick }: OutlinePersonProps) {
  const years = lifespan(person);
  return (
    <>
      {role !== undefined && <span className="outline-role">{role}: </span>}
      <button
        type="button"
        className="link"
        data-testid="outline-person"
        data-person={person.id}
        data-outline-root={root ? 'true' : undefined}
        onClick={() => onPick(person.id)}
      >
        {fullName(person)}
      </button>
      {years !== '' && <span className="muted"> {years}</span>}
      {more && <span className="muted"> (the tree goes on)</span>}
    </>
  );
}

interface OutlineListProps {
  persons: ReadonlyMap<string, PersonSummary>;
  onPick: (personId: string) => void;
}

/** The person, then their father and mother each with their own parents, as nested lists. */
function AncestorOutline({
  slots,
  persons,
  onPick,
}: OutlineListProps & { slots: readonly AncestorSlot[] }) {
  const bySlot = new Map(slots.map((entry) => [entry.slot, entry]));
  const item = (slot: number): ReactNode => {
    const entry = bySlot.get(slot);
    const person = entry === undefined ? undefined : persons.get(entry.personId);
    if (entry === undefined || person === undefined) return null;
    const parents = [slot * 2, slot * 2 + 1].filter((parent) => bySlot.has(parent));
    return (
      <li key={slot}>
        <OutlinePerson
          person={person}
          {...(slot === 1 ? { root: true } : { role: parentRole(person) })}
          more={entry.more}
          onPick={onPick}
        />
        {parents.length > 0 && <ul>{parents.map(item)}</ul>}
      </li>
    );
  };
  return <ul>{item(1)}</ul>;
}

/** The person, then each partner with the children of the two, and their own families below. */
function DescendantOutline({
  node,
  persons,
  onPick,
  root = false,
}: OutlineListProps & { node: DescendantNode; root?: boolean }) {
  const person = persons.get(node.personId);
  if (person === undefined) return null;
  const item = (child: DescendantNode, key: string) => (
    <DescendantOutline key={key} node={child} persons={persons} onPick={onPick} />
  );
  const body = (
    <>
      <OutlinePerson person={person} root={root} more={node.more} onPick={onPick} />
      {node.unions.length > 0 && (
        <ul>
          {node.unions.map((union, index) => {
            const partner = union.partnerId === null ? undefined : persons.get(union.partnerId);
            return (
              <li key={index}>
                {partner === undefined ? (
                  <span className="outline-role">Partner not known</span>
                ) : (
                  <OutlinePerson person={partner} role="Partner" onPick={onPick} />
                )}
                {union.children.length > 0 && (
                  <ul>{union.children.map((child, at) => item(child, `${index}-${at}`))}</ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
  return root ? (
    <ul>
      <li>{body}</li>
    </ul>
  ) : (
    <li>{body}</li>
  );
}

interface ChartOutlineProps {
  kind: ChartKind;
  data: ChartInfo;
  persons: ReadonlyMap<string, PersonSummary>;
  /** `list` says which list the name is in: an hourglass has two, each with the person at its head. */
  onPick: (personId: string, list: OutlineList) => void;
}

type OutlineList = 'ancestors' | 'descendants';

/** The chart as text: the same people as the drawing, as nested lists a screen reader can walk. */
function ChartOutline({ kind, data, persons, onPick }: ChartOutlineProps) {
  const ancestors = (
    <div data-outline-list="ancestors">
      <AncestorOutline
        slots={data.ancestors}
        persons={persons}
        onPick={(id) => onPick(id, 'ancestors')}
      />
    </div>
  );
  const descendants = (
    <div data-outline-list="descendants">
      <DescendantOutline
        node={data.descendants}
        persons={persons}
        onPick={(id) => onPick(id, 'descendants')}
        root
      />
    </div>
  );
  if (kind === 'descendants') return descendants;
  if (kind === 'hourglass') {
    return (
      <>
        <h3>Ancestors</h3>
        {ancestors}
        <h3>Descendants</h3>
        {descendants}
      </>
    );
  }
  return ancestors;
}

/** The name of a chart for a screen reader. */
function chartName(kind: ChartKind, root: string, generations: number): string {
  const what =
    kind === 'pedigree'
      ? 'Ancestor chart'
      : kind === 'descendants'
        ? 'Descendant chart'
        : kind === 'hourglass'
          ? 'Hourglass chart'
          : 'Fan chart';
  return `${what} of ${root}, ${generations} generations`;
}

/** A chart of one person's relatives, with a choice of four kinds. */
export function ChartView({ personId, revision, onSelect, onDetails, onProblem }: ChartViewProps) {
  const [kind, setKind] = useState<ChartKind>('pedigree');
  const [generations, setGenerations] = useState(DEFAULT_GENERATIONS);
  const [zoom, setZoom] = useState(1);
  const [exporting, setExporting] = useState(false);
  const [loaded, setLoaded] = useState<{
    key: string;
    kind: ChartKind;
    data: ChartInfo | null;
  } | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const outline = useRef<HTMLDivElement>(null);
  const kindGroup = useRef<HTMLDivElement>(null);
  /** Where the focus goes once the chart of the person who was picked is drawn. */
  const focusAfter = useRef<'chart' | OutlineList | null>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);

  const maxGenerations = kind === 'fan' ? FAN_MAX_GENERATIONS + 1 : MAX_GENERATIONS;
  const shown = Math.min(generations, maxGenerations);
  const key = `${personId}|${kind}|${shown}|${revision}`;

  useEffect(() => {
    let cancelled = false;
    api.getChart({ personId, ...requestFor(kind, shown) }).then(
      (data) => {
        if (!cancelled) setLoaded({ key, kind, data });
      },
      (failure: unknown) => {
        if (!cancelled) onProblem(errorMessage(failure));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [key, personId, kind, shown, onProblem]);

  const data = loaded?.data ?? null;
  // While another chart is being read, keep showing the one that is there.
  const shownKind = loaded?.kind ?? kind;
  const persons = useMemo(
    () => new Map((data?.persons ?? []).map((person) => [person.id, person])),
    [data],
  );
  const layout = useMemo((): { fan: FanChart } | { boxes: BoxChart } | null => {
    if (!data) return null;
    if (shownKind === 'fan') return { fan: layoutFan(data.ancestors) };
    if (shownKind === 'descendants') return { boxes: layoutDescendants(data.descendants) };
    if (shownKind === 'hourglass') {
      return { boxes: layoutHourglass(data.ancestors, data.descendants) };
    }
    return { boxes: layoutPedigree(data.ancestors) };
  }, [data, shownKind]);

  const size = layout === null ? null : 'fan' in layout ? layout.fan : layout.boxes;
  const width = size?.width ?? 0;
  const height = size?.height ?? 0;

  // Bring the person the chart is for into view whenever a new chart is drawn.
  useEffect(() => {
    const view = scroller.current;
    if (!view || layout === null) return;
    let x: number;
    let y: number;
    if ('fan' in layout) {
      x = layout.fan.centerX;
      y = layout.fan.centerY;
    } else {
      const root = layout.boxes.boxes.find((box) => box.role === 'root');
      x = (root?.x ?? 0) + layout.boxes.boxWidth / 2;
      y = (root?.y ?? 0) + layout.boxes.boxHeight / 2;
    }
    view.scrollTo({ left: x * zoom - view.clientWidth / 2, top: y * zoom - view.clientHeight / 2 });
  }, [layout, zoom]);

  // The box or the name that was picked is not in the new chart where it was: put the focus
  // on the person now at the centre, in the part of the screen the keyboard was in.
  useEffect(() => {
    const target = focusAfter.current;
    if (target === null || loaded === null || !loaded.key.startsWith(`${personId}|`)) return;
    focusAfter.current = null;
    // Only where the keyboard still is: a user who moved on to something else is left alone.
    const active = document.activeElement;
    const region = target === 'chart' ? scroller.current : outline.current;
    const lost = active === null || active === document.body;
    if (!lost && !(region?.contains(active) ?? false)) return;
    const root =
      target === 'chart'
        ? scroller.current?.querySelector<HTMLElement>(
            '[data-role="root"], [data-testid="fan-root"]',
          )
        : outline.current?.querySelector<HTMLElement>(
            `[data-outline-list="${target}"] [data-outline-root]`,
          );
    root?.focus();
  }, [loaded, personId]);

  const pick = (id: string, from: 'chart' | OutlineList = 'chart') => {
    if (id === personId) {
      onDetails();
      return;
    }
    focusAfter.current = from;
    onSelect(id);
  };

  /** The kinds of chart are a group of radio buttons: the arrow keys move between them. */
  const onKindKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0;
    const at = KINDS.findIndex(([value]) => value === kind);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? KINDS.length - 1
          : step === 0
            ? -1
            : (at + step + KINDS.length) % KINDS.length;
    const chosen = KINDS[next];
    if (chosen === undefined) return;
    event.preventDefault();
    setKind(chosen[0]);
    kindGroup.current?.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus();
  };

  const fit = () => {
    const view = scroller.current;
    if (!view || width === 0 || height === 0) return;
    const wanted = Math.min(view.clientWidth / width, view.clientHeight / height, 1);
    // The largest step that still shows the whole chart, or the smallest there is.
    const step = [...ZOOMS].reverse().find((value) => value <= wanted) ?? ZOOMS[0];
    setZoom(step);
  };
  const stepZoom = (direction: 1 | -1) => {
    const index = ZOOMS.findIndex((value) => value >= zoom);
    const next =
      ZOOMS[
        Math.min(
          Math.max((index === -1 ? ZOOMS.length - 1 : index) + direction, 0),
          ZOOMS.length - 1,
        )
      ];
    if (next !== undefined) setZoom(next);
  };

  // Dragging the background moves the chart, as on a map.
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const view = scroller.current;
    if (!view || event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest('button, [role="button"]')) return;
    drag.current = {
      x: event.clientX,
      y: event.clientY,
      left: view.scrollLeft,
      top: view.scrollTop,
    };
    view.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const view = scroller.current;
    const from = drag.current;
    if (!view || !from) return;
    view.scrollLeft = from.left - (event.clientX - from.x);
    view.scrollTop = from.top - (event.clientY - from.y);
  };
  const onPointerUp = () => {
    drag.current = null;
  };

  const root = persons.get(personId) ?? null;
  const generationOptions = Array.from(
    { length: maxGenerations - MIN_GENERATIONS + 1 },
    (_, index) => MIN_GENERATIONS + index,
  );

  return (
    <div className="chart-view" data-testid="chart-view">
      <header className="chart-bar">
        <div className="chart-title">
          <h2 data-testid="chart-root-name">{root ? fullName(root) : 'Chart'}</h2>
          <button type="button" className="small" onClick={onDetails} data-testid="chart-details">
            Show details
          </button>
        </div>
        <div className="chart-controls">
          <div
            className="segmented"
            role="radiogroup"
            aria-label="Kind of chart"
            ref={kindGroup}
            onKeyDown={onKindKeyDown}
          >
            {KINDS.map(([value, label, hint]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={kind === value}
                tabIndex={kind === value ? 0 : -1}
                title={hint}
                onClick={() => setKind(value)}
                data-testid={`chart-kind-${value}`}
              >
                {label}
              </button>
            ))}
          </div>
          <label className="inline-field">
            <span>Generations</span>
            <select
              value={shown}
              onChange={(event) => setGenerations(Number(event.target.value))}
              data-testid="chart-generations"
            >
              {generationOptions.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <div className="zoom" role="group" aria-label="Zoom">
            <IconButton
              label="Zoom out"
              onClick={() => stepZoom(-1)}
              disabled={zoom <= ZOOMS[0]}
              testId="chart-zoom-out"
            >
              <Minus size={16} aria-hidden="true" />
            </IconButton>
            <span data-testid="chart-zoom">{Math.round(zoom * 100)}%</span>
            <IconButton
              label="Zoom in"
              onClick={() => stepZoom(1)}
              disabled={zoom >= (ZOOMS.at(-1) ?? 1)}
              testId="chart-zoom-in"
            >
              <Plus size={16} aria-hidden="true" />
            </IconButton>
            <button type="button" className="small" onClick={fit} data-testid="chart-fit">
              <Maximize size={14} aria-hidden="true" />
              Fit
            </button>
          </div>
          <button
            type="button"
            className="small"
            title="Save this chart as a PDF or an SVG picture, or print it"
            onClick={() => setExporting(true)}
            data-testid="chart-export"
          >
            <Printer size={14} aria-hidden="true" />
            Save or print…
          </button>
        </div>
      </header>

      <p className="hint chart-hint">
        Click a person to put them at the centre of the chart. Click the person at the centre to see
        their details. Drag the background to move the chart. With the keyboard, move between people
        with Tab and press Enter, or use the text outline below.
        {data?.truncated === true &&
          ' This family is too large to show whole; the chart stops where “more…” is shown.'}
      </p>

      <p className="visually-hidden" role="status" data-testid="chart-status">
        {loaded === null || data === null
          ? ''
          : `${chartName(shownKind, root ? fullName(root) : 'this person', shown)} is shown.`}
      </p>

      {data !== null && (
        <details className="chart-outline-toggle" data-testid="chart-outline-toggle">
          <summary data-testid="chart-outline-summary">Text outline of this chart</summary>
          <div className="chart-outline" ref={outline} data-testid="chart-outline">
            <ChartOutline
              kind={shownKind}
              data={data}
              persons={persons}
              onPick={(id, list) => pick(id, list)}
            />
          </div>
        </details>
      )}

      <div
        className="chart-scroll"
        ref={scroller}
        role="region"
        aria-label="Chart drawing"
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        data-testid="chart-scroll"
      >
        {loaded === null && <p className="muted chart-message">Drawing the chart…</p>}
        {loaded !== null && data === null && (
          <p className="muted chart-message" data-testid="chart-gone">
            This person is not in the tree any more. Choose someone from the list.
          </p>
        )}
        {layout !== null && (
          <div className="chart-sizer" style={{ width: width * zoom, height: height * zoom }}>
            <div
              className="chart-canvas"
              style={{ width, height, transform: `scale(${zoom})` }}
              data-testid="chart-canvas"
              data-kind={shownKind}
              {...('boxes' in layout
                ? {
                    role: 'group',
                    'aria-label': `${chartName(shownKind, root ? fullName(root) : 'this person', shown)}. Each box is a button; the text outline lists the same people.`,
                  }
                : {})}
            >
              {'fan' in layout ? (
                <Fan
                  layout={layout.fan}
                  persons={persons}
                  root={root}
                  name={`${chartName('fan', root ? fullName(root) : 'this person', shown)}. Each place is a button; the text outline lists the same people.`}
                  onPick={pick}
                />
              ) : (
                <Boxes layout={layout.boxes} persons={persons} onPick={pick} />
              )}
            </div>
          </div>
        )}
      </div>
      {exporting && (
        <ChartExportDialog
          personId={personId}
          chart={kind}
          generations={shown}
          onClose={() => setExporting(false)}
        />
      )}
    </div>
  );
}
