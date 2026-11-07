/**
 * Looks inside the SQLite files of a nano 6G or 7G library, and compares two states of them.
 *
 * A nano 7G keeps its library in `iTunes Library.itlp/*.itdb`. libgpod does not read them: it
 * reads iTunesCDB, then writes all of them again from its own model of the library. Anything
 * in them that the model does not carry is lost. So this does not need to know the schema:
 * for every table it counts the rows, and for every column how many rows hold a value, and a
 * rewrite shows up as columns that emptied out.
 *
 * Reads only. A value counts as filled unless it is NULL, an empty string or zero.
 */

import type { Engine } from './engine.ts';

export interface TableProfile {
  rows: number;
  /** For each column, how many rows hold a value that is not NULL, empty or zero. */
  filled: Record<string, number>;
}

export interface DatabaseProfile {
  tables: Record<string, TableProfile>;
  /** Tables that could not be read, with the reason. */
  unreadable: Record<string, string>;
}

const COLUMNS_PER_QUERY = 30;

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Counts rows without touching any index, which could need a function only Apple's code has. */
function countRows(engine: Engine, path: string, table: string): number {
  const run = (suffix: string): number => Number(engine.sqlQuery(path, `SELECT COUNT(*) FROM ${quote(table)}${suffix}`).rows[0]?.[0] ?? 0);
  try {
    return run(' NOT INDEXED');
  } catch {
    return run(''); // a WITHOUT ROWID table may not accept NOT INDEXED
  }
}

function profileTable(engine: Engine, path: string, table: string): TableProfile {
  const columns = engine.sqlQuery(path, `PRAGMA table_info(${quote(table)})`).rows.map((row) => String(row[1]));
  const rows = countRows(engine, path, table);
  const filled: Record<string, number> = {};
  for (let start = 0; start < columns.length; start += COLUMNS_PER_QUERY) {
    const chunk = columns.slice(start, start + COLUMNS_PER_QUERY);
    const sums = chunk.map((column) => `COALESCE(SUM(CAST(${quote(column)} AS TEXT) NOT IN ('', '0')), 0)`).join(', ');
    const counts = engine.sqlQuery(path, `SELECT ${sums} FROM ${quote(table)} NOT INDEXED`).rows[0] ?? [];
    chunk.forEach((column, index) => {
      filled[column] = Number(counts[index] ?? 0);
    });
  }
  return { rows, filled };
}

/** Profiles every table of one SQLite file in the engine's file system. */
export function profileDatabase(engine: Engine, path: string): DatabaseProfile {
  const profile: DatabaseProfile = { tables: {}, unreadable: {} };
  const names = engine
    .sqlQuery(path, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .rows.map((row) => String(row[0]));
  for (const table of names) {
    try {
      profile.tables[table] = profileTable(engine, path, table);
    } catch (error) {
      profile.unreadable[table] = messageOf(error);
    }
  }
  return profile;
}

export interface ColumnChange {
  column: string;
  /** Null when the column did not exist on that side. */
  before: number | null;
  after: number | null;
}

export interface TableChange {
  table: string;
  /** Null when the table did not exist on that side. */
  rowsBefore: number | null;
  rowsAfter: number | null;
  columns: ColumnChange[];
}

/** The tables and columns that differ between two profiles of the same file. */
export function compareProfiles(before: DatabaseProfile, after: DatabaseProfile): TableChange[] {
  const changes: TableChange[] = [];
  const tables = [...new Set([...Object.keys(before.tables), ...Object.keys(after.tables)])].sort();
  for (const table of tables) {
    const was = before.tables[table];
    const now = after.tables[table];
    const columns: ColumnChange[] = [];
    for (const column of [...new Set([...Object.keys(was?.filled ?? {}), ...Object.keys(now?.filled ?? {})])]) {
      const b = was?.filled[column] ?? null;
      const a = now?.filled[column] ?? null;
      if (b !== a) columns.push({ column, before: b, after: a });
    }
    const rowsBefore = was?.rows ?? null;
    const rowsAfter = now?.rows ?? null;
    if (rowsBefore !== rowsAfter || columns.length) changes.push({ table, rowsBefore, rowsAfter, columns });
  }
  return changes;
}

export interface DescribedChanges {
  /** Data the iPod holds that the rewrite loses or empties, as plain sentences. */
  lost: string[];
  /** Tables and columns the iPod's file has and the rewritten file lacks, where they held no data. */
  missing: string[];
}

/**
 * Sorts the changes into data that is lost and structure that is only missing. A column that
 * held a value on some rows and holds fewer now is a loss. A column that held nothing and is
 * gone is a difference in schema: worth knowing, but no data went with it.
 */
export function describeChanges(file: string, changes: TableChange[]): DescribedChanges {
  const lost: string[] = [];
  const missing: string[] = [];
  for (const change of changes) {
    if (change.rowsAfter === null) {
      (change.rowsBefore ? lost : missing).push(
        change.rowsBefore
          ? `${file}: the table ${change.table} is gone after the rewrite (it had ${change.rowsBefore} rows).`
          : `${file}: the table ${change.table} (empty) is gone after the rewrite.`,
      );
      continue;
    }
    if (change.rowsBefore !== null && change.rowsAfter < change.rowsBefore) {
      lost.push(`${file}: the table ${change.table} has ${change.rowsAfter} rows after the rewrite, ${change.rowsBefore} before.`);
    }
    for (const column of change.columns) {
      if (column.before === null) continue; // new in the rewrite, nothing was lost
      if (column.after === null) {
        (column.before > 0 ? lost : missing).push(
          column.before > 0
            ? `${file}: ${change.table}.${column.column} held a value on ${column.before} rows before the rewrite and is gone after.`
            : `${file}: the column ${change.table}.${column.column} (empty) is gone after the rewrite.`,
        );
      } else if (column.after < column.before) {
        lost.push(`${file}: ${change.table}.${column.column} held a value on ${column.before} rows before the rewrite and holds a value on ${column.after} after.`);
      }
    }
  }
  return { lost, missing };
}
