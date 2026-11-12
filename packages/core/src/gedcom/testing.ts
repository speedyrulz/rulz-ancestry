import type { GedcomNode, GedcomVersion } from './node';
import { parseFragment } from './parse';
import { writeLines } from './write';

/** Helpers shared by this folder's unit tests. Not part of the public API. */

/** Joins lines the way the tests write GEDCOM text. */
export function ged(...lines: string[]): string {
  return lines.join('\n');
}

/** Reads a piece of GEDCOM that holds exactly one structure. */
export function one(text: string, version: GedcomVersion = '5.5.1'): GedcomNode {
  const nodes = parseFragment(text, version);
  const [node] = nodes;
  if (!node || nodes.length !== 1) throw new Error(`expected one structure, got ${nodes.length}`);
  return node;
}

/**
 * Writes a structure at `level`, untouched parts from their original lines,
 * and returns the lines joined with line breaks.
 */
export function show(node: GedcomNode, version: GedcomVersion = '5.5.1', level = 1): string {
  return writeLines([node], level, { version, keepOriginalLines: true }).join('\n');
}

/** Writes a structure afresh from its tags and values, ignoring its original lines. */
export function fresh(node: GedcomNode, version: GedcomVersion = '5.5.1', level = 1): string {
  return writeLines([node], level, { version }).join('\n');
}
