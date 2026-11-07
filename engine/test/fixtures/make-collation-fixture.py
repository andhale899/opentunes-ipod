# Makes engine/test/fixtures/custom-collation.itdb, a small SQLite file shaped like the ones
# Apple's software writes: a column and an index that name a collation, and an index on a
# function, that only Apple's code defines. SQLite cannot even prepare a query on such a table
# unless the collation and function exist, which is what the engine's reader has to cope with.
#
#   python3 engine/test/fixtures/make-collation-fixture.py
#
# The committed file is the output. This script is here so it can be remade.
import os
import sqlite3

here = os.path.dirname(os.path.abspath(__file__))
path = os.path.join(here, 'custom-collation.itdb')
if os.path.exists(path):
    os.remove(path)

db = sqlite3.connect(path)
db.create_collation('NOCASE_UNICODE', lambda a, b: (a.lower() > b.lower()) - (a.lower() < b.lower()))
db.create_function('iPhoneSortKey', 1, lambda value: value, deterministic=True)
db.executescript('''
CREATE TABLE item (pid INTEGER PRIMARY KEY, title TEXT COLLATE NOCASE_UNICODE, rating INTEGER, artwork_cache_id INTEGER);
CREATE INDEX item_title ON item (title COLLATE NOCASE_UNICODE);
CREATE INDEX item_sort ON item (iPhoneSortKey(title));
CREATE TABLE empty_table (a TEXT, b INTEGER);
''')
rows = [
    (1, 'Alpha', 80, 7),
    (2, 'bravo', 0, 0),
    (3, '', None, 9),
    (9007199254740993, 'Charlie', 60, 0),  # a pid too big for a JavaScript number
]
db.executemany('INSERT INTO item VALUES (?, ?, ?, ?)', rows)
db.commit()
db.execute('VACUUM')
db.close()
print('wrote', path, os.path.getsize(path), 'bytes')
