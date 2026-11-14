import { cleanText, isOnSite, type ConnectorManifest } from '@rulz/connectors';
import type { ExternalRecord } from '@rulz/core';

/**
 * A result of a search as the optional AI assistant gets it.
 *
 * A record is passed on only when its source allows that (`mayShareWithAi`
 * of its manifest, which is absent until someone has read the source's terms
 * for it). What is passed on is a list of named texts, and nothing else of a
 * record is a text of its source. The check of a quote (`quote.ts`) looks in
 * exactly these texts, so a reason can quote only what was given.
 *
 * Every text is plain text of one line, as a connector made it, cleaned once
 * more and cut at a length. It is what a source says, and a source can say
 * anything: whoever reads it must take it as something to weigh and never as
 * an instruction.
 *
 * Whether a record is of someone who may be living is not looked at here. A
 * connector leaves such records out when it reads an answer of its source,
 * so only what a search of the app gave may be passed on through this. A
 * record that was kept in a tree and read back from its file is not such a
 * result: nothing looked at it again, and its texts are what the file holds.
 */

/** One text of a record, under the name of what it is. */
export interface SharedField {
  /** "title", "role", "birth date": see `sharedRecordOf`. */
  name: string;
  value: string;
}

export interface SharedRecord {
  /** The source's id, as in its manifest. */
  sourceId: string;
  sourceName: string;
  /** The credit line of the source, which goes with every record of it. */
  attribution: string;
  kind: ExternalRecord['kind'];
  /** What a source that keeps people says of a person's sex; null when it says nothing, or the record is no person. */
  sex: 'M' | 'F' | null;
  /** The record's page at the source. It is an address and no text of the record: it cannot be quoted. */
  url: string;
  /** The texts of the record, those that are empty left out. */
  fields: SharedField[];
}

export type Shared =
  | { ok: true; record: SharedRecord }
  | {
      ok: false;
      /**
       * `source-not-allowed`: the terms of the source were not read for this,
       * or do not allow it. `not-of-source`: the record does not name this
       * source, or its address is not on the source's site.
       */
      reason: 'source-not-allowed' | 'not-of-source';
      message: string;
    };

/**
 * True when what a source returns may be passed on to an AI service. A source
 * the app never fetches has nothing to pass on, and a source whose terms bar
 * keeping what it returns is not passed on either: what an AI quotes of a
 * record is kept with its proposal.
 */
export function mayShareWithAi(manifest: ConnectorManifest): boolean {
  return (
    manifest.mayShareWithAi === true &&
    manifest.tier !== 'deeplink' &&
    manifest.mayStoreText !== false
  );
}

const MAX = {
  title: 500,
  about: 1000,
  date: 100,
  place: 500,
  role: 200,
  event: 200,
  held: 500,
  by: 500,
};

/** The most births and deaths of one record that are passed on. */
const FACTS_MAX = 8;

/**
 * The record as it is passed on, or why it is not. The texts of a person are
 * "title" (their name), "about", and "birth date", "birth place", "death
 * date" and "death place" (a second birth of the same record is "birth date
 * 2"); of a record of an event "title", "role", "event", "date", "place" and
 * "held"; of a text "title", "date", "by" and "about".
 */
export function sharedRecordOf(record: ExternalRecord, manifest: ConnectorManifest): Shared {
  if (!mayShareWithAi(manifest)) {
    return {
      ok: false,
      reason: 'source-not-allowed',
      message: `Records of ${manifest.name} are not passed on to an AI assistant.`,
    };
  }
  if (record.connectorId !== manifest.id || !isOnSite(record.url, manifest)) {
    return {
      ok: false,
      reason: 'not-of-source',
      message: `This is not a record of ${manifest.name}.`,
    };
  }
  const fields: SharedField[] = [];
  const add = (name: string, value: unknown, max: number): void => {
    // One form of every letter, so that a quote can be found in it. Cutting a
    // text can leave half of a character at its end, which is taken off.
    const text = cleanText(value, max)
      .normalize('NFC')
      .replace(/\p{Cs}/gu, '');
    if (text !== '') fields.push({ name, value: text });
  };
  add('title', record.title, MAX.title);
  if (record.kind === 'person') {
    add('about', record.about, MAX.about);
    const seen = { birth: 0, death: 0 };
    for (const fact of record.facts.slice(0, FACTS_MAX)) {
      if (fact.type !== 'birth' && fact.type !== 'death') continue;
      seen[fact.type] += 1;
      const number = seen[fact.type] === 1 ? '' : ` ${seen[fact.type]}`;
      add(`${fact.type} date${number}`, fact.date, MAX.date);
      add(`${fact.type} place${number}`, fact.place, MAX.place);
    }
  } else if (record.kind === 'event') {
    add('role', record.role, MAX.role);
    add('event', record.event, MAX.event);
    add('date', record.date, MAX.date);
    add('place', record.place, MAX.place);
    add('held', record.held, MAX.held);
  } else {
    add('date', record.date, MAX.date);
    add('by', record.by, MAX.by);
    add('about', record.about, MAX.about);
  }
  return {
    ok: true,
    record: {
      sourceId: manifest.id,
      sourceName: manifest.name,
      attribution: manifest.attribution,
      kind: record.kind,
      sex:
        record.kind === 'person' && (record.sex === 'M' || record.sex === 'F') ? record.sex : null,
      url: record.url,
      fields,
    },
  };
}
