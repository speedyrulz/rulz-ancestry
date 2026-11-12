import type { Db } from './connection';

/**
 * One step in a database's schema history. Migrations are append-only: once a
 * version has shipped, its `up` must keep producing the same schema, and any
 * later change goes into a new migration.
 */
export interface Migration {
  /** The schema version this step produces. Versions start at 1 with no gaps. */
  version: number;
  name: string;
  up(db: Db): void;
}

/** The file was written by a newer version of the app than the one running. */
export class SchemaTooNewError extends Error {
  constructor(
    readonly found: number,
    readonly supported: number,
  ) {
    super(
      `database schema version ${found} is newer than this app supports (${supported}); ` +
        'update the app to open it',
    );
    this.name = 'SchemaTooNewError';
  }
}

/** The schema version stored in the database file (SQLite's `user_version`). */
export function schemaVersion(db: Db): number {
  return db.pragma('user_version', { simple: true }) as number;
}

/**
 * Brings a database up to the newest schema. Each migration runs in its own
 * transaction together with the version bump, so a failure or a crash leaves
 * the database at the last complete version.
 */
export function migrate(db: Db, migrations: readonly Migration[]): { from: number; to: number } {
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new Error(`migration "${migration.name}" must have version ${index + 1}`);
    }
  });

  const from = schemaVersion(db);
  const latest = migrations.length;
  if (from > latest) throw new SchemaTooNewError(from, latest);
  if (from === latest) return { from, to: latest };

  // Rebuilding a table (SQLite's way to change a column) needs foreign keys
  // off, and that setting cannot be changed inside a transaction. Each
  // migration is checked for broken references before it commits instead.
  const foreignKeysWereOn = db.pragma('foreign_keys', { simple: true }) === 1;
  db.pragma('foreign_keys = OFF');
  try {
    for (const migration of migrations.slice(from)) {
      db.transaction(() => {
        migration.up(db);
        const broken = db.pragma('foreign_key_check') as unknown[];
        if (broken.length > 0) {
          throw new Error(
            `migration ${migration.version} "${migration.name}" left ${broken.length} ` +
              'broken foreign key reference(s)',
          );
        }
        db.pragma(`user_version = ${migration.version}`);
      }).immediate();
    }
  } finally {
    if (foreignKeysWereOn) db.pragma('foreign_keys = ON');
  }
  return { from, to: latest };
}
