import { describe, expect, it } from 'vitest';
import {
  fitsRegions,
  fitsTypedPlace,
  foldPlace,
  formatCoordinates,
  formatGazetteerPlace,
  isLatinFolded,
  parsePlaceQuery,
  placeNameVariants,
  placeParts,
  scoreGazetteerHit,
  type GazetteerPlace,
} from './place';

function place(fields: Partial<GazetteerPlace>): GazetteerPlace {
  return {
    geonameId: 1,
    name: 'Springfield',
    featureClass: 'P',
    featureCode: 'PPL',
    countryCode: 'US',
    country: 'United States',
    admin1: 'Illinois',
    admin1Code: 'IL',
    admin2: 'Sangamon County',
    lat: 39.8,
    lon: -89.64,
    population: 116_250,
    ...fields,
  };
}

const YORK = place({
  name: 'York',
  countryCode: 'GB',
  country: 'United Kingdom',
  admin1: 'England',
  admin1Code: 'ENG',
  admin2: 'York',
  population: 153_717,
});

describe('foldPlace', () => {
  it('takes away case, accents and punctuation', () => {
    expect(foldPlace('  Zürich ')).toBe('zurich');
    expect(foldPlace("'s-Gravenhage")).toBe('s gravenhage');
    expect(foldPlace('Saint-Étienne-du-Rouvray')).toBe('saint etienne du rouvray');
    expect(foldPlace("Coeur d'Alene")).toBe('coeur dalene');
    expect(foldPlace('Coeur d’Alene')).toBe('coeur dalene');
    expect(foldPlace('Springfield, Illinois,  USA')).toBe('springfield illinois usa');
  });

  it('writes letters that have no accent to take away in plain letters', () => {
    expect(foldPlace('Łódź')).toBe('lodz');
    expect(foldPlace('Tromsø')).toBe('tromso');
    expect(foldPlace('Weißenburg')).toBe('weissenburg');
    expect(foldPlace('Ærøskøbing')).toBe('aeroskobing');
  });

  it('gives nothing for text without a letter or a digit', () => {
    expect(foldPlace('')).toBe('');
    expect(foldPlace(' ,-/ ')).toBe('');
  });

  it('tells Latin names from names in other scripts', () => {
    expect(isLatinFolded(foldPlace('Köln'))).toBe(true);
    expect(isLatinFolded(foldPlace('Москва'))).toBe(false);
    expect(isLatinFolded(foldPlace('東京'))).toBe(false);
    expect(isLatinFolded('')).toBe(false);
  });
});

describe('placeParts', () => {
  it('splits a place at its commas and drops the empty parts', () => {
    expect(placeParts('Springfield, Sangamon, Illinois, USA')).toEqual([
      'Springfield',
      'Sangamon',
      'Illinois',
      'USA',
    ]);
    expect(placeParts(', , Iowa,')).toEqual(['Iowa']);
    expect(placeParts('')).toEqual([]);
  });
});

describe('formatGazetteerPlace', () => {
  it('writes a town of the United States with its county, state and "USA"', () => {
    expect(formatGazetteerPlace(place({}))).toBe('Springfield, Sangamon County, Illinois, USA');
  });

  it('leaves out a county that is not known', () => {
    expect(
      formatGazetteerPlace(place({ name: 'New York City', admin1: 'New York', admin2: '' })),
    ).toBe('New York City, New York, USA');
  });

  it('writes a state and a county without repeating them', () => {
    expect(
      formatGazetteerPlace(
        place({ name: 'Illinois', featureClass: 'A', featureCode: 'ADM1', admin2: '' }),
      ),
    ).toBe('Illinois, USA');
    expect(
      formatGazetteerPlace(
        place({ name: 'Sangamon County', featureClass: 'A', featureCode: 'ADM2' }),
      ),
    ).toBe('Sangamon County, Illinois, USA');
    expect(
      formatGazetteerPlace(
        place({ name: 'Township of Auburn', featureClass: 'A', featureCode: 'ADM3' }),
      ),
    ).toBe('Township of Auburn, Sangamon County, Illinois, USA');
  });

  it('ends a place of the United Kingdom with its country within the kingdom', () => {
    expect(formatGazetteerPlace(YORK)).toBe('York, England');
    expect(formatGazetteerPlace({ ...YORK, name: 'Haxby', admin2: 'York' })).toBe(
      'Haxby, York, England',
    );
    expect(
      formatGazetteerPlace({
        ...YORK,
        name: 'England',
        featureClass: 'A',
        featureCode: 'ADM1',
        admin2: '',
      }),
    ).toBe('England');
  });

  it('writes a Dutch place with its province, and an Irish one with its county', () => {
    expect(
      formatGazetteerPlace(
        place({
          name: 'Amsterdam',
          countryCode: 'NL',
          country: 'The Netherlands',
          admin1: 'North Holland',
          admin1Code: '07',
          admin2: 'Gemeente Amsterdam',
        }),
      ),
    ).toBe('Amsterdam, North Holland, Netherlands');
    expect(
      formatGazetteerPlace(
        place({
          name: 'Kinsale',
          countryCode: 'IE',
          country: 'Ireland',
          admin1: 'Munster',
          admin1Code: 'M',
          admin2: 'County Cork',
        }),
      ),
    ).toBe('Kinsale, County Cork, Ireland');
  });

  it('writes a country by its usual name', () => {
    const country = { featureClass: 'A', featureCode: 'PCLI', admin1: '', admin2: '' };
    expect(formatGazetteerPlace(place({ ...country, name: 'United States' }))).toBe('USA');
    expect(
      formatGazetteerPlace(
        place({ ...country, name: 'France', countryCode: 'FR', country: 'France' }),
      ),
    ).toBe('France');
  });

  it('writes a place whose regions are not known with what there is', () => {
    expect(
      formatGazetteerPlace(
        place({ name: 'Nowhere', countryCode: '', country: '', admin1: '', admin2: '' }),
      ),
    ).toBe('Nowhere');
  });
});

