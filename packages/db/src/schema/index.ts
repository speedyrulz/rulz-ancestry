import type { Migration } from '../migrate';
import { coreTree } from './001-core-tree';

/** The schema history of a tree database, oldest first. Only ever append to this list. */
export const treeMigrations: readonly Migration[] = [coreTree];
