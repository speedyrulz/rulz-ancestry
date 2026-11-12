import type { Migration } from '../migrate';
import { coreTree } from './001-core-tree';
import { gedcomRecords } from './002-gedcom';
import { mergeRecords } from './003-merge';
import { sources } from './004-sources';

/** The schema history of a tree database, oldest first. Only ever append to this list. */
export const treeMigrations: readonly Migration[] = [
  coreTree,
  gedcomRecords,
  mergeRecords,
  sources,
];
