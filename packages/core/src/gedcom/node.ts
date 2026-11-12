/**
 * The shape every GEDCOM file is read into, whatever its version.
 *
 * A GEDCOM file is lines of "level tag value". A line with a higher level
 * belongs to the nearest line above it with a lower level, which makes a tree.
 * A top-level line and everything under it is a record: a person (INDI), a
 * family (FAM), a source (SOUR) and so on.
 */

/** The two GEDCOM versions the app reads and writes. 5.5 and 5.5.5 are read as 5.5.1. */
export type GedcomVersion = '5.5.1' | '7.0';

export interface GedcomNode {
  /** Cross-reference id without its `@` signs, e.g. `I1`. Null for a line that has none. */
  xref: string | null;
  /** The tag in capitals, e.g. `BIRT`. */
  tag: string;
  /**
   * The value with its continuation lines joined: CONT adds a line break, CONC
   * does not. A pointer keeps its `@` signs, e.g. `@F1@`. Empty when there is none.
   */
  value: string;
  children: GedcomNode[];
  /**
   * The lines this node was read from: its own line and its CONC and CONT
   * lines. Null for a node the app made or changed, which is then written out
   * afresh. Keeping the lines is what lets an untouched part of a file be
   * written back exactly as it was.
   */
  raw: string[] | null;
  /** Line number in the file, counting from 1. Zero for a node the app made. */
  line: number;
}

export function makeNode(tag: string, value = '', children: GedcomNode[] = []): GedcomNode {
  return { xref: null, tag, value, children, raw: null, line: 0 };
}

/** A deep copy. The `raw` lines are shared, because they are never changed in place. */
export function cloneNode(node: GedcomNode): GedcomNode {
  return { ...node, children: node.children.map(cloneNode) };
}

/** Marks a node as changed, so it is written out afresh and not from its original lines. */
export function touch(node: GedcomNode): void {
  node.raw = null;
}

/**
 * Marks a node and everything under it as changed. Needed when a structure is
 * written at another level than the one it was read from, because its original
 * lines carry their level numbers.
 */
export function touchAll(node: GedcomNode): void {
  touch(node);
  node.children.forEach(touchAll);
}

export function findChild(node: GedcomNode, tag: string): GedcomNode | undefined {
  return node.children.find((child) => child.tag === tag);
}

export function findChildren(node: GedcomNode, tag: string): GedcomNode[] {
  return node.children.filter((child) => child.tag === tag);
}

/** The value of the first child with this tag, or empty text when there is none. */
export function childValue(node: GedcomNode, tag: string): string {
  return findChild(node, tag)?.value ?? '';
}

const POINTER = /^@([^@#\s][^@\s]*)@$/;

/** The cross-reference id a value points to (`@F1@` gives `F1`), or null when it is not a pointer. */
export function pointerTarget(value: string): string | null {
  return POINTER.exec(value.trim())?.[1] ?? null;
}

export function pointerTo(xref: string): string {
  return `@${xref}@`;
}

/** The pointer GEDCOM 7.0 uses for "there is a link here, but to nothing known". */
export const VOID_POINTER = '@VOID@';

/** Every original line of a node and what is under it, in file order. Null if any part has none. */
export function rawLines(node: GedcomNode): string[] | null {
  if (node.raw === null) return null;
  const lines = [...node.raw];
  for (const child of node.children) {
    const below = rawLines(child);
    if (below === null) return null;
    lines.push(...below);
  }
  return lines;
}

/** Calls `visit` for a node and everything under it, parents before children. */
export function walk(
  node: GedcomNode,
  visit: (node: GedcomNode, parent: GedcomNode | null) => void,
  parent: GedcomNode | null = null,
): void {
  visit(node, parent);
  // A copy, so `visit` may add or remove children of the node it is given.
  for (const child of [...node.children]) walk(child, visit, node);
}

/**
 * Adds a child at the place the usual order of a structure gives it. `order`
 * lists the tags that come first, in order; the new child goes before the
 * first child that comes later in that list or is not in it at all.
 */
export function insertInOrder(
  parent: GedcomNode,
  child: GedcomNode,
  order: readonly string[],
): void {
  const rank = order.indexOf(child.tag);
  const at = parent.children.findIndex((existing) => {
    const other = order.indexOf(existing.tag);
    return other === -1 || (rank !== -1 && other > rank);
  });
  if (at === -1) parent.children.push(child);
  else parent.children.splice(at, 0, child);
}

/**
 * Sets the value of the first child with `tag`, adding the child (in `order`)
 * when there is none. An empty value removes every child with that tag.
 * Returns the child, or null when it was removed.
 */
export function setChildValue(
  parent: GedcomNode,
  tag: string,
  value: string,
  order: readonly string[],
): GedcomNode | null {
  const existing = findChildren(parent, tag);
  if (value === '') {
    if (existing.length > 0) {
      parent.children = parent.children.filter((child) => child.tag !== tag);
    }
    return null;
  }
  const [first, ...repeats] = existing;
  if (first === undefined) {
    const made = makeNode(tag, value);
    insertInOrder(parent, made, order);
    return made;
  }
  if (repeats.length > 0) {
    parent.children = parent.children.filter((child) => !repeats.includes(child));
  }
  if (first.value !== value) {
    first.value = value;
    touch(first);
  }
  return first;
}

/**
 * Text that is the same for two structures exactly when everything under them
 * says the same in the same words, in the same order. The line itself is left
 * out, so that a structure at level 1 and the same one at level 2 compare as
 * equal.
 */
export function structureKey(node: GedcomNode): string {
  const shape = (line: GedcomNode): unknown => [line.tag, line.value, line.children.map(shape)];
  return JSON.stringify(node.children.map(shape));
}
