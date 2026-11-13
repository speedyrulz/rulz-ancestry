import {
  formatAge,
  frameOf,
  gatherMarkers,
  groupPoints,
  wrapLon,
  type MapFrame,
  type MapMarker,
  type Sex,
} from '@rulz/core';
import { geoEqualEarth, geoMercator, geoPath } from 'd3-geo';
import type { Feature, Geometry } from 'geojson';
import { useEffect, useMemo, useState } from 'react';
import { feature } from 'topojson-client';
import type { GeometryCollection, Topology } from 'topojson-specification';
import type { LifeEntryInfo, PersonLifeInfo } from '../../../shared/ipc';
import { api, errorMessage } from '../api';
import { countOf, fullName, labelOf } from '../format';

/** The size of the map's drawing; the picture is scaled to the width of the page. */
const MAP_WIDTH = 720;
const MAP_HEIGHT = 420;
/** Room kept between the frame and the edge of the drawing. */
const MAP_EDGE = 24;
/** One press on "Zoom in" or "Zoom out" changes the scale by this. */
const ZOOM_STEP = 1.6;
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 40;

const RELATIVES: Readonly<Record<'parent' | 'child' | 'sibling', Readonly<Record<Sex, string>>>> = {
  parent: { M: 'father', F: 'mother', X: 'parent', U: 'parent' },
  child: { M: 'son', F: 'daughter', X: 'child', U: 'child' },
  sibling: { M: 'brother', F: 'sister', X: 'sibling', U: 'sibling' },
};

type Marker = MapMarker<LifeEntryInfo>;

/** What happened, without who: "Birth", "Marriage", "Death of son". */
function entryTitle(entry: LifeEntryInfo): string {
  const what = labelOf(entry.event.type);
  if (entry.kind !== 'relative' || entry.relation === null || entry.person === null) return what;
  const who =
    entry.relation === 'partner' ? 'partner' : RELATIVES[entry.relation][entry.person.sex];
  return `${what} of ${who}`;
}

/** The first and the last day an entry can mean are both unknown: it cannot be placed in time. */
function undated(entry: LifeEntryInfo): boolean {
  return entry.event.dateMinJdn === null && entry.event.dateMaxJdn === null;
}

/** The name of a place as a button says it: its first part, "Ames" of "Ames, Story, Iowa". */
function shortPlace(text: string): string {
  return text.split(',')[0]?.trim() || text;
}

/** A country, or a state, a province or a county of a country that comes divided. */
type Shape = Feature<Geometry, { name?: string }>;

interface World {
  shapes: Shape[];
}

/** A shape is named on the map when it is drawn at least this wide and high. */
const LABEL_WIDTH = 80;
const LABEL_HEIGHT = 30;
/** No more names than this are written on one map: the largest shapes first. */
const LABELS = 30;

let world: Promise<World> | null = null;

/** Reads the outline map the app ships with. It is read once, when a map is first shown. */
function loadWorld(): Promise<World> {
  world ??= import('../assets/world.json?raw').then((module) => {
    const map = JSON.parse(module.default) as Topology<{
      countries: GeometryCollection;
      regions: GeometryCollection;
    }>;
    return {
      shapes: [
        ...(feature(map, map.objects.countries).features as Shape[]),
        ...(feature(map, map.objects.regions).features as Shape[]),
      ],
    };
  });
  return world;
}

/** Sets up how the earth is drawn flat so that a frame fills the drawing, enlarged by `zoom`. */
function projectionOf(frame: MapFrame, zoom: number) {
  // Mercator keeps shapes as people know them; over a large part of the earth it
  // swells the north out of all proportion, so a wide frame gets Equal Earth.
  // Nor has Mercator room for the far north and south.
  const north = frame.south + frame.latSpan;
  const wide = frame.lonSpan > 110 || frame.latSpan > 70 || north > 78 || frame.south < -78;
  const projection = (wide ? geoEqualEarth() : geoMercator()).rotate([-frame.centerLon, 0]);
  const whole = frame.lonSpan >= 350;
  // Just short of the frame's edges: at the full span both edges are the same meridian.
  const half = (frame.lonSpan / 2) * 0.999;
  const corners: [number, number][] = [];
  for (const lon of [-half, 0, half]) {
    for (const lat of [frame.south, frame.centerLat, frame.south + frame.latSpan]) {
      corners.push([wrapLon(frame.centerLon + lon), lat]);
    }
  }
  projection.fitExtent(
    [
      [MAP_EDGE, MAP_EDGE],
      [MAP_WIDTH - MAP_EDGE, MAP_HEIGHT - MAP_EDGE],
    ],
    whole ? { type: 'Sphere' } : { type: 'MultiPoint', coordinates: corners },
  );
  if (zoom !== 1) {
    // Enlarged about the middle of the drawing as it was fitted. That is not the
    // middle of the frame in degrees: a projection does not space latitudes evenly.
    const at = projection.invert?.([MAP_WIDTH / 2, MAP_HEIGHT / 2]) ?? [frame.centerLon, 0];
    projection.scale(projection.scale() * zoom);
    const moved = projection(at) ?? [MAP_WIDTH / 2, MAP_HEIGHT / 2];
    const [x, y] = projection.translate();
    projection.translate([x + MAP_WIDTH / 2 - moved[0], y + MAP_HEIGHT / 2 - moved[1]]);
  }
  return projection.clipExtent([
    [0, 0],
    [MAP_WIDTH, MAP_HEIGHT],
  ]);
}

