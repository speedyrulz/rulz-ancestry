import { sql, type Db } from './connection';

/**
 * The change log: undo, redo and the raw material for a per-person history.
 *
 * Triggers on each tracked table copy every inserted, updated or deleted row
 * into `change_log` as JSON. Because the database does the recording, no code
 * path can change the tree without leaving a record, including rows removed by
 * a foreign-key cascade.
 *
 * `change_state.mode` says what the triggers should do:
 *
 * - `idle`: nothing may write to a tracked table; an attempt is rejected.
 * - `record`: a change transaction is open and every row change is logged.
 * - `replay`: undo or redo is writing rows back; nothing is logged.
 *
 * The mode is set and reset inside the same SQLite transaction as the writes,
 * so a crash or an error always leaves it at `idle`.
 */

export const UNTRACKED_WRITE_MESSAGE =
  'tree tables can only be changed inside a change transaction';

const IDENTIFIER = /^[a-z][a-z0-9_]*$/;

function assertIdentifier(name: string): void {
  if (!IDENTIFIER.test(name)) throw new Error(`unsafe SQL identifier: ${name}`);
}

function columnsOf(db: Db, table: string): string[] {
  assertIdentifier(table);
  const columns = (db.pragma(`table_info(${table})`) as { name: string }[]).map((c) => c.name);
  columns.forEach(assertIdentifier);
  return columns;
}

/**
 * Creates (or recreates) the guard and logging triggers for a table. The table
 * needs a text primary key called `id`. Call this again from a later migration
 * whenever the table's columns change, because the triggers list them.
 */
export function trackChanges(db: Db, table: string): void {
  const columns = columnsOf(db, table);
  if (!columns.includes('id')) throw new Error(`table ${table} has no id column`);

  const row = (alias: 'OLD' | 'NEW') =>
    `json_object(${columns.map((c) => `'${c}', ${alias}.${c}`).join(', ')})`;
  const idle = `(SELECT mode FROM change_state) = 'idle'`;
  const recording = `(SELECT mode FROM change_state) = 'record'`;
  const currentTx = '(SELECT current_tx FROM change_state)';
  const reject = `SELECT RAISE(ABORT, '${UNTRACKED_WRITE_MESSAGE}')`;

  db.exec(`
    DROP TRIGGER IF EXISTS ${table}_guard_insert;
    DROP TRIGGER IF EXISTS ${table}_guard_update;
    DROP TRIGGER IF EXISTS ${table}_guard_delete;
    DROP TRIGGER IF EXISTS ${table}_log_insert;
    DROP TRIGGER IF EXISTS ${table}_log_update;
    DROP TRIGGER IF EXISTS ${table}_log_delete;

    CREATE TRIGGER ${table}_guard_insert BEFORE INSERT ON ${table} WHEN ${idle}
    BEGIN ${reject}; END;
    CREATE TRIGGER ${table}_guard_update BEFORE UPDATE ON ${table} WHEN ${idle}
    BEGIN ${reject}; END;
    CREATE TRIGGER ${table}_guard_delete BEFORE DELETE ON ${table} WHEN ${idle}
    BEGIN ${reject}; END;

    CREATE TRIGGER ${table}_log_insert AFTER INSERT ON ${table} WHEN ${recording}
    BEGIN
      INSERT INTO change_log (tx_id, entity_type, entity_id, op, after_json)
      VALUES (${currentTx}, '${table}', NEW.id, 'insert', ${row('NEW')});
    END;
    CREATE TRIGGER ${table}_log_update AFTER UPDATE ON ${table}
    WHEN ${recording} AND ${row('OLD')} <> ${row('NEW')}
    BEGIN
      INSERT INTO change_log (tx_id, entity_type, entity_id, op, before_json, after_json)
      VALUES (${currentTx}, '${table}', NEW.id, 'update', ${row('OLD')}, ${row('NEW')});
    END;
    CREATE TRIGGER ${table}_log_delete AFTER DELETE ON ${table} WHEN ${recording}
    BEGIN
      INSERT INTO change_log (tx_id, entity_type, entity_id, op, before_json)
      VALUES (${currentTx}, '${table}', OLD.id, 'delete', ${row('OLD')});
    END;
  `);
}

/** One undoable step: everything written by a single change transaction. */
export interface ChangeTx {
  id: number;
  /** What the step did, e.g. "Add person". Shown as "Undo Add person". */
  label: string;
  /** When it happened, in Unix milliseconds. */
  at: number;
}

interface ChangeLogRow {
  entity_type: string;
  entity_id: string;
  op: 'insert' | 'update' | 'delete';
  before_json: string | null;
  after_json: string | null;
}

type RowValues = Record<string, string | number | null>;

/** Opens a change transaction. Must be called inside a SQLite transaction. */
export function beginRecording(db: Db, label: string): number {
  const result = sql(db, 'INSERT INTO change_tx (label, at) VALUES (?, ?)').run(label, Date.now());
  const txId = Number(result.lastInsertRowid);
  sql(db, "UPDATE change_state SET mode = 'record', current_tx = ?").run(txId);
  return txId;
}