describe('parsePlaceQuery', () => {
  it('reads the name and the regions after it', () => {
    expect(parsePlaceQuery('Springf')).toEqual({ name: 'springf', regions: [] });
    expect(parsePlaceQuery('Springfield, Sangamon , ill')).toEqual({
      name: 'springfield',
      regions: ['sangamon', 'ill'],
    });
    expect(parsePlaceQuery('York,')).toEqual({ name: 'york', regions: [] });
  });

  it('has nothing to search with for less than two letters', () => {
    expect(parsePlaceQuery('')).toBeNull();
    expect(parsePlaceQuery('S')).toBeNull();
    expect(parsePlaceQuery(' , Illinois')).toBeNull();
  });
});

describe('fitsRegions', () => {
  it('takes a county, a state, a country or a usual short form', () => {
    const springfield = place({});
    expect(fitsRegions(springfield, [])).toBe(true);
    expect(fitsRegions(springfield, ['sangamon'])).toBe(true);
    expect(fitsRegions(springfield, ['sangamon county', 'illinois', 'usa'])).toBe(true);
    expect(fitsRegions(springfield, ['il'])).toBe(true);
    expect(fitsRegions(springfield, ['ill'])).toBe(true);
    expect(fitsRegions(springfield, ['united states'])).toBe(true);
    expect(fitsRegions(springfield, ['missouri'])).toBe(false);
    expect(fitsRegions(springfield, ['illinois', 'canada'])).toBe(false);
  });

  it('knows England, and the United Kingdom by several names', () => {
    expect(fitsRegions(YORK, ['england'])).toBe(true);
    expect(fitsRegions(YORK, ['uk'])).toBe(true);
    expect(fitsRegions(YORK, ['great britain'])).toBe(true);
    expect(fitsRegions(YORK, ['scotland'])).toBe(false);
  });

  it('does not mind the words that say what kind of region it is', () => {
    const lincoln = place({
      name: 'Lincoln',
      admin1: 'Nebraska',
      admin1Code: 'NE',
      admin2: 'City of Lincoln',
    });
    expect(fitsRegions(lincoln, ['lincoln city', 'nebraska'])).toBe(true);
    expect(fitsRegions(lincoln, ['lincoln independent city', 'ne'])).toBe(true);
    expect(fitsRegions(place({}), ['county'])).toBe(true);
    const kinsale = place({ countryCode: 'IE', country: 'Ireland', admin2: 'County Cork' });
    expect(fitsRegions(kinsale, ['cork'])).toBe(true);
    expect(fitsRegions(kinsale, ['co cork'])).toBe(true);
    expect(fitsRegions(kinsale, ['co kerry'])).toBe(false);
  });

  it('takes the name of the place itself where a region should stand', () => {
    // "Ames, Ames, Story, Iowa, USA"
    const ames = place({
      name: 'Ames',
      admin1: 'Iowa',
      admin1Code: 'IA',
      admin2: 'Story County',
    });
    expect(fitsRegions(ames, ['ames', 'story', 'iowa', 'usa'])).toBe(true);
    expect(fitsRegions(ames, ['nevada', 'story', 'iowa'])).toBe(false);
  });

  it('does not take a division code of digits for something typed', () => {
    const amsterdam = place({ countryCode: 'NL', country: 'The Netherlands', admin1Code: '07' });
    expect(fitsRegions(amsterdam, ['07'])).toBe(false);
    expect(fitsRegions(amsterdam, ['holland'])).toBe(true);
  });
});