/** Which part of the earth the map shows: every marker, one group of them, or one alone. */
type View = { kind: 'all' } | { kind: 'group'; index: number } | { kind: 'marker'; index: number };

interface LifeMapProps {
  markers: Marker[];
  selected: number | null;
  onSelect: (index: number | null) => void;
}

/** The places of a life on an outline map of the earth. */
function LifeMap({ markers, selected, onSelect }: LifeMapProps) {
  const [shapes, setShapes] = useState<Shape[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [view, setView] = useState<View>({ kind: 'all' });
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    let cancelled = false;
    loadWorld().then(
      (loaded) => {
        if (!cancelled) setShapes(loaded.shapes);
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const groups = useMemo(() => groupPoints(markers), [markers]);
  const frame = useMemo(() => {
    const shown =
      view.kind === 'all'
        ? markers
        : view.kind === 'group'
          ? (groups[view.index] ?? []).flatMap((index) => markers[index] ?? [])
          : markers.slice(view.index, view.index + 1);
    return frameOf(shown.length > 0 ? shown : markers);
  }, [markers, groups, view]);

  const projection = useMemo(
    () => (frame === null ? null : projectionOf(frame, zoom)),
    [frame, zoom],
  );
  const { outlines, labels } = useMemo(() => {
    const drawn: string[] = [];
    const names: { name: string; x: number; y: number; area: number }[] = [];
    if (projection === null || shapes === null) return { outlines: drawn, labels: names };
    const path = geoPath(projection);
    for (const shape of shapes) {
      const d = path(shape);
      if (d === null) continue;
      drawn.push(d);
      // Measured as drawn, so a shape that runs off the map is named where it shows.
      const [[left, top], [right, bottom]] = path.bounds(shape);
      const name = shape.properties.name ?? '';
      if (name === '' || right - left < LABEL_WIDTH || bottom - top < LABEL_HEIGHT) continue;
      const [x, y] = path.centroid(shape);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        names.push({ name, x, y, area: (right - left) * (bottom - top) });
      }
    }
    names.sort((a, b) => b.area - a.area);
    // The largest shapes are named first; a name that would run into one already written is left out.
    const written: typeof names = [];
    for (const label of names) {
      if (written.length >= LABELS) break;
      const room = (other: (typeof names)[number]) =>
        Math.abs(other.y - label.y) > 14 ||
        Math.abs(other.x - label.x) > (other.name.length + label.name.length) * 3.2;
      if (written.every(room)) written.push(label);
    }
    return { outlines: drawn, labels: written };
  }, [projection, shapes]);
  const sphere = useMemo(
    () => (projection === null ? null : geoPath(projection)({ type: 'Sphere' })),
    [projection],
  );

  if (projection === null) return null;
  const show = (next: View) => {
    setView(next);
    setZoom(1);
  };
  const isView = (other: View) =>
    view.kind === other.kind &&
    ('index' in view ? view.index : -1) === ('index' in other ? other.index : -1);

  return (
    <div className="life-map" data-testid="life-map">
      <div className="actions">
        {groups.length > 1 && (
          <>
            <button
              type="button"
              className="small"
              aria-pressed={isView({ kind: 'all' })}
              onClick={() => show({ kind: 'all' })}
              data-testid="map-view-all"
            >
              Everything
            </button>
            {groups.map((members, index) => {
              const first = markers[members[0] ?? 0];
              const text = first?.items[0]?.event.placeText ?? '';
              return (
                <button
                  type="button"
                  className="small"
                  key={members.join(' ')}
                  aria-pressed={isView({ kind: 'group', index })}
                  onClick={() => show({ kind: 'group', index })}
                  data-testid="map-view-group"
                >
                  Around {shortPlace(text)}
                </button>
              );
            })}
          </>
        )}
        <button
          type="button"
          className="small"
          disabled={zoom >= ZOOM_MAX}
          onClick={() => setZoom((now) => Math.min(ZOOM_MAX, now * ZOOM_STEP))}
          data-testid="map-zoom-in"
        >
          Zoom in
        </button>
        <button
          type="button"
          className="small"
          disabled={zoom <= ZOOM_MIN}
          onClick={() => setZoom((now) => Math.max(ZOOM_MIN, now / ZOOM_STEP))}
          data-testid="map-zoom-out"
        >
          Zoom out
        </button>
        {(view.kind === 'marker' || zoom !== 1) && (
          <button
            type="button"
            className="small"
            onClick={() => show({ kind: 'all' })}
            data-testid="map-reset"
          >
            Show all places
          </button>
        )}
      </div>

      <svg
        viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`}
        role="img"
        aria-label={`Map with ${countOf(markers.length, 'place', 'places')}. They are listed below.`}
        data-testid="life-map-drawing"
      >
        <rect className="map-space" width={MAP_WIDTH} height={MAP_HEIGHT} />
        {sphere !== null && <path className="map-sea" d={sphere} />}
        <g className="map-land" data-testid="map-land" data-shapes={outlines.length}>
          {outlines.map((d, index) => (
            <path key={index} d={d} />
          ))}
        </g>
        <g className="map-names" aria-hidden="true">
          {labels.map((label) => (
            <text key={`${label.name} ${label.x}`} x={label.x} y={label.y} textAnchor="middle">
              {label.name}
            </text>
          ))}
        </g>
        {markers.map((marker, index) => {
          const at = projection([marker.lon, marker.lat]);
          if (!at) return null;
          const [x, y] = at;
          if (x < 0 || x > MAP_WIDTH || y < 0 || y > MAP_HEIGHT) return null;
          return (
            <g
              key={index}
              className={selected === index ? 'map-marker selected' : 'map-marker'}
              transform={`translate(${x.toFixed(1)} ${y.toFixed(1)})`}
              onClick={() => onSelect(selected === index ? null : index)}
              data-testid="map-marker"
              data-number={index + 1}
            >
              <title>{marker.items[0]?.event.placeText}</title>
              <circle r={10} />
              <text textAnchor="middle" dy="0.35em">
                {index + 1}
              </text>
            </g>
          );
        })}
      </svg>
      {failed && (
        <p className="hint" data-testid="map-failed">
          The outlines of the map could not be read. The places are marked without them.
        </p>
      )}
      <p className="hint">
        Outlines of today&apos;s borders, made with Natural Earth. A mark stands where the place
        list puts the place it is linked to: the middle of a town, a county or a state.
      </p>

      <ol className="map-legend" data-testid="map-legend">
        {markers.map((marker, index) => {
          const texts = [...new Set(marker.items.map((entry) => entry.event.placeText))];
          const linked = marker.items[0]?.place?.name ?? '';
          return (
            <li
              key={index}
              className={selected === index ? 'selected' : undefined}
              data-testid="map-legend-row"
            >
              <button
                type="button"
                className="map-number"
                aria-pressed={selected === index}
                aria-label={`Show place ${index + 1} on the map`}
                onClick={() => {
                  onSelect(index);
                  show({ kind: 'marker', index });
                }}
                data-testid="map-legend-show"
              >
                {index + 1}
              </button>
              <div>
                <div>{texts.join(' · ')}</div>
                {linked !== '' && !texts.includes(linked) && (
                  <div className="hint">Linked to {linked}</div>
                )}
                <div className="hint">
                  {marker.items
                    .map((entry) =>
                      [entryTitle(entry), entry.event.dateText]
                        .filter((part) => part !== '')
                        .join(' '),
                    )
                    .join(', ')}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

interface LifeSectionProps {
  personId: string;
  /** Changes with every edit of the tree, so that the life is read again. */
  revision: number;
  onSelect: (personId: string) => void;
  onProblem: (message: string) => void;
}

/** A person's life in order, and its places on a map. */
export function LifeSection({ personId, revision, onSelect, onProblem }: LifeSectionProps) {
  const [loaded, setLoaded] = useState<{ personId: string; life: PersonLifeInfo | null } | null>(
    null,
  );
  const [family, setFamily] = useState(true);
  /** Counts the times the map was sent back to showing every place. */
  const [whole, setWhole] = useState(0);
  // The mark that is picked out, by its point: a number would point at another
  // place as soon as an edit changed the list.
  const [selected, setSelected] = useState<{ personId: string; key: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.getPersonLife(personId).then(
      (life) => {
        if (!cancelled) setLoaded({ personId, life });
      },
      (failure: unknown) => {
        if (!cancelled) onProblem(errorMessage(failure));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [personId, revision, onProblem]);

  const life = loaded !== null && loaded.personId === personId ? loaded.life : null;
  const entries = useMemo(
    () => (life?.entries ?? []).filter((entry) => family || entry.kind !== 'relative'),
    [life, family],
  );
  const markers = useMemo(() => gatherMarkers(entries, (entry) => entry.place), [entries]);
  const numberOf = useMemo(() => {
    const numbers = new Map<string, number>();
    markers.forEach((marker, index) => {
      for (const entry of marker.items) numbers.set(entry.event.id, index + 1);
    });
    return numbers;
  }, [markers]);

  if (life === null) return null;
  const hasRelatives = life.entries.some((entry) => entry.kind === 'relative');
  const dated = entries.filter((entry) => !undated(entry));
  const rest = entries.filter(undated);
  const unlinked = [
    ...new Set(
      entries
        .filter((entry) => entry.place === null && entry.event.placeText.trim() !== '')
        .map((entry) => entry.event.placeText),
    ),
  ];
  const found =
    selected !== null && selected.personId === personId
      ? markers.findIndex((marker) => marker.key === selected.key)
      : -1;
  const marked = found < 0 ? null : found;
  const mark = (index: number | null) => {
    const marker = index === null ? undefined : markers[index];
    setSelected(marker ? { personId, key: marker.key } : null);
  };
  /** Picks a mark out from the timeline. The map goes back to all places, so that the mark shows. */
  const point = (index: number | null) => {
    mark(index);
    if (index !== null) setWhole((count) => count + 1);
  };

  const row = (entry: LifeEntryInfo) => {
    const number = numberOf.get(entry.event.id);
    const person = entry.person;
    return (
      <li
        key={entry.event.id}
        className={entry.kind === 'relative' ? 'life-row relative' : 'life-row'}
        data-testid="life-row"
        data-kind={entry.kind}
      >
        <div className="life-when">
          <div>{entry.event.dateText}</div>
          {entry.age !== null && <div className="hint">{formatAge(entry.age)}</div>}
        </div>
        <div className="life-what">
          <div>
            <span className="life-title">{entryTitle(entry)}</span>
            {person !== null && (entry.kind === 'family' ? ' with ' : ' ')}
            {person !== null && (
              <button type="button" className="link" onClick={() => onSelect(person.id)}>
                {fullName(person)}
              </button>
            )}
            {entry.event.description !== '' && (
              <span className="muted"> · {entry.event.description}</span>
            )}
          </div>
          {entry.event.placeText !== '' && (
            <div className="hint">
              {number !== undefined && (
                <button
                  type="button"
                  className="map-number"
                  aria-label={`Place ${number} on the map`}
                  aria-pressed={marked === number - 1}
                  onClick={() => point(marked === number - 1 ? null : number - 1)}
                  data-testid="life-place-number"
                >
                  {number}
                </button>
              )}
              {entry.event.placeText}
            </div>
          )}
        </div>
      </li>
    );
  };

  return (
    <section data-testid="life-section">
      <h3>Timeline and map</h3>
      {hasRelatives && (
        <label className="check">
          <input
            type="checkbox"
            checked={family}
            onChange={(event) => {
              setFamily(event.target.checked);
              setSelected(null);
            }}
            data-testid="life-family"
          />
          Show births and deaths in the family
        </label>
      )}
      {entries.length === 0 ? (
        <p className="muted">Nothing to show yet. Events make the timeline.</p>
      ) : (
        <>
          {dated.length > 0 && (
            <ol className="life" data-testid="life-dated">
              {dated.map(row)}
            </ol>
          )}
          {rest.length > 0 && (
            <>
              <h4 className="life-head">Date not known</h4>
              <ol className="life" data-testid="life-undated">
                {rest.map(row)}
              </ol>
            </>
          )}
        </>
      )}

      {markers.length > 0 && (
        <LifeMap
          key={`${personId} ${whole} ${markers.map((marker) => marker.key).join('|')}`}
          markers={markers}
          selected={marked}
          onSelect={mark}
        />
      )}
      {unlinked.length > 0 && (
        <p className="hint" data-testid="life-unlinked">
          {markers.length === 0 ? 'No place here is on a map yet. ' : ''}
          {countOf(unlinked.length, 'place is', 'places are')} not linked to the place list, so the
          app does not know where {unlinked.length === 1 ? 'it lies' : 'they lie'}:{' '}
          {unlinked.join(' · ')}. &ldquo;Places&rdquo; on the tree screen links a place.
        </p>
      )}
    </section>
  );
}
