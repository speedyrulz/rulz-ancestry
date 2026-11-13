/**
 * Places: the text of a place as it is typed, and the entries of a gazetteer
 * (a list of the world's places with their coordinates).
 *
 * The text of a place belongs to the user and is never rewritten. A gazetteer
 * entry is only offered while typing, and linked to a text to give it
 * coordinates.
 */

/** The longest text of a place the app stores. */
export const PLACE_TEXT_MAX = 500;

/** The fewest letters that start a search of the gazetteer. */
export const PLACE_QUERY_MIN = 2;

/**
 * The countries whose places are offered first, most important first. The
 * project's region priority: the United States, the Netherlands, the United
 * Kingdom and Ireland, Australia and New Zealand.
 */
export const REGION_PRIORITY: readonly string[] = ['US', 'NL', 'GB', 'IE', 'AU', 'NZ'];

/** Letters that Unicode does not split into a plain letter and a mark. */
const PLAIN_LETTERS: Readonly<Record<string, string>> = {
  ß: 'ss',
  æ: 'ae',
  œ: 'oe',
  ø: 'o',
  đ: 'd',
  ð: 'd',
  þ: 'th',
  ł: 'l',
  ı: 'i',
};

/**
 * A place name reduced to what is compared: lower case, no accents, no
 * apostrophes, and single spaces where anything else stood. "'s-Gravenhage"
 * and "s gravenhage" are the same, and so are "Zürich" and "Zurich".
 */
