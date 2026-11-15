import type { AiActivityDetail, AiActivityEntry } from '@rulz/db';

/**
 * An entry of the activity log of the AI assistant, as a sentence for the
 * user. The log holds ids, what was asked, counts and outcomes (see
 * `aisession.ts` for what is written); this turns one entry into words.
 *
 * What is read here comes from app.db, a file that anything can have written
 * to. `@rulz/db` hands over a flat detail of cleaned values; here every value
 * is looked at for its kind once more, and one that is not what its entry
 * should hold is left out of the sentence. The page shows the sentence as
 * text and nothing else.
 */

/** How the people and the sources of an entry are called. */
export interface ActivityNames {
  /** A person by their id; the id is empty when the log holds none. */
  person(id: string): string;
  /** A source by its id. */
  source(id: string): string;
}

const text = (detail: AiActivityDetail, key: string): string => {
  const value = detail[key];
  return typeof value === 'string' ? value : '';
};

const count = (detail: AiActivityDetail, key: string): number => {
  const value = detail[key];
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
};

const year = (detail: AiActivityDetail, key: string): number | null => {
  const value = detail[key];
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 9999
    ? value
    : null;
};

const of = (number: number, one: string, many: string): string =>
  `${number.toLocaleString('en-US')} ${number === 1 ? one : many}`;

const ENDED: Readonly<Record<string, string>> = {
  stopped: 'you stopped it',
  page: 'the window of the app was loaded again',
  idle: 'no call came for a while',
  time: 'it lasted as long as a session may',
  quit: 'the app was closed',
  'tree-closed': 'the tree was closed',
  withdrawn: 'the assistant was turned off',
  replaced: 'another session was started',
  calls: 'it took all the calls it may take',
  log: 'the log could not be written',
};

/** Why a question was not sent, or what became of one that was; by what the session wrote as its outcome. */
const OUTCOMES: Readonly<Record<string, string>> = {
  'not-in-session': 'the session is not for this person, or does not ask this service',
  'not-given': 'nothing is given or asked for this person',
  budget: 'the session had no question left for this service',
  error: 'the search failed',
  dropped: 'the session ended meanwhile, and the answer was dropped',
  notice: 'a notice was not agreed to',
  living: 'the person may be living',
  gone: 'the person is no longer in the tree',
  changed: 'the name or the years of the person had changed',
  paused: 'the service asked to be left alone',
  offline: 'the service could not be reached',
  timeout: 'the service took too long',
  cancelled: 'the session ended first',
  key: 'the service needs a key',
  source: 'the service is not one a session asks',
  empty: 'there was no name to ask for',
  failed: 'the service did not answer in a way the app can read',
};

function outcomeWords(outcome: string): string {
  if (outcome.startsWith('query-')) {
    return 'the name or the years were too far from what the tree has for the person';
  }
  return OUTCOMES[outcome] ?? 'it failed';
}

const VERDICTS: Readonly<Record<string, string>> = {
  fits: 'is of',
  'may-fit': 'may be of',
  'does-not-fit': 'is not of',
};

const CONFIDENCES: Readonly<Record<string, string>> = {
  high: 'sure',
  medium: 'fairly sure',
  low: 'unsure',
};

/** What was asked of a source: the name, and the years where there are any. */
function askedWords(detail: AiActivityDetail): string {
  const name = `${text(detail, 'given')} ${text(detail, 'surname')}`.trim();
  const born = year(detail, 'birthYear');
  const died = year(detail, 'deathYear');
  return [
    name === '' ? 'no name' : `"${name}"`,
    born === null ? '' : `born ${born}`,
    died === null ? '' : `died ${died}`,
  ]
    .filter((part) => part !== '')
    .join(', ');
}

