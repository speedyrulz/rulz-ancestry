import type { Migration } from '../migrate';
import { coreTree } from './001-core-tree';
import { gedcomRecords } from './002-gedcom';

/** The schema history of a tree database, oldest first. Only ever append to this list. */
export const treeMigrations: readonly Migration[] = [coreTree, gedcomRecords];
