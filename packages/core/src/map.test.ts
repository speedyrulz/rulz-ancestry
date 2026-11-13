import { describe, expect, it } from 'vitest';
import { distanceKm, frameOf, gatherMarkers, groupPoints, wrapLon, type MapPoint } from './map';

const AMES: MapPoint = { lat: 42.03, lon: -93.62 };
const SPRINGFIELD: MapPoint = { lat: 39.8, lon: -89.64 };
const AMSTERDAM: MapPoint = { lat: 52.37, lon: 4.89 };
const YORK: MapPoint = { lat: 53.96, lon: -1.08 };
const AUCKLAND: MapPoint = { lat: -36.85, lon: 174.76 };
const HONOLULU: MapPoint = { lat: 21.31, lon: -157.86 };

/** Whether a frame holds a point, counting round the 180th meridian. */
function holds(frame: NonNullable<ReturnType<typeof frameOf>>, point: MapPoint): boolean {
  const east = (((point.lon - frame.west) % 360) + 360) % 360;
  return (
    east <= frame.lonSpan && point.lat >= frame.south && point.lat <= frame.south + frame.latSpan
  );
}

describe('wrapLon', () => {
  it('brings a longitude into -180 to 180', () => {
    expect(wrapLon(190)).toBe(-170);
    expect(wrapLon(-190)).toBe(170);
    expect(wrapLon(180)).toBe(-180);
    expect(wrapLon(-93.62)).toBeCloseTo(-93.62);
  });
});

describe('gatherMarkers', () => {
  it('puts what lies at one point together, in the order the points first come', () => {
    const items = [
      { id: 'a', at: AMES },
      { id: 'b', at: null },
      { id: 'c', at: YORK },
      { id: 'd', at: { lat: 42.03000001, lon: -93.62 } },
    ];
    const markers = gatherMarkers(items, (item) => item.at);
    expect(markers.map((marker) => marker.items.map((item) => item.id))).toEqual([
      ['a', 'd'],
      ['c'],
    ]);
    expect(markers[0]).toMatchObject(AMES);
    expect(markers[0]?.key).not.toBe(markers[1]?.key);
  });

  it('takes 180 degrees east and west for one meridian', () => {
    const markers = gatherMarkers(
      [
        { lat: -16.5, lon: 180 },
        { lat: -16.5, lon: -180 },
      ],
      (point) => point,
    );
    expect(markers).toHaveLength(1);
  });
});

describe('distanceKm', () => {
  it('measures along the earth', () => {
    expect(distanceKm(AMES, AMES)).toBe(0);
    expect(distanceKm(AMSTERDAM, YORK)).toBeGreaterThan(400);
    expect(distanceKm(AMSTERDAM, YORK)).toBeLessThan(450);
    expect(distanceKm(AUCKLAND, HONOLULU)).toBeGreaterThan(7000);
  });
});

describe('groupPoints', () => {
  it('keeps points that lie apart in groups of their own', () => {
    expect(groupPoints([AMES, AMSTERDAM, SPRINGFIELD, YORK, AUCKLAND])).toEqual([
      [0, 2],
      [1, 3],
      [4],
    ]);
  });

  it('joins two groups when a point lies near both', () => {
    const chain = [
      { lat: 40, lon: 0 },
      { lat: 40, lon: 14 },
      { lat: 40, lon: 7 },
    ];
    expect(groupPoints(chain)).toEqual([[0, 1, 2]]);
    expect(groupPoints([])).toEqual([]);
  });
});

describe('frameOf', () => {
  it('has nothing to frame without points', () => {
    expect(frameOf([])).toBeNull();
  });

  it('gives one point a frame about the size of a state', () => {
    const frame = frameOf([AMES]);
    expect(frame).not.toBeNull();
    if (!frame) return;
    expect(frame.latSpan).toBeCloseTo(4);
    expect(frame.lonSpan).toBeCloseTo(4 / Math.cos((42.03 * Math.PI) / 180));
    expect(frame.centerLat).toBeCloseTo(42.03);
    expect(frame.centerLon).toBeCloseTo(-93.62);
  });

  it('holds every point, with room around them', () => {
    const points = [AMES, SPRINGFIELD, AMSTERDAM, YORK];
    const frame = frameOf(points);
    if (!frame) throw new Error('no frame');
    for (const point of points) expect(holds(frame, point)).toBe(true);
    expect(frame.lonSpan).toBeGreaterThan(98.51);
    expect(frame.lonSpan).toBeLessThan(150);
    expect(frame.west).toBeLessThan(-93.62);
  });

  it('goes the short way round the earth', () => {
    const frame = frameOf([AUCKLAND, HONOLULU]);
    if (!frame) throw new Error('no frame');
    expect(holds(frame, AUCKLAND)).toBe(true);
    expect(holds(frame, HONOLULU)).toBe(true);
    // 27 degrees across the Pacific, not 333 across the rest of the world.
    expect(frame.lonSpan).toBeLessThan(45);
    expect(Math.abs(frame.centerLon)).toBeGreaterThan(170);
  });

  it('shows the whole earth when the points lie all round it', () => {
    const frame = frameOf([
      { lat: 0, lon: -150 },
      { lat: 0, lon: -30 },
      { lat: 0, lon: 90 },
    ]);
    expect(frame?.lonSpan).toBeCloseTo(336);
    const wide = frameOf([-180, -108, -36, 36, 108].map((lon) => ({ lat: 0, lon })));
    expect(wide?.lonSpan).toBe(360);
  });

  it('ends short of the poles, and still holds a place close to one', () => {
    const point = { lat: 88, lon: 10 };
    const frame = frameOf([point]);
    if (!frame) throw new Error('no frame');
    expect(frame.south + frame.latSpan).toBeLessThanOrEqual(89);
    expect(holds(frame, point)).toBe(true);
    expect(frameOf([{ lat: -90, lon: 0 }])?.south).toBe(-89);
  });
});