describe('placeNameVariants', () => {
  it('gives the name without the words that say what kind of place it is', () => {
    expect(placeNameVariants('township of monroe')).toEqual(['monroe']);
    expect(placeNameVariants('charter township of nevada')).toEqual(['nevada']);
    expect(placeNameVariants('city of lincoln')).toEqual(['lincoln']);
    expect(placeNameVariants('sangamon county')).toEqual(['sangamon']);
    expect(placeNameVariants('county cork')).toEqual(['cork']);
    expect(placeNameVariants('gemeente amsterdam')).toEqual(['amsterdam']);
    expect(placeNameVariants('saint landry parish')).toEqual(['saint landry']);
  });

  it('gives nothing for a plain name', () => {
    expect(placeNameVariants('springfield')).toEqual([]);
    expect(placeNameVariants('new york city')).toEqual([]);
    expect(placeNameVariants('county')).toEqual([]);
  });
});

describe('scoreGazetteerHit', () => {
  const query = { name: 'york', regions: [] };
  const score = (fields: Partial<GazetteerPlace>, folded = 'york', alternate = false) =>
    scoreGazetteerHit({ place: place(fields), folded, alternate }, query);

  it('puts the whole name before a name that only starts with it', () => {
    expect(score({ name: 'York', population: 100 })).toBeGreaterThan(
      score({ name: 'Yorktown', population: 5_000_000 }, 'yorktown'),
    );
  });

  it('puts a main name before another name of a place', () => {
    expect(score({ population: 1000 })).toBeGreaterThan(score({ population: 1000 }, 'york', true));
  });

  it('puts the countries of the region priority first, in their order', () => {
    const us = score({ countryCode: 'US', population: 1000 });
    const gb = score({ countryCode: 'GB', population: 1000 });
    const fr = score({ countryCode: 'FR', population: 1000 });
    expect(us).toBeGreaterThan(gb);
    expect(gb).toBeGreaterThan(fr);
  });

  it('puts the larger of two like places first', () => {
    expect(score({ population: 50_000 })).toBeGreaterThan(score({ population: 500 }));
  });

  it('puts a large town found by an older name before a hamlet of that name', () => {
    const mumbai = score(
      { name: 'Mumbai', countryCode: 'IN', population: 12_691_836 },
      'york',
      true,
    );
    expect(mumbai).toBeGreaterThan(score({ population: 0 }));
  });

  it('puts a town before the county or the municipality named after it', () => {
    const town = score({ population: 43_992, featureCode: 'PPLA2' });
    const county = score({ population: 434_972, featureClass: 'A', featureCode: 'ADM2' });
    expect(town).toBeGreaterThan(county);
  });

  it('takes another order of countries when one is given', () => {
    const hit = (countryCode: string) => ({
      place: place({ countryCode }),
      folded: 'york',
      alternate: false,
    });
    expect(scoreGazetteerHit(hit('FR'), query, ['FR'])).toBeGreaterThan(
      scoreGazetteerHit(hit('US'), query, ['FR']),
    );
  });
});

describe('fitsTypedPlace', () => {
  const text = foldPlace('Springfield, Sangamon County, Illinois, USA');

  it('fits best when the place starts with what was typed', () => {
    expect(fitsTypedPlace(text, 'spring')).toBe(2);
    expect(fitsTypedPlace(text, foldPlace('Springfield, Sang'))).toBe(2);
  });

  it('fits when every word typed starts a word of the place', () => {
    expect(fitsTypedPlace(text, 'illinois')).toBe(1);
    expect(fitsTypedPlace(text, foldPlace('Spring, Ill'))).toBe(1);
  });

  it('does not fit otherwise', () => {
    expect(fitsTypedPlace(text, 'field')).toBe(0);
    expect(fitsTypedPlace(text, foldPlace('Spring, Iowa'))).toBe(0);
    expect(fitsTypedPlace(text, '')).toBe(0);
  });
});

describe('formatCoordinates', () => {
  it('writes north and south, east and west', () => {
    expect(formatCoordinates(39.8017, -89.6437)).toBe('39.80° N, 89.64° W');
    expect(formatCoordinates(-36.8485, 174.7633)).toBe('36.85° S, 174.76° E');
  });
});