export function foldPlace(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[ßæœøđðþłı]/g, (letter) => PLAIN_LETTERS[letter] ?? letter)
    .replace(/['‘’`´]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Whether a folded name is written in Latin letters, digits and spaces only. */
export function isLatinFolded(folded: string): boolean {
  return /^[a-z0-9 ]+$/.test(folded);
}

/** The parts of a place between its commas, without the empty ones. */
export function placeParts(text: string): string[] {
  return text
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

/** One entry of the gazetteer, with the names of the regions it lies in. */
export interface GazetteerPlace {
  /** The number GeoNames gives the place. */
  geonameId: number;
  name: string;
  /** GeoNames' class: `P` for a city, town or village, `A` for a country, state or county. */
  featureClass: string;
  /** GeoNames' code within the class, for example `PPL`, `ADM1`, `ADM2` or `PCLI`. */
  featureCode: string;
  /** The two letters of the country, for example `US`. Empty when it lies in none. */
  countryCode: string;
  /** The country's name in English, as GeoNames has it. */
  country: string;
  /** The first division of the country (a state, a province), and its code. Empty when unknown. */
  admin1: string;
  admin1Code: string;
  /** The second division (a county, a municipality). Empty when unknown. */
  admin2: string;
  lat: number;
  lon: number;
  population: number;
}

/** How a country is written at the end of a place, where that differs from GeoNames' name. */
const COUNTRY_LABELS: Readonly<Record<string, string>> = {
  US: 'USA',
  NL: 'Netherlands',
};

/**
 * Countries whose places are written with the second division: a county in
 * the United States, in Great Britain and in Ireland. Elsewhere the second
 * division is a municipality, which family historians leave out.
 */
const WITH_ADMIN2 = new Set(['US', 'GB', 'IE']);
/** Ireland's first division is its province, which is left out. */
const WITHOUT_ADMIN1 = new Set(['IE']);
/** A place in the United Kingdom ends with England, Scotland, Wales or Northern Ireland. */
const WITHOUT_COUNTRY_AFTER_ADMIN1 = new Set(['GB']);

function countryLabel(place: GazetteerPlace): string {
  return COUNTRY_LABELS[place.countryCode] ?? place.country;
}

/** Whether the entry is a country or a like territory. */
function isCountry(place: GazetteerPlace): boolean {
  return place.featureClass === 'A' && /^(PCL|TERR)/.test(place.featureCode);
}

/**
 * The text of a gazetteer entry as family historians write a place: the
 * smallest part first, then the county where that is usual, the state or
 * province, and the country. For example "Springfield, Sangamon County,
 * Illinois, USA", "York, North Yorkshire, England" and "Amsterdam, North
 * Holland, Netherlands".
 */
export function formatGazetteerPlace(place: GazetteerPlace): string {
  const country = countryLabel(place);
  if (isCountry(place)) return country || place.name;

  const code = place.featureClass === 'A' ? place.featureCode : '';
  const parts = [place.name];
  const isAdmin1 = code.startsWith('ADM1');
  const isAdmin2 = code.startsWith('ADM2');
  const nameFolded = foldPlace(place.name);

  if (
    !isAdmin1 &&
    !isAdmin2 &&
    WITH_ADMIN2.has(place.countryCode) &&
    place.admin2 !== '' &&
    foldPlace(place.admin2) !== nameFolded
  ) {
    parts.push(place.admin2);
  }
  const admin1 = isAdmin1 || WITHOUT_ADMIN1.has(place.countryCode) ? '' : place.admin1;
  if (admin1 !== '') parts.push(admin1);
  const leaveCountryOut =
    WITHOUT_COUNTRY_AFTER_ADMIN1.has(place.countryCode) && (admin1 !== '' || isAdmin1);
  if (country !== '' && !leaveCountryOut && foldPlace(country) !== nameFolded) parts.push(country);
  return parts.join(', ');
}

/** What the user typed, made ready to search with. */
export interface PlaceQuery {
  /** The first part, folded: the start of the name looked for. */
  name: string;
  /** The parts after the first comma, folded: each must fit a region the place lies in. */
  regions: string[];
}

/**
 * Reads what was typed in a place field. Null when the first part is too
 * short to search with.
 */
export function parsePlaceQuery(text: string): PlaceQuery | null {
  const [first = '', ...rest] = text.split(',');
  const name = foldPlace(first);
  if (name.length < PLACE_QUERY_MIN) return null;
  return { name, regions: rest.map(foldPlace).filter((part) => part !== '') };
}

/** Other ways the regions of some countries are written, folded. */
const COUNTRY_ALIASES: Readonly<Record<string, readonly string[]>> = {
  US: ['usa', 'united states', 'united states of america', 'america'],
  GB: ['uk', 'united kingdom', 'great britain', 'britain'],
  NL: ['netherlands', 'the netherlands', 'holland', 'nederland'],
  IE: ['ireland', 'eire'],
};

/**
 * Words that say what kind of region a name is. They are not compared, so
 * "Sangamon" fits "Sangamon County", "Cork" fits "County Cork", and
 * "Lincoln City" fits "City of Lincoln".
 */
const REGION_KINDS = new Set([
  'county',
  'city',
  'parish',
  'township',
  'twp',
  'borough',
  'district',
  'independent',
  'of',
  'the',
]);

function regionWords(folded: string): string[] {
  return folded.split(' ').filter((word) => word !== '' && !REGION_KINDS.has(word));
}

/**
 * The words of the names of regions seen before. One search weighs thousands
 * of places against what was typed, and the same few thousand counties,
 * states and countries come by every time; folding a name is the costly part.
 */
const REGION_WORDS = new Map<string, readonly string[]>();
const REGION_WORDS_KEPT = 20_000;

function wordsOfRegion(name: string): readonly string[] {
  let words = REGION_WORDS.get(name);
  if (words === undefined) {
    words = regionWords(foldPlace(name));
    if (REGION_WORDS.size >= REGION_WORDS_KEPT) REGION_WORDS.clear();
    REGION_WORDS.set(name, words);
  }
  return words;
}

/** The words of every name that stands for a region the place lies in. */
function regionNames(place: GazetteerPlace): (readonly string[])[] {
  const names = [
    wordsOfRegion(place.admin2),
    wordsOfRegion(place.admin1),
    wordsOfRegion(place.country),
    wordsOfRegion(place.countryCode),
    ...(COUNTRY_ALIASES[place.countryCode] ?? []).map(wordsOfRegion),
  ];
  // "IL" stands for Illinois; a code of digits stands for nothing a person types.
  if (/^[A-Za-z]{2,3}$/.test(place.admin1Code)) names.push(wordsOfRegion(place.admin1Code));
  return names;
}

function fitsWords(typed: readonly string[], words: readonly string[]): boolean {
  return typed.every((part) => words.some((word) => word.startsWith(part)));
}

/**
 * Whether every region typed after the first comma fits the place. A region
 * fits when each of its words starts a word of the place's county, state,
 * province or country, or of a usual short form of one ("IL", "USA").
 */
export function fitsRegions(place: GazetteerPlace, regions: readonly string[]): boolean {
  if (regions.length === 0) return true;
  const names = regionNames(place);
  // Many files repeat the town where the county should stand:
  // "Ames, Ames, Story, Iowa". The place's own name is folded only
  // when no region fits, since every place has another one.
  let own: string[] | undefined;
  return regions.every((region) => {
    const typed = regionWords(region);
    if (typed.length === 0) return true;
    if (names.some((words) => fitsWords(typed, words))) return true;
    own ??= regionWords(foldPlace(place.name));
    return fitsWords(typed, own);
  });
}

/**
 * Shorter forms of a folded name under which a place is also looked up: the
 * name without the words that say what kind of place it is. GeoNames calls a
 * township "Township of Monroe" and a county "Sangamon County"; people type
 * "Monroe" and "Sangamon".
 */
export function placeNameVariants(folded: string): string[] {
  const variants = new Set<string>();
  const front = folded.replace(
    /^(?:(?:charter )?township|city|town|village|borough|municipality|county) of /,
    '',
  );
  if (front !== folded) variants.add(front);
  const start = folded.replace(/^(?:gemeente|county) /, '');
  if (start !== folded) variants.add(start);
  const end = folded.replace(/ (?:county|township|parish)$/, '');
  if (end !== folded) variants.add(end);
  variants.delete('');
  return [...variants];
}

export interface GazetteerHit {
  place: GazetteerPlace;
  /** The folded name that was found, which may be another name of the place. */
  folded: string;
  /** Whether that name is another name of the place, not its main one. */
  alternate: boolean;
}

/**
 * How well a gazetteer entry answers what was typed; a higher score comes
 * first. The whole name typed, not only its start, weighs most. After that
 * count the number of people who live there, whether the name is the place's
 * main name or another of its names, and whether its country is one of the
 * region priority.
 */
export function scoreGazetteerHit(
  hit: GazetteerHit,
  query: PlaceQuery,
  priority: readonly string[] = REGION_PRIORITY,
): number {
  let score = 0;
  if (hit.folded === query.name) score += 1000;
  // Less than a large town weighs, so that "Bombay" still finds Mumbai first.
  if (!hit.alternate) score += 150;
  const rank = priority.indexOf(hit.place.countryCode);
  if (rank !== -1) score += 100 - Math.min(rank, 9) * 10;
  score += Math.log10(Math.max(hit.place.population, 0) + 1) * 60;
  const { featureClass, featureCode: code } = hit.place;
  if (code === 'PPLC') score += 60;
  else if (code === 'PPLA' || code === 'ADM1') score += 40;
  else if (code === 'PPLA2') score += 20;
  // A part of a town, or a place that is no more, comes after the town itself.
  else if (code === 'PPLX' || code === 'PPLH' || code === 'PPLQ' || code === 'PPLW') score -= 40;
  // A municipality or a county comes after the town it is named after.
  else if (featureClass === 'A' && !/^(PCL|TERR)/.test(code)) score -= 120;
  return score;
}

/**
 * How well a place of the tree fits what was typed, both given folded: 2 when
 * its text starts with it, 1 when every word typed starts a word of the
 * place ("spring ill" fits "Springfield, Sangamon County, Illinois"), else 0.
 */
export function fitsTypedPlace(foldedPlace: string, foldedTyped: string): 0 | 1 | 2 {
  if (foldedTyped === '') return 0;
  if (foldedPlace.startsWith(foldedTyped)) return 2;
  const words = foldedPlace.split(' ');
  const fits = foldedTyped
    .split(' ')
    .every((typed) => words.some((word) => word.startsWith(typed)));
  return fits ? 1 : 0;
}

/** Latitude and longitude as a person reads them: "39.80° N, 89.64° W". */
export function formatCoordinates(lat: number, lon: number): string {
  const part = (value: number, positive: string, negative: string) =>
    `${Math.abs(value).toFixed(2)}° ${value < 0 ? negative : positive}`;
  return `${part(lat, 'N', 'S')}, ${part(lon, 'E', 'W')}`;
}
