import { createPerson } from './persons';
import { searchPersons } from './search';
import { openTree } from './tree';

export interface TreeEngineCheck {
  /** The newest tree schema version this build of the app creates. */
  schemaVersion: number;
}

/**
 * Proves that the tree engine works on this machine: it builds a tree in
 * memory, then adds, finds, undoes and redoes a person. This exercises the
 * migrations, the change-log triggers, JSON and full-text search in the SQLite
 * build that is actually shipped. It throws if any step gives a wrong answer.
 */
export function checkTreeEngine(): TreeEngineCheck {
  const tree = openTree(':memory:');
  try {
    const found = () => searchPersons(tree, 'muller').length;
    createPerson(tree, { name: { given: 'Johann', surname: 'Müller' } });
    const steps: [string, boolean][] = [
      ['search finds a new person', found() === 1],
      ['undo removes the person', tree.undo() !== null && found() === 0],
      ['redo restores the person', tree.redo() !== null && found() === 1],
    ];
    for (const [step, passed] of steps) {
      if (!passed) throw new Error(`tree engine check failed: ${step}`);
    }
    return { schemaVersion: tree.info().schemaVersion };
  } finally {
    tree.close();
  }
}
