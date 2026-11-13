import type {
  ExternalRecord,
  Page,
  PageRequest,
  PersonQuery,
  PersonRecord,
  TextQuery,
  TextRecord,
} from '@rulz/core';
import type { ConnectorManifest } from './manifest';

/**
 * What every source that can be searched offers. A connector is made with the
 * client of its source (see `http.ts`) and reads the source's answers into
 * the shapes of `@rulz/core`. A source offers the searches it has: one that
 * keeps people is asked for a person, one that keeps newspapers or books for
 * words. Later parts add the reading of one record and of a person's relatives.
 */
export interface SourceConnector {
  readonly manifest: ConnectorManifest;
  /** Looks for records of a person. Rejects with an `HttpError` or a `ConnectorError`. */
  searchPersons?(
    query: PersonQuery,
    page: PageRequest,
    options?: SearchOptions,
  ): Promise<SearchAnswer>;
  /** Looks for texts that have some words. Rejects with an `HttpError` or a `ConnectorError`. */
  searchTexts?(query: TextQuery, page: PageRequest, options?: SearchOptions): Promise<SearchAnswer>;
}

/** A source that is asked for a person. */
export interface PersonConnector extends SourceConnector {
  searchPersons(
    query: PersonQuery,
    page: PageRequest,
    options?: SearchOptions,
  ): Promise<SearchAnswer<PersonRecord>>;
}

/** A source that is asked for words. */
export interface TextConnector extends SourceConnector {
  searchTexts(
    query: TextQuery,
    page: PageRequest,
    options?: SearchOptions,
  ): Promise<SearchAnswer<TextRecord>>;
}

export interface SearchOptions {
  /** Gives the search up. */
  signal?: AbortSignal;
  /**
   * Called just before a request is sent, which can be a while after the
   * search was asked for. Throws when the search may no longer be sent.
   */
  beforeSend?: () => void;
}

export interface SearchAnswer<R extends ExternalRecord = ExternalRecord> {
  page: Page<R>;
  /** When the source gave this answer, in Unix milliseconds. */
  fetchedAt: number;
  /** True when the answer was kept from an earlier search and nothing was sent. */
  cached: boolean;
}

/** A source answered, but not with what its connector can read, or it refused the question. */
export class ConnectorError extends Error {
  readonly kind: 'format' | 'refused';

  constructor(kind: 'format' | 'refused', message: string) {
    super(message);
    this.name = 'ConnectorError';
    this.kind = kind;
  }
}

/**
 * A text of a source, made safe to show and to keep: control characters go,
 * runs of white space become one space, and a very long text is cut. Anything
 * that is not a text gives an empty one.
 */
export function cleanText(value: unknown, max = 200): string {
  if (typeof value !== 'string') return '';
  const text = value
    .replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}
