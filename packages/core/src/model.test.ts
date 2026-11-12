import { describe, expect, it } from 'vitest';
import { formatLifespan, formatName } from './model';

describe('formatName', () => {
  it('joins the parts that are present, with the nickname in quotes', () => {
    expect(
      formatName({
        prefix: 'Dr.',
        given: 'John',
        nickname: 'Jack',
        surname: 'Smith',
        suffix: 'Jr.',
      }),
    ).toBe('Dr. John "Jack" Smith Jr.');
    expect(formatName({ given: 'Ada', surname: 'Lovelace' })).toBe('Ada Lovelace');
    expect(formatName({ given: '', surname: 'Smith' })).toBe('Smith');
    expect(formatName({})).toBe('');
  });
});

describe('formatLifespan', () => {
  it('shows both years, or says which one is known', () => {
    expect(formatLifespan('1850', '1921')).toBe('1850–1921');
    expect(formatLifespan('c. 1850', 'bef. 1921')).toBe('c. 1850–bef. 1921');
    expect(formatLifespan('1850', '')).toBe('b. 1850');
    expect(formatLifespan('', '1921')).toBe('d. 1921');
    expect(formatLifespan('', '')).toBe('');
  });
});
