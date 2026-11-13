/** A point on the earth, in degrees. */
export interface MapPoint {
  lat: number;
  lon: number;
}

/** One mark on a map: a point, and everything that lies there. */
export interface MapMarker<T> extends MapPoint {
  /** Names the point; the same for every marker there, whatever lies at it. */
  key: string;
  items: T[];
}

/**
 * The part of the earth a map shows. `west` lies between -180 and 180, and
 * the frame reaches `lonSpan` degrees east from there, which may carry it
 * over the 180th meridian.
 */
export interface MapFrame {
  west: number;
  south: number;
  lonSpan: number;
  latSpan: number;
  /** The middle of the frame; `centerLon` lies between -180 and 180. */
  centerLon: number;
  centerLat: number;
}

/** A frame is never narrower than this many degrees of latitude: about a state, 440 km. */
const MIN_SPAN = 4;
/** Room left around the points, as a share of their span, on each side. */
const MARGIN = 0.2;
/** A frame ends short of the poles, where a map has no room left. */
const LAT_LIMIT = 89;
/** Points this close, in kilometres, belong to one group. */
const GROUP_KM = 700;

/** Brings a longitude into the range from -180 up to, not including, 180. */
export function wrapLon(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/**
 * Puts what lies at the same point together, in the order the points first
 * come. Two points are the same when they agree to four decimals, some ten
 * metres, which every copy of one gazetteer entry does.
 */
export function gatherMarkers<T>(
  items: readonly T[],
  where: (item: T) => MapPoint | null,
): MapMarker<T>[] {
  const markers = new Map<string, MapMarker<T>>();
  for (const item of items) {
    const point = where(item);
    if (point === null) continue;
    // 180 degrees east and 180 degrees west are one meridian.
    const key = `${point.lat.toFixed(4)} ${wrapLon(point.lon).toFixed(4)}`;
    const marker = markers.get(key);
    if (marker) marker.items.push(item);
    else markers.set(key, { key, lat: point.lat, lon: point.lon, items: [item] });
  }
  return [...markers.values()];
}

/** The distance between two points in kilometres, along the surface of the earth. */
export function distanceKm(a: MapPoint, b: MapPoint): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Sorts points into groups that lie apart: a point belongs to a group when it
 * is within 700 km of any point of it. A life spent in two countries gives two
 * groups, each worth a map of its own. Returns the indexes of the points,
 * each group in the order given, the groups in the order of their first point.
 */
export function groupPoints(points: readonly MapPoint[]): number[][] {
  const group = points.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (group[root] !== root) root = group[root] ?? root;
    return root;
  };
  points.forEach((point, index) => {
    for (let other = 0; other < index; other += 1) {
      const there = points[other];
      if (there && distanceKm(point, there) <= GROUP_KM) group[find(index)] = find(other);
    }
  });
  const groups = new Map<number, number[]>();
  points.forEach((_, index) => {
    const root = find(index);
    const members = groups.get(root);
    if (members) members.push(index);
    else groups.set(root, [index]);
  });
  return [...groups.values()].sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0));
}

/**
 * The frame that shows every point with room around them. Of the two ways
 * round the earth it takes the shorter, so that New Zealand and Hawaii are
 * framed across the Pacific and not across the rest of the world. One point,
 * or points close together, get a frame about the size of a state. Null when
 * there are no points.
 */
export function frameOf(points: readonly MapPoint[]): MapFrame | null {
  if (points.length === 0) return null;

  const lats = points.map((point) => Math.max(-LAT_LIMIT, Math.min(LAT_LIMIT, point.lat)));
  let south = Math.min(...lats);
  let north = Math.max(...lats);

  // The widest empty stretch of longitude lies outside the frame.
  const lons = [...new Set(points.map((point) => wrapLon(point.lon)))].sort((a, b) => a - b);
  let west = lons[0] ?? 0;
  let lonSpan = 0;
  if (lons.length > 1) {
    let widest = -1;
    lons.forEach((lon, index) => {
      const next = lons[(index + 1) % lons.length] ?? lon;
      const gap = (((next - lon) % 360) + 360) % 360;
      if (gap > widest) {
        widest = gap;
        west = next;
        lonSpan = 360 - gap;
      }
    });
  }

  const latMargin = (north - south) * MARGIN;
  south -= latMargin;
  north += latMargin;
  if (north - south < MIN_SPAN) {
    const middle = (south + north) / 2;
    south = middle - MIN_SPAN / 2;
    north = middle + MIN_SPAN / 2;
  }
  south = Math.max(-LAT_LIMIT, south);
  north = Math.min(LAT_LIMIT, north);

  // A degree of longitude is shorter away from the equator.
  const centerLat = (south + north) / 2;
  const minLonSpan = MIN_SPAN / Math.max(0.2, Math.cos((centerLat * Math.PI) / 180));
  let centerLon = west + lonSpan / 2;
  lonSpan = Math.max(lonSpan * (1 + 2 * MARGIN), minLonSpan);
  if (lonSpan >= 360) {
    lonSpan = 360;
    west = centerLon - 180;
  } else {
    west = centerLon - lonSpan / 2;
  }
  centerLon = wrapLon(centerLon);

  return {
    west: wrapLon(west),
    south,
    lonSpan,
    latSpan: north - south,
    centerLon,
    centerLat,
  };
}
