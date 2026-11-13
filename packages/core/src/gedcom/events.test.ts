import { describe, expect, it } from 'vitest';
import { conformEvent, isEventTag, patchEvent, readEvent, type EventFields } from './events';
import { fresh, ged, one, show } from './testing';

const event = (fields: Partial<EventFields>): EventFields => ({
  type: 'birth',
  date: '',
  place: '',
  description: '',
  note: '',
  ...fields,
});

describe('readEvent', () => {
  it('reads the standard events of a person', () => {
    const birth = one(ged('1 BIRT', '2 DATE 12 MAR 1881', '2 PLAC Boston, Massachusetts'));
    expect(readEvent(birth, 'person')).toEqual(
      event({ date: '12 MAR 1881', place: 'Boston, Massachusetts' }),
    );
    expect(readEvent(one('1 DEAT Y'), 'person')).toEqual(event({ type: 'death' }));
    expect(readEvent(one('1 CHR'), 'person')?.type).toBe('christening');
    expect(readEvent(one('1 BAPM'), 'person')?.type).toBe('baptism');
  });

  it('reads the value of an attribute as its description', () => {
    expect(readEvent(one(ged('1 OCCU Farmer', '2 DATE 1900')), 'person')).toEqual(
      event({ type: 'occupation', date: '1900', description: 'Farmer' }),
    );
    // Ancestry writes details on the line of a residence.
    expect(readEvent(one('1 RESI Age: 19; Relation to Head of House: Son'), 'person')).toEqual(
      event({ type: 'residence', description: 'Age: 19; Relation to Head of House: Son' }),
    );
  });

  it('reads text on the line of an event as its description, as Ancestry writes it', () => {
    expect(readEvent(one('1 DEAT Age: 79'), 'person')?.description).toBe('Age: 79');
  });

  it('takes the type of a generic event from its TYPE line', () => {
    expect(
      readEvent(one(ged('1 EVEN', '2 TYPE Military Service', '2 DATE 1917')), 'person'),
    ).toEqual(event({ type: 'military service', date: '1917' }));
    expect(readEvent(one(ged('1 FACT Blue', '2 TYPE Eye colour')), 'person')).toEqual(
      event({ type: 'eye colour', description: 'Blue' }),
    );
    expect(readEvent(one('1 EVEN'), 'person')?.type).toBe('event');
    expect(readEvent(one('1 FACT x'), 'person')?.type).toBe('fact');
  });

  it("reads other programs' own event tags", () => {
    expect(readEvent(one(ged('1 _MILT', '2 DATE 1917')), 'person')).toEqual(
      event({ type: 'military', date: '1917' }),
    );
    expect(readEvent(one('1 _SEPR'), 'family')?.type).toBe('separation');
  });

  it('knows which tags belong to a person and which to a couple', () => {
    expect(readEvent(one('1 MARR'), 'family')?.type).toBe('marriage');
    expect(readEvent(one('1 MARR'), 'person')).toBeNull();
    expect(readEvent(one('1 BIRT'), 'family')).toBeNull();
    expect(readEvent(one('1 CENS'), 'family')?.type).toBe('census');
    expect(readEvent(one('1 SOUR @S1@'), 'person')).toBeNull();
    expect(isEventTag('EVEN', 'family')).toBe(true);
    expect(isEventTag('NAME', 'person')).toBe(false);
  });

  it('reads a 7.0 date that is only a phrase', () => {
    const node = one(ged('1 BIRT', '2 DATE', '3 PHRASE around harvest time'), '7.0');
    expect(readEvent(node, 'person')?.date).toBe('around harvest time');
    const both = one(ged('1 BIRT', '2 DATE 1881', '3 PHRASE as on the stone'), '7.0');
    expect(readEvent(both, 'person')?.date).toBe('1881');
  });
});

