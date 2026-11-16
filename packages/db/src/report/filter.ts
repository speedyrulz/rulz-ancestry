import { LIVING_REF, shownPerson, formatLifespan, formatName, type PersonRef } from '@rulz/core';
import { getPersonSummary } from '../search';
import { TreeRuleError, type Tree } from '../tree';

/**
 * The living filter every report is built through. A builder is handed one of
 * these and reads nothing about a person without asking it first, so a report
 * cannot leave the question out: {@link ReportPrivacy} has no default.
 */

/** The report cannot be made as asked; the message says why and is shown to the person who asked. */
export class ReportRefusedError extends TreeRuleError {
  constructor(message: string) {
    super(message);
    this.name = 'ReportRefusedError';
  }
}

/** What decides who is left out of a report. Both parts must be given. */
export interface ReportPrivacy {
  /** The people who may be living, from `presumedLivingIds`. */
  readonly livingIds: ReadonlySet<string>;
  /** True keeps living people in the report in full; false shows them only as "Living". */
  readonly includeLiving: boolean;
}

/** What a report is told about what it left out. */
export interface ReportOmissions {
  /** People who are in the report only as "Living". */
  livingOmitted: number;
  /** Notes of people and events that are shown, left out because they may name someone living. */
  notesOmitted: number;
  /** Transcriptions of citations that are shown, left out for the same reason. */
  citationTextsOmitted: number;
  /** Pictures and documents of what is shown, left out for the same reason. */
  mediaOmitted: number;
}

export class ReportFilter {
  readonly includeLiving: boolean;
  readonly #livingIds: ReadonlySet<string>;
  readonly #livingShown = new Set<string>();
  readonly #media = new Set<string>();
  #notes = 0;
  #livingPlaces = 0;
  #citationTexts = 0;

  constructor(privacy: ReportPrivacy) {
    this.includeLiving = privacy.includeLiving;
    this.#livingIds = privacy.livingIds;
  }

  /** True when nothing about this person may be read into the report. */
  hides(personId: string): boolean {
    return !this.includeLiving && this.#livingIds.has(personId);
  }

  /**
   * The person as the report prints them: "Living" when the filter hides
   * them (and nothing else of them is read), otherwise their name and years.
   */
  person(tree: Tree, personId: string): PersonRef {
    if (this.hides(personId)) {
      this.#livingShown.add(personId);
      return LIVING_REF;
    }
    const summary = getPersonSummary(tree, personId);
    if (summary === null) return shownPerson('');
    return shownPerson(
      summary.name === null ? '' : formatName(summary.name),
      formatLifespan(summary.birth?.year ?? '', summary.death?.year ?? ''),
    );
  }

  /** A note of something that is shown. It is printed only when living people are included. */
  note(text: string): string {
    if (text === '') return '';
    if (this.includeLiving) return text;
    this.#notes += 1;
    return '';
  }

  /** The transcription of a citation that is shown, kept or left out in the same way. */
  citationText(text: string): string {
    if (text === '') return '';
    if (this.includeLiving) return text;
    this.#citationTexts += 1;
    return '';
  }

  /** A picture or document of something that is shown; each counts once. */
  media(mediaId: string): boolean {
    if (this.includeLiving) return true;
    this.#media.add(mediaId);
    return false;
  }

  /**
   * Counts one place of the report that says "Living" (a row, a box). A report
   * in which one person can stand in several places counts these, not the people:
   * the number of people would say that two "Living" places are one person.
   */
  countLivingPlace(personId: string): void {
    if (this.hides(personId)) this.#livingPlaces += 1;
  }

  /** The places counted with {@link countLivingPlace}. */
  get livingPlaces(): number {
    return this.#livingPlaces;
  }

  omissions(): ReportOmissions {
    return {
      livingOmitted: this.#livingShown.size,
      notesOmitted: this.#notes,
      citationTextsOmitted: this.#citationTexts,
      mediaOmitted: this.#media.size,
    };
  }
}
