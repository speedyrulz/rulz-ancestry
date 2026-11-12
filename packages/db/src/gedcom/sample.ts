/**
 * Made-up GEDCOM files for tests. This file imports nothing, so the unit tests
 * and the end-to-end tests of the desktop app can both use it.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * A GEDCOM 5.5.1 file with `people` people, written the way Ancestry writes
 * its exports: its header, names with GIVN and SURN, source citations with
 * `_APID`, details on the line of a residence, `_FREL` and `_MREL` under each
 * child, dates in mixed case, and source, repository and media records at the
 * end. The content is made up, and is the same on every run.
 */
export function ancestryStyleFile(people: number): string {
  interface Person {
    sex: 'M' | 'F';
    generation: number;
    childOf: number | null;
    partnerIn: number | null;
  }
  interface Family {
    husband: number;
    wife: number;
    children: number[];
    generation: number;
  }
  const persons: Person[] = [];
  const families: Family[] = [];
  const addPerson = (sex: 'M' | 'F', generation: number, childOf: number | null): number => {
    persons.push({ sex, generation, childOf, partnerIn: null });
    return persons.length - 1;
  };
  const addFamily = (husband: number, wife: number, generation: number): void => {
    families.push({ husband, wife, children: [], generation });
    const index = families.length - 1;
    const first = persons[husband];
    const second = persons[wife];
    if (first) first.partnerIn = index;
    if (second) second.partnerIn = index;
  };

  addFamily(addPerson('M', 0, null), addPerson('F', 0, null), 0);
  for (let next = 0; persons.length < people; next += 1) {
    const family = families[next];
    if (!family) break;
    for (let child = 0; child < 3 && persons.length < people; child += 1) {
      const sex = (next + child) % 2 === 0 ? 'M' : 'F';
      const index = addPerson(sex, family.generation + 1, next);
      family.children.push(index);
      if (persons.length < people) {
        const spouse = addPerson(sex === 'M' ? 'F' : 'M', family.generation + 1, null);
        addFamily(
          sex === 'M' ? index : spouse,
          sex === 'M' ? spouse : index,
          family.generation + 1,
        );
      }
    }
  }

  const personXref = (index: number) => `@I${382_000_000_000 + index}@`;
  const familyXref = (index: number) => `@F${index + 1}@`;
  const place = (index: number) => `Town ${index % 97}, County ${index % 13}, State, USA`;
  const out: string[] = [
    '0 HEAD',
    '1 SUBM @SUBM1@',
    '1 SOUR Ancestry.com Family Trees',
    '2 NAME Ancestry.com Member Trees',
    '2 VERS 2025.08',
    '2 _TREE Example Family Tree',
    '3 RIN 123456789',
    '3 _ENV prd',
    '2 CORP Ancestry.com',
    '3 PHON 801-705-7000',
    '3 WWW www.ancestry.com',
    '3 ADDR 1300 West Traverse Parkway',
    '4 CONT Lehi, UT  84043',
    '4 CONT USA',
    '1 DATE 10 Nov 2026',
    '2 TIME 12:34:56',
    '1 GEDC',
    '2 VERS 5.5.1',
    '2 FORM LINEAGE-LINKED',
    '1 CHAR UTF-8',
    '0 @SUBM1@ SUBM',
    '1 NAME Ancestry.com Member Trees Submitter',
  ];

  persons.forEach((person, index) => {
    const year = 1700 + person.generation * 27 + (index % 9);
    const given = `${person.sex === 'M' ? 'John' : 'Mary'} ${String.fromCharCode(65 + (index % 26))}`;
    const surname = `Surname${index % 500}`;
    const citation = [
      `2 SOUR @S${1 + (index % 20)}@`,
      `3 PAGE Year: ${year + 20}; Census Place: ${place(index)}; Roll: ${index}`,
      `3 _APID 1,7602::${index}`,
    ];
    out.push(
      `0 ${personXref(index)} INDI`,
      `1 NAME ${given} /${surname}/`,
      `2 GIVN ${given}`,
      `2 SURN ${surname}`,
      ...citation,
      `1 SEX ${person.sex}`,
    );
    if (person.childOf !== null) out.push(`1 FAMC ${familyXref(person.childOf)}`);
    if (person.partnerIn !== null) out.push(`1 FAMS ${familyXref(person.partnerIn)}`);
    const style = index % 7;
    const birth =
      style === 0
        ? `abt ${year}`
        : style === 1
          ? `Bef. ${year}`
          : `${1 + (index % 28)} ${MONTHS[index % 12] ?? 'Jan'} ${year}`;
    out.push('1 BIRT', `2 DATE ${birth}`, `2 PLAC ${place(index)}`, ...citation);
    out.push(
      `1 RESI Age: ${20 + (index % 40)}; Marital Status: Married; Relation to Head of House: Head`,
      `2 DATE ${year + 30}`,
      `2 PLAC ${place(index + 1)}`,
    );
    if (year < 1930) {
      out.push(
        '1 DEAT',
        `2 DATE ${1 + (index % 28)} ${MONTHS[(index + 5) % 12] ?? 'Jan'} ${year + 60 + (index % 25)}`,
        `2 PLAC ${place(index + 2)}`,
      );
    }
    if (index % 10 === 0) out.push('1 OBJE @O1@');
  });

  families.forEach((family, index) => {
    out.push(
      `0 ${familyXref(index)} FAM`,
      `1 HUSB ${personXref(family.husband)}`,
      `1 WIFE ${personXref(family.wife)}`,
    );
    for (const child of family.children) {
      out.push(`1 CHIL ${personXref(child)}`, '2 _FREL Natural', '2 _MREL Natural');
    }
    out.push(
      '1 MARR',
      `2 DATE ${1 + (index % 28)} ${MONTHS[index % 12] ?? 'Jan'} ${1722 + family.generation * 27}`,
      `2 PLAC ${place(index)}`,
    );
  });

  for (let source = 1; source <= 20; source += 1) {
    out.push(
      `0 @S${source}@ SOUR`,
      `1 TITL ${1790 + source * 10} United States Federal Census`,
      '1 AUTH Ancestry.com',
      '1 PUBL Ancestry.com Operations Inc',
      '1 REPO @R1@',
      `1 _APID 1,${7600 + source}::0`,
    );
  }
  out.push(
    '0 @R1@ REPO',
    '1 NAME Ancestry.com',
    '0 @O1@ OBJE',
    '1 FILE https://example.com/media/portrait.jpg',
    '2 FORM jpg',
    '2 TITL Portrait',
    '0 TRLR',
    '',
  );
  return out.join('\r\n');
}
