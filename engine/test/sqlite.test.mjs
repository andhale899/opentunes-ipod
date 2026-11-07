// The engine's read-only reader for the SQLite files of a nano 6G or 7G library, and the
// profile built on it. Native SQLite (node:sqlite) is the check on the WebAssembly one.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { buildSignedDemoIpod, compareProfiles, lossesIn, profileDatabase } from '../js/index.ts';
import { MOUNT, newEngine } from './helpers.mjs';

const ITLP = `${MOUNT}/iPod_Control/iTunes/iTunes Library.itlp`;
const FIXTURE = fileURLToPath(new URL('./fixtures/custom-collation.itdb', import.meta.url));

async function demoLibrary() {
  const engine = await newEngine();
  buildSignedDemoIpod(engine);
  return engine;
}

async function engineWithFixture() {
  const engine = await newEngine();
  engine.fs.writeFile('/fixture.itdb', readFileSync(FIXTURE));
  return engine;
}

describe('querying an SQLite file', () => {
  it('returns the columns, the rows, and says when it stopped early', async () => {
    const engine = await demoLibrary();
    const path = `${ITLP}/Library.itdb`;
    const all = engine.sqlQuery(path, 'SELECT title, media_kind FROM item ORDER BY title');
    assert.deepEqual(all.columns, ['title', 'media_kind']);
    assert.equal(all.rows.length, 5);
    assert.equal(all.truncated, false);

    const some = engine.sqlQuery(path, 'SELECT title FROM item ORDER BY title', 2);
    assert.equal(some.rows.length, 2);
    assert.equal(some.truncated, true);
    assert.deepEqual(some.rows[0], all.rows[0].slice(0, 1));
  });

  it('gives integers a JavaScript number cannot hold as strings, and the rest as numbers', async () => {
    const engine = await engineWithFixture();
    const { rows } = engine.sqlQuery('/fixture.itdb', 'SELECT pid, rating FROM item ORDER BY pid');
    assert.deepEqual(rows.map((row) => row[0]), [1, 2, 3, '9007199254740993']);
    assert.deepEqual(rows.map((row) => row[1]), [80, 0, null, 60]);
  });

  it('reads a file that needs a collation and a function only Apple defines', async () => {
    const engine = await engineWithFixture();
    // These touch the collated column and the indexes that name the collation and the function.
    assert.equal(engine.sqlQuery('/fixture.itdb', 'SELECT COUNT(*) FROM item').rows[0][0], 4);
    assert.deepEqual(engine.sqlQuery('/fixture.itdb', 'SELECT title FROM item WHERE title = \'ALPHA\' COLLATE NOCASE_UNICODE').rows, []);
    assert.equal(engine.sqlQuery('/fixture.itdb', 'SELECT COUNT(*) FROM item WHERE iPhoneSortKey(title) = \'Alpha\'').rows[0][0], 1);
  });

  it('says what went wrong instead of returning nothing', async () => {
    const engine = await engineWithFixture();
    assert.throws(() => engine.sqlQuery('/fixture.itdb', 'SELECT * FROM nope'), /no such table: nope/);
    assert.throws(() => engine.sqlQuery('/missing.itdb', 'SELECT 1'), /Could not open \/missing\.itdb/);
    assert.throws(() => engine.sqlQuery('/fixture.itdb', 'SELEC 1'), /syntax error/);
  });

  it('cannot change the file', async () => {
    const engine = await engineWithFixture();
    assert.throws(() => engine.sqlQuery('/fixture.itdb', 'DELETE FROM item'), /readonly/i);
    assert.equal(engine.sqlQuery('/fixture.itdb', 'SELECT COUNT(*) FROM item').rows[0][0], 4);
  });
});