describe('patchEvent', () => {
  it('writes a new event', () => {
    const birth = patchEvent(
      null,
      event({ date: '12 March 1881', place: 'Boston' }),
      'person',
      '5.5.1',
    );
    expect(fresh(birth)).toBe(ged('1 BIRT', '2 DATE 12 MAR 1881', '2 PLAC Boston'));
    expect(fresh(patchEvent(null, event({ type: 'death' }), 'person', '5.5.1'))).toBe('1 DEAT Y');
    expect(
      fresh(
        patchEvent(null, event({ type: 'occupation', description: 'Farmer' }), 'person', '7.0'),
      ),
    ).toBe('1 OCCU Farmer');
    expect(
      fresh(patchEvent(null, event({ type: 'marriage', date: '1875' }), 'family', '7.0')),
    ).toBe(ged('1 MARR', '2 DATE 1875'));
  });

  it('writes an event the standard has no tag for as EVEN with a TYPE line', () => {
    const node = patchEvent(null, event({ type: 'military', date: '1917' }), 'person', '5.5.1');
    expect(fresh(node)).toBe(ged('1 EVEN', '2 TYPE Military', '2 DATE 1917'));
    expect(readEvent(node, 'person')).toEqual(event({ type: 'military', date: '1917' }));
    // A couple has no birth, so for a family that type is a generic event too.
    expect(fresh(patchEvent(null, event({ type: 'birth' }), 'family', '5.5.1'))).toBe(
      ged('1 EVEN', '2 TYPE Birth'),
    );
  });

  it('writes a date the app cannot read as a date phrase', () => {
    const five = patchEvent(null, event({ date: 'after the war' }), 'person', '5.5.1');
    expect(fresh(five)).toBe(ged('1 BIRT', '2 DATE (after the war)'));
    const seven = patchEvent(null, event({ date: 'after the war' }), 'person', '7.0');
    expect(fresh(seven, '7.0')).toBe(ged('1 BIRT', '2 DATE', '3 PHRASE after the war'));
    expect(readEvent(seven, 'person')?.date).toBe('after the war');
  });

  it('reads back what it wrote', () => {
    const cases: [EventFields, 'person' | 'family'][] = [
      [event({}), 'person'],
      [event({ type: 'death', date: 'ABT 1900', place: 'Paris, France' }), 'person'],
      [event({ type: 'occupation', description: 'Farmer' }), 'person'],
      [event({ type: 'residence', date: '1900', description: 'Age: 19' }), 'person'],
      [event({ type: 'shipwreck', date: '1850', description: 'Survived' }), 'person'],
      [event({ type: 'marriage', date: '1 JUN 1875', place: 'York' }), 'family'],
      [event({ type: 'separation' }), 'family'],
    ];
    for (const [fields, owner] of cases) {
      const written = fresh(patchEvent(null, fields, owner, '5.5.1'));
      expect(readEvent(one(written), owner), written).toEqual(fields);
    }
  });

  const imported = ged(
    '1 BIRT',
    '2 DATE 12 Mar 1881',
    '2 PLAC Boston, Suffolk, Massachusetts, USA',
    '3 MAP',
    '4 LATI N42.36',
    '4 LONG W71.06',
    '2 SOUR @S1@',
    '3 PAGE Year: 1900; Census Place: Boston',
    '3 _APID 1,7602::12345',
    '2 NOTE Born at home.',
  );

  it('leaves an event that has not changed exactly as it was imported', () => {
    const original = one(imported);
    const was = readEvent(original, 'person');
    if (!was) throw new Error('not an event');
    expect(show(patchEvent(original, was, 'person', '5.5.1'))).toBe(imported);
  });

  it('rewrites only the line that changed and keeps sources, notes and the rest', () => {
    const original = one(imported);
    const was = readEvent(original, 'person');
    if (!was) throw new Error('not an event');

    const dated = patchEvent(original, { ...was, date: '13 March 1881' }, 'person', '5.5.1');
    expect(show(dated)).toBe(imported.replace('2 DATE 12 Mar 1881', '2 DATE 13 MAR 1881'));

    const moved = patchEvent(original, { ...was, place: 'Salem' }, 'person', '5.5.1');
    expect(show(moved)).toBe(
      imported.replace('2 PLAC Boston, Suffolk, Massachusetts, USA', '2 PLAC Salem'),
    );

    const undated = patchEvent(original, { ...was, date: '' }, 'person', '5.5.1');
    expect(show(undated)).toBe(imported.replace('2 DATE 12 Mar 1881\n', ''));

    const described = patchEvent(original, { ...was, description: 'At home' }, 'person', '5.5.1');
    expect(show(described)).toBe(imported.replace('1 BIRT', '1 BIRT At home'));
  });

  it('adds a date or place that the imported event did not have, before its other lines', () => {
    const original = one(ged('1 DEAT', '2 SOUR @S1@', '2 PLAC Boston'));
    const was = readEvent(original, 'person');
    if (!was) throw new Error('not an event');
    expect(show(patchEvent(original, { ...was, date: '1950' }, 'person', '5.5.1'))).toBe(
      ged('1 DEAT', '2 DATE 1950', '2 SOUR @S1@', '2 PLAC Boston'),
    );
  });

  it('changes the tag when the type changes', () => {
    const generic = one(ged('1 EVEN', '2 TYPE Arrival', '2 DATE 1900'));
    const was = readEvent(generic, 'person');
    if (!was) throw new Error('not an event');
    expect(was.type).toBe('arrival');
    expect(show(patchEvent(generic, { ...was, type: 'immigration' }, 'person', '5.5.1'))).toBe(
      ged('1 IMMI', '2 DATE 1900'),
    );
    expect(show(patchEvent(generic, { ...was, type: 'landing' }, 'person', '5.5.1'))).toBe(
      ged('1 EVEN', '2 TYPE Landing', '2 DATE 1900'),
    );

    const birth = one(ged('1 BIRT', '2 DATE 1881'));
    expect(show(patchEvent(birth, event({ type: 'found', date: '1881' }), 'person', '5.5.1'))).toBe(
      ged('1 EVEN', '2 TYPE Found', '2 DATE 1881'),
    );
  });

  it("keeps another program's tag while the event's type stays the same", () => {
    const original = one(ged('1 _MILT', '2 DATE 1917'));
    const was = readEvent(original, 'person');
    if (!was) throw new Error('not an event');
    expect(show(patchEvent(original, { ...was, place: 'France' }, 'person', '5.5.1'))).toBe(
      ged('1 _MILT', '2 DATE 1917', '2 PLAC France'),
    );
  });

  it('in 7.0 moves a description on an event line into a note, where 7.0 allows it', () => {
    const node = patchEvent(null, event({ date: '1881', description: 'At home' }), 'person', '7.0');
    expect(fresh(node, '7.0')).toBe(ged('1 BIRT', '2 DATE 1881', '2 NOTE At home'));
    // In 5.5.1 it stays on the line, which is how Ancestry writes it.
    const five = patchEvent(
      null,
      event({ date: '1881', description: 'At home' }),
      'person',
      '5.5.1',
    );
    expect(fresh(five)).toBe(ged('1 BIRT At home', '2 DATE 1881'));
    // An attribute has room for text in both versions.
    const attribute = patchEvent(
      null,
      event({ type: 'religion', description: 'Quaker' }),
      'person',
      '7.0',
    );
    expect(fresh(attribute, '7.0')).toBe('1 RELI Quaker');
  });
});

describe('conformEvent', () => {
  it('leaves valid 7.0 events and every 5.5.1 event alone', () => {
    const flagged = one('1 DEAT Y', '7.0');
    conformEvent(flagged, 'person', '7.0');
    expect(show(flagged, '7.0')).toBe('1 DEAT Y');

    const five = one('1 DEAT Age: 79');
    conformEvent(five, 'person', '5.5.1');
    expect(show(five)).toBe('1 DEAT Age: 79');

    const seven = one('1 DEAT Age: 79', '7.0');
    conformEvent(seven, 'person', '7.0');
    expect(show(seven, '7.0')).toBe(ged('1 DEAT', '2 NOTE Age: 79'));
  });
});
