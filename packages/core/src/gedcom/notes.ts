import { makeNode, pointerTarget, touch, type GedcomNode } from './node';

/**
 * Notes: the user's own remarks on a person, an event, a source or a citation.
 *
 * A GEDCOM structure may carry any number of NOTE lines. A NOTE line either
 * holds its text itself or points at a note record that several structures
 * share (`1 NOTE @N1@`; in GEDCOM 7.0 `1 SNOTE @N1@`). The app has one note
 * per thing. It reads the first NOTE line that holds its own text; every other
 * NOTE line, and every pointer to a note record, stays as written.
 */

/** The longest note the app's forms accept. */
export const NOTE_MAX = 50_000;

/** A note in the form the app stores it: line ends made the same, trimmed, and cut to length. */
export function cleanNote(text: string): string {
  return text.replace(/\r\n?/g, '\n').trim().slice(0, NOTE_MAX).trim();
}

/** True for a NOTE line that holds text of its own, as opposed to a pointer to a note record. */
export function isOwnNote(node: GedcomNode): boolean {
  return node.tag === 'NOTE' && pointerTarget(node.value) === null && node.value.trim() !== '';
}

/** The first note written under a structure itself. */
export function ownNote(node: GedcomNode): GedcomNode | undefined {
  return node.children.find(isOwnNote);
}

/** The text of the first note written under a structure itself; empty when there is none. */
export function readOwnNote(node: GedcomNode): string {
  return cleanNote(ownNote(node)?.value ?? '');
}

/**
 * Brings the first own note under `node` in step with `note`: its text is
 * replaced, a missing line is added after the other lines, and an empty note
 * takes the line away. What stands under the NOTE line (a source, say) stays.
 */
export function setOwnNote(node: GedcomNode, note: string): void {
  const existing = ownNote(node);
  if (note === '') {
    if (existing) node.children = node.children.filter((child) => child !== existing);
  } else if (!existing) {
    node.children.push(makeNode('NOTE', note));
  } else if (existing.value !== note) {
    existing.value = note;
    touch(existing);
  }
}

/**
 * The NOTE line for the note of a person, which stands directly under the
 * record. With the line the note was imported from, the line is only
 * rewritten when the note has changed since. Null when there is no note.
 */
export function patchNoteLine(original: GedcomNode | null, note: string): GedcomNode | null {
  if (note === '') return null;
  if (!original) return makeNode('NOTE', note);
  if (cleanNote(original.value) === note) return original;
  const node: GedcomNode = { ...original, value: note, children: [...original.children] };
  touch(node);
  return node;
}