/**
 * Closes a change transaction. A transaction that changed nothing leaves no
 * undo step. One that did change something discards the redo steps, as in any
 * editor: after a new edit there is nothing left to redo.
 */
export function endRecording(db: Db, txId: number): void {
  sql(db, "UPDATE change_state SET mode = 'idle', current_tx = NULL").run();
  const changed = sql(db, 'SELECT 1 FROM change_log WHERE tx_id = ? LIMIT 1').get(txId);
  if (changed) {
    sql(db, 'DELETE FROM change_tx WHERE undone = 1').run();
  } else {
    sql(db, 'DELETE FROM change_tx WHERE id = ?').run(txId);
  }
}

function trackedTables(db: Db): Map<string, string[]> {
  const names = db
    .prepare(
      `SELECT tbl_name FROM sqlite_schema
       WHERE type = 'trigger' AND name = tbl_name || '_log_insert'`,
    )
    .pluck()
    .all() as string[];
  return new Map(names.map((name) => [name, columnsOf(db, name)]));
}

/** The columns of a logged row that still exist in the table today. */
function usable(columns: string[], values: RowValues): string[] {
  return columns.filter((column) => Object.hasOwn(values, column));
}

function insertRow(db: Db, table: string, columns: string[], values: RowValues): void {
  const names = usable(columns, values);
  sql(
    db,
    `INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
  ).run(...names.map((name) => values[name] ?? null));
}

function updateRow(db: Db, table: string, columns: string[], values: RowValues): void {
  const names = usable(columns, values).filter((name) => name !== 'id');
  sql(db, `UPDATE ${table} SET ${names.map((name) => `${name} = ?`).join(', ')} WHERE id = ?`).run(
    ...names.map((name) => values[name] ?? null),
    values['id'] ?? null,
  );
}

function deleteRow(db: Db, table: string, id: string): void {
  sql(db, `DELETE FROM ${table} WHERE id = ?`).run(id);
}

function replay(db: Db, tx: ChangeTx, direction: 'undo' | 'redo'): void {
  db.transaction(() => {
    const tables = trackedTables(db);
    // Rows are written back one at a time, so a child can briefly exist
    // without its parent. Check references once, when the transaction commits.
    db.pragma('defer_foreign_keys = ON');
    sql(db, "UPDATE change_state SET mode = 'replay', current_tx = NULL").run();

    const order = direction === 'undo' ? 'DESC' : 'ASC';
    const rows = sql(
      db,
      `SELECT entity_type, entity_id, op, before_json, after_json
       FROM change_log WHERE tx_id = ? ORDER BY id ${order}`,
    ).all(tx.id) as ChangeLogRow[];

    for (const row of rows) {
      const columns = tables.get(row.entity_type);
      if (!columns) throw new Error(`change log names an untracked table: ${row.entity_type}`);
      const before = row.before_json ? (JSON.parse(row.before_json) as RowValues) : null;
      const after = row.after_json ? (JSON.parse(row.after_json) as RowValues) : null;

      // What the row should look like once this step has been replayed.
      const target = direction === 'undo' ? before : after;
      const exists = direction === 'undo' ? row.op !== 'insert' : row.op !== 'delete';
      const existed = direction === 'undo' ? row.op !== 'delete' : row.op !== 'insert';

      if (!exists) {
        deleteRow(db, row.entity_type, row.entity_id);
      } else if (!target) {
        throw new Error(`change log row for ${row.entity_type} ${row.entity_id} has no data`);
      } else if (existed) {
        updateRow(db, row.entity_type, columns, target);
      } else {
        insertRow(db, row.entity_type, columns, target);
      }
    }

    sql(db, "UPDATE change_state SET mode = 'idle', current_tx = NULL").run();
    sql(db, 'UPDATE change_tx SET undone = ? WHERE id = ?').run(
      direction === 'undo' ? 1 : 0,
      tx.id,
    );
  }).immediate();
}

/** The step that undo would reverse and the step that redo would repeat. */
export function undoStatus(db: Db): { undo: ChangeTx | null; redo: ChangeTx | null } {
  const undo = sql(
    db,
    'SELECT id, label, at FROM change_tx WHERE undone = 0 ORDER BY id DESC LIMIT 1',
  ).get() as ChangeTx | undefined;
  const redo = sql(
    db,
    'SELECT id, label, at FROM change_tx WHERE undone = 1 ORDER BY id ASC LIMIT 1',
  ).get() as ChangeTx | undefined;
  return { undo: undo ?? null, redo: redo ?? null };
}

/** Reverses the most recent step. Returns it, or null when there is nothing to undo. */
export function undo(db: Db): ChangeTx | null {
  const { undo: tx } = undoStatus(db);
  if (tx) replay(db, tx, 'undo');
  return tx;
}

/** Repeats the most recently undone step. Returns it, or null when there is nothing to redo. */
export function redo(db: Db): ChangeTx | null {
  const { redo: tx } = undoStatus(db);
  if (tx) replay(db, tx, 'redo');
  return tx;
}