describe('profiling a database', () => {
  it('counts rows and the columns that hold a value', async () => {
    const engine = await engineWithFixture();
    const profile = profileDatabase(engine, '/fixture.itdb');
    assert.deepEqual(profile.unreadable, {});
    assert.deepEqual(profile.tables.item, { rows: 4, filled: { pid: 4, title: 3, rating: 2, artwork_cache_id: 2 } });
    assert.deepEqual(profile.tables.empty_table, { rows: 0, filled: { a: 0, b: 0 } });
  });

  it('agrees with native SQLite on every table and column of a real library file', async () => {
    const engine = await demoLibrary();
    for (const file of ['Library.itdb', 'Dynamic.itdb', 'Extras.itdb', 'Locations.itdb']) {
      const bytes = engine.fs.readFile(`${ITLP}/${file}`);
      const copy = join(mkdtempSync(join(tmpdir(), 'opentunes-')), file);
      writeFileSync(copy, bytes);
      const native = new DatabaseSync(copy, { readOnly: true });

      const profile = profileDatabase(engine, `${ITLP}/${file}`);
      const tables = native.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => row.name);
      assert.deepEqual(Object.keys(profile.tables), tables, file);
      for (const table of tables) {
        const quoted = `"${table.replaceAll('"', '""')}"`;
        assert.equal(profile.tables[table].rows, native.prepare(`SELECT COUNT(*) AS n FROM ${quoted}`).get().n, `${file} ${table} rows`);
        for (const column of native.prepare(`PRAGMA table_info(${quoted})`).all().map((row) => row.name)) {
          const expected = native
            .prepare(`SELECT COUNT(*) AS n FROM ${quoted} WHERE CAST("${column}" AS TEXT) NOT IN ('', '0')`)
            .get().n;
          assert.equal(profile.tables[table].filled[column], expected, `${file} ${table}.${column}`);
        }
      }
      native.close();
    }
  });

  it('reports a table it cannot read and carries on with the rest', async () => {
    const engine = await engineWithFixture();
    const original = engine.sqlQuery.bind(engine);
    engine.sqlQuery = (path, query, max) => {
      if (query.includes('"empty_table"') && query.includes('SELECT COUNT')) throw new Error('simulated failure');
      return original(path, query, max);
    };
    const profile = profileDatabase(engine, '/fixture.itdb');
    assert.match(profile.unreadable.empty_table, /simulated failure/);
    assert.equal(profile.tables.item.rows, 4);
  });
});

describe('comparing profiles', () => {
  const table = (rows, filled) => ({ rows, filled });
  const profile = (tables) => ({ tables, unreadable: {} });

  it('lists only what differs, and says what it lost', () => {
    const before = profile({
      item: table(10, { pid: 10, rating: 7, artwork_cache_id: 6 }),
      gone: table(3, { a: 3 }),
      same: table(1, { a: 1 }),
      shrinks: table(5, { a: 5 }),
    });
    const after = profile({
      item: table(10, { pid: 10, rating: 7, artwork_cache_id: 0, new_column: 4 }),
      same: table(1, { a: 1 }),
      shrinks: table(2, { a: 2 }),
      added: table(1, { a: 1 }),
    });

    const changes = compareProfiles(before, after);
    assert.deepEqual(changes.map((change) => change.table), ['added', 'gone', 'item', 'shrinks']);
    assert.deepEqual(changes.find((change) => change.table === 'item').columns, [
      { column: 'artwork_cache_id', before: 6, after: 0 },
      { column: 'new_column', before: null, after: 4 },
    ]);
    assert.equal(changes.find((change) => change.table === 'gone').rowsAfter, null);

    const losses = lossesIn('Library.itdb', changes);
    assert.deepEqual(losses, [
      'Library.itdb: the table gone is gone after the rewrite (it had 3 rows).',
      'Library.itdb: item.artwork_cache_id held a value on 6 rows before the rewrite and holds a value on 0 after.',
      'Library.itdb: the table shrinks has 2 rows after the rewrite, 5 before.',
      'Library.itdb: shrinks.a held a value on 5 rows before the rewrite and holds a value on 2 after.',
    ]);
  });

  it('finds nothing to report when the profiles match', () => {
    const same = profile({ item: table(2, { pid: 2 }) });
    assert.deepEqual(compareProfiles(same, structuredClone(same)), []);
  });
});