/** One entry in words. An entry that holds nothing this version knows gives a plain sentence. */
export function activityWords(entry: AiActivityEntry, names: ActivityNames): string {
  const { detail } = entry;
  const person = () => names.person(text(detail, 'person'));
  const source = () => names.source(text(detail, 'source'));
  switch (entry.kind) {
    case 'session-started': {
      const generations = count(detail, 'generations');
      const sources = text(detail, 'sources')
        .split(' ')
        .filter((id) => id !== '')
        .map((id) => names.source(id));
      return [
        `A session started for ${person()}`,
        generations === 0
          ? ''
          : ` and ${of(generations, 'generation', 'generations')} of their ancestors`,
        `: ${of(count(detail, 'people'), 'person', 'people')}.`,
        sources.length === 0 ? '' : ` It may ask ${sources.join(', ')}.`,
      ].join('');
    }
    case 'session-ended': {
      const why = ENDED[text(detail, 'why')];
      const programs = count(detail, 'programs');
      return [
        why === undefined ? 'The session ended.' : `The session ended: ${why}.`,
        ` ${of(count(detail, 'calls'), 'call', 'calls')},`,
        ` ${of(count(detail, 'questions'), 'question', 'questions')} to services,`,
        ` ${of(count(detail, 'proposals'), 'proposal', 'proposals')}.`,
        programs > 0 ? ` Programs connected to it ${of(programs, 'time', 'times')}.` : '',
      ].join('');
    }
    case 'sources-listed':
      return text(detail, 'tool') === 'get_session'
        ? 'The AI asked what the session is for.'
        : 'The AI asked which services it may ask.';
    case 'tree-searched': {
      const offset = count(detail, 'offset');
      return [
        `The AI searched the tree for "${text(detail, 'query')}"`,
        offset === 0 ? '' : `, from result ${(offset + 1).toLocaleString('en-US')} on`,
        `: ${of(count(detail, 'found'), 'person', 'people')} given.`,
      ].join('');
    }
    case 'person-read':
    case 'relatives-read': {
      const what = entry.kind === 'person-read' ? '' : 'the relatives of ';
      if (detail['given'] === true) return `The AI read ${what}${person()}.`;
      return text(detail, 'person') === ''
        ? `The AI asked for ${what}someone who is not in the tree. Nothing was given.`
        : `The AI asked for ${what}${person()}. Nothing was given: they may be living.`;
    }
    case 'records-searched': {
      const start = `The AI asked ${source()} for ${askedWords(detail)}, for ${person()}: `;
      const outcome = text(detail, 'outcome');
      const found = of(count(detail, 'found'), 'record', 'records');
      if (detail['sent'] === true) {
        return outcome === 'answered'
          ? `${start}${found} given.`
          : `${start}it was sent, and ${outcomeWords(outcome)}.`;
      }
      return outcome === 'answered'
        ? `${start}${found} given from an earlier answer. Nothing was sent.`
        : `${start}not sent, since ${outcomeWords(outcome)}.`;
    }
    case 'record-read': {
      const key = text(detail, 'key');
      if (key === '') return 'The AI asked for a record that it is not given.';
      return `The AI was given record ${key} of ${source()}, found for ${person()}${
        text(detail, 'by') === 'get' ? ', once more' : ''
      }.`;
    }
    case 'app-connected': {
      // The name is what the program called itself, and nothing checked it.
      const name = text(detail, 'name');
      const version = text(detail, 'version');
      return name === ''
        ? 'A program connected to the session. It gave no name.'
        : `A program connected to the session. It calls itself "${name}"${
            version === '' ? '' : ` (version ${version})`
          }.`;
    }
    case 'proposal-made': {
      if (detail['accepted'] !== true) {
        return 'A proposal of the AI was refused: it named no record of the session, or none of its reasons quoted the record.';
      }
      const verdict = VERDICTS[text(detail, 'verdict')] ?? 'may be of';
      const confidence = CONFIDENCES[text(detail, 'confidence')];
      return [
        `The AI proposed that record ${text(detail, 'key')} of ${source()} ${verdict} ${person()}`,
        confidence === undefined ? '' : `, and said it is ${confidence}`,
        `: ${of(count(detail, 'kept'), 'reason', 'reasons')} passed the check`,
        count(detail, 'dropped') === 0 ? '' : `, ${count(detail, 'dropped')} did not`,
        '.',
      ].join('');
    }
  }
}
