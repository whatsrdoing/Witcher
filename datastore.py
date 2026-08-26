#!/usr/bin/env python3
"""Keeps every row of every register, month after month, in one file.

The Data Library holds files. This holds their *contents* -- so July, August
and September of the same register stack up in one place and can be asked
questions across all of them, right down to a single bill.

    data/library.db        one SQLite file, backed up by copying it

Nothing here needs installing: SQLite comes with Python, same as the web
server does. Every value is stored as text exactly as it appeared in the
CSV, and converted only when a query asks for a number -- a register that
writes "1,250.00" or "(45)" or a leading-zero item code survives a round
trip unchanged, which it would not if the importer guessed types.
"""
import csv
import os
import re
import sqlite3
import time

# Table and column names go into SQL, so they are built from this and
# nothing else. Anything a register actually contains is mapped onto it
# rather than trusted.
SAFE_NAME = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,62}$")
BATCH = 20000                       # rows per executemany; keeps memory flat
META = ("_period", "_source", "_rowno", "_part")

# Columns worth an index: the ones a single record is looked up by, which in
# practice means identifiers -- a column *ending* in code/no/id, not merely
# mentioning it. Matching "item" or "store" anywhere also caught Item Name,
# Store Name, Supplier and the date columns, which nobody looks a row up by:
# ten indexes instead of five, for a database 2.3x the size of the CSVs it
# came from and imports that slowed from 25s to 100s as they were maintained.
KEYISH = re.compile(r"(^|_)(code|no|num|number|id|sku)$", re.I)


def slug(name, fallback="col"):
    """A safe SQL identifier for an arbitrary column heading."""
    s = re.sub(r"[^A-Za-z0-9]+", "_", str(name or "")).strip("_")
    if not s:
        s = fallback
    if not s[0].isalpha():
        s = "c_" + s
    return s[:63]


class DataStoreError(Exception):
    pass


class DataStore:
    def __init__(self, path):
        self.path = path
        d = os.path.dirname(os.path.abspath(path))
        if d:
            os.makedirs(d, exist_ok=True)
        self.con = sqlite3.connect(path, timeout=30, check_same_thread=False)
        self.con.execute("PRAGMA journal_mode=WAL")      # readers don't block the writer
        self.con.execute("PRAGMA synchronous=NORMAL")
        self.con.execute("""CREATE TABLE IF NOT EXISTS _imports (
                dataset TEXT, period TEXT, part TEXT DEFAULT '', source TEXT, rows INTEGER,
                columns INTEGER, imported_at INTEGER,
                PRIMARY KEY (dataset, period, part))""")
        self.con.commit()
        self._migrate_parts()

    def _migrate_parts(self):
        """Bring a store written before parts existed up to date.

        Some registers arrive split across several files for the same month --
        COGS comes as department consumption, IP pharmacy and OP pharmacy --
        and each has to be able to land, and be replaced, without disturbing
        the others. That needs a part alongside the period.

        Existing rows belong to the single unnamed part, so they become ''.
        SQLite cannot alter a primary key, so _imports is rebuilt; the data
        tables only need a column added, which is cheap and non-destructive.
        """
        cols = [r[1] for r in self.con.execute("PRAGMA table_info(_imports)")]
        if "part" in cols:
            return
        self.con.execute("BEGIN")
        try:
            self.con.execute("""CREATE TABLE _imports_new (
                    dataset TEXT, period TEXT, part TEXT DEFAULT '', source TEXT, rows INTEGER,
                    columns INTEGER, imported_at INTEGER,
                    PRIMARY KEY (dataset, period, part))""")
            self.con.execute("""INSERT INTO _imports_new
                    (dataset, period, part, source, rows, columns, imported_at)
                    SELECT dataset, period, '', source, rows, columns, imported_at FROM _imports""")
            self.con.execute("DROP TABLE _imports")
            self.con.execute("ALTER TABLE _imports_new RENAME TO _imports")
            self.con.commit()
        except Exception:
            self.con.rollback()
            raise

    def close(self):
        self.con.close()

    # ---- schema ---------------------------------------------------------
    def _table(self, dataset):
        t = slug(dataset, "dataset")
        if not SAFE_NAME.match(t):
            raise DataStoreError("bad dataset name: %r" % dataset)
        return "ds_" + t

    def _existing_columns(self, table):
        rows = self.con.execute("PRAGMA table_info(%s)" % table).fetchall()
        return [r[1] for r in rows]

    def _ensure_table(self, table, columns):
        """Create the table, or widen it if this month has new columns.

        A register gaining a column in August must not orphan July, and must
        not silently drop the new one -- so columns are added, never removed,
        and older rows simply read NULL there.
        """
        have = self._existing_columns(table)
        if not have:
            cols = ", ".join('"%s" TEXT' % c for c in columns)
            self.con.execute("CREATE TABLE %s (_period TEXT, _source TEXT, _rowno INTEGER, "
                             "_part TEXT DEFAULT '', %s)" % (table, cols))
            self.con.execute('CREATE INDEX "ix_%s_period" ON %s(_period)' % (table, table))
            self.con.commit()
            return columns, []
        if "_part" not in have:
            # A table written before parts existed. Everything in it belongs
            # to the single unnamed part, which is what the default gives it.
            self.con.execute("ALTER TABLE %s ADD COLUMN _part TEXT DEFAULT ''" % table)
            self.con.execute("UPDATE %s SET _part='' WHERE _part IS NULL" % table)
            self.con.commit()
            have = self._existing_columns(table)
        added = [c for c in columns if c not in have]
        for c in added:
            self.con.execute('ALTER TABLE %s ADD COLUMN "%s" TEXT' % (table, c))
        if added:
            self.con.commit()
        return columns, added

    # ---- import ---------------------------------------------------------
    def import_csv(self, path, dataset, period, source=None, progress=None, part=""):
        """Load one CSV as one dataset+period+part. Re-importing replaces it.

        Replacing rather than appending is deliberate: uploading July twice
        should leave one July, not two. Everything happens in a single
        transaction, so a failure half way leaves the previous import intact
        instead of a half-loaded month.

        A register that arrives split across several files for the same month
        -- COGS as department consumption, IP pharmacy and OP pharmacy --
        names each one as a part. Replacement is then scoped to that part, so
        re-uploading IP pharmacy leaves the other two where they are. A
        register that arrives whole simply uses the unnamed part.
        """
        if not str(period or "").strip():
            raise DataStoreError("a period is required (e.g. 2026-07)")
        table = self._table(dataset)
        source = source or os.path.basename(path)
        period = str(period).strip()
        part = str(part or "").strip()

        with open(path, newline="", encoding="utf-8-sig", errors="replace") as fh:
            reader = csv.reader(fh)
            try:
                header = next(reader)
            except StopIteration:
                raise DataStoreError("that file is empty")
            if not header:
                raise DataStoreError("that file has no header row")

            cols, seen = [], {}
            for i, h in enumerate(header):
                c = slug(h, "col%d" % (i + 1))
                if c in seen:                      # duplicate headings happen
                    seen[c] += 1
                    c = "%s_%d" % (c, seen[c])
                else:
                    seen[c] = 0
                cols.append(c)

            self._ensure_table(table, cols)
            ncols = len(cols)
            placeholders = ",".join("?" * (4 + ncols))
            sql = 'INSERT INTO %s (_period,_source,_rowno,_part,%s) VALUES (%s)' % (
                table, ",".join('"%s"' % c for c in cols), placeholders)

            t0 = time.time()
            n = 0
            # Every index has to be updated for every row inserted, and that
            # cost grows with the table: the third month took three times the
            # first. Setting them aside for the load and rebuilding once at
            # the end does the same work in one pass over the finished data.
            self._drop_indexes(table)
            try:
                self.con.execute("BEGIN")
                # COALESCE so rows written before parts existed (NULL) are
                # treated as the unnamed part rather than surviving forever.
                self.con.execute(
                    "DELETE FROM %s WHERE _period=? AND COALESCE(_part,'')=?" % table,
                    (period, part))
                batch = []
                for row in reader:
                    n += 1
                    if len(row) < ncols:
                        row = row + [""] * (ncols - len(row))
                    elif len(row) > ncols:
                        row = row[:ncols]          # trailing junk, not our business
                    batch.append((period, source, n, part, *row))
                    if len(batch) >= BATCH:
                        self.con.executemany(sql, batch)
                        batch = []
                        if progress:
                            progress(n)
                if batch:
                    self.con.executemany(sql, batch)
                self.con.execute(
                    "INSERT OR REPLACE INTO _imports VALUES (?,?,?,?,?,?,?)",
                    (dataset, period, part, source, n, ncols, int(time.time() * 1000)))
                self.con.commit()
            except Exception:
                self.con.rollback()
                raise
            finally:
                # Rebuilt even if the load failed, so a bad import never
                # leaves the store slow to search.
                self._build_indexes(table, cols)
        return {"dataset": dataset, "period": period, "part": part, "source": source,
                "rows": n, "columns": ncols, "seconds": round(time.time() - t0, 1)}

    def _drop_indexes(self, table):
        """Remove the lookup indexes (never the _period one, which is small
        and is what the DELETE at the start of an import relies on)."""
        rows = self.con.execute(
            "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=?", (table,)).fetchall()
        for (name,) in rows:
            if not name or name.startswith("sqlite_") or name.endswith("_period"):
                continue
            self.con.execute('DROP INDEX IF EXISTS "%s"' % name)
        self.con.commit()

    def _build_indexes(self, table, cols):
        """Index the columns people look one record up by.

        Built after loading, not during: on a million-row month that is the
        difference between a lookup taking a third of a second and taking
        none at all, and building them afterwards is much the faster way
        round.
        """
        for c in cols:
            if not KEYISH.search(c):
                continue
            name = "ix_%s_%s" % (table, c)
            try:
                self.con.execute('CREATE INDEX IF NOT EXISTS "%s" ON %s("%s")' % (name, table, c))
            except sqlite3.OperationalError:
                pass
        self.con.commit()

    # ---- reading --------------------------------------------------------
    def datasets(self):
        """What is in the store, grouped by dataset then period.

        A period can be made of several parts, so each period reports its
        parts as well as its total -- otherwise a COGS month built from three
        files would look like three separate months.
        """
        out = {}
        for ds, per, part, src, rows, ncols, at in self.con.execute(
                "SELECT dataset,period,part,source,rows,columns,imported_at "
                "FROM _imports ORDER BY dataset,period,part"):
            d = out.setdefault(ds, {"dataset": ds, "periods": [], "rows": 0})
            slot = next((p for p in d["periods"] if p["period"] == per), None)
            if slot is None:
                slot = {"period": per, "source": src, "rows": 0, "columns": ncols,
                        "importedAt": at, "parts": []}
                d["periods"].append(slot)
            slot["parts"].append({"part": part or "", "source": src, "rows": rows,
                                  "columns": ncols, "importedAt": at})
            slot["rows"] += rows
            if at > slot["importedAt"]:
                slot["importedAt"] = at
                slot["source"] = src
            d["rows"] += rows
        return list(out.values())

    def columns(self, dataset):
        cols = self._existing_columns(self._table(dataset))
        return [c for c in cols if c not in META]

    def _where(self, dataset, periods=None, filters=None):
        clauses, args = [], []
        if periods:
            clauses.append("_period IN (%s)" % ",".join("?" * len(periods)))
            args += list(periods)
        known = set(self._existing_columns(self._table(dataset)))
        for col, val in (filters or {}).items():
            c = slug(col)
            if c not in known:
                raise DataStoreError("no column %r in %s" % (col, dataset))
            if isinstance(val, str) and val.endswith("*"):
                clauses.append('"%s" LIKE ?' % c)
                args.append(val[:-1] + "%")
            else:
                clauses.append('"%s" = ?' % c)
                args.append(val)
        return (" WHERE " + " AND ".join(clauses) if clauses else ""), args

    def count(self, dataset, periods=None, filters=None):
        where, args = self._where(dataset, periods, filters)
        return self.con.execute("SELECT COUNT(*) FROM %s%s" % (self._table(dataset), where),
                                args).fetchone()[0]

    def rows(self, dataset, periods=None, filters=None, limit=None, offset=0):
        """Streams matching rows. Never materialises the whole result."""
        table = self._table(dataset)
        cols = self._existing_columns(table)
        where, args = self._where(dataset, periods, filters)
        sql = "SELECT %s FROM %s%s" % (",".join('"%s"' % c for c in cols), table, where)
        if limit is not None:
            sql += " LIMIT ? OFFSET ?"
            args = args + [int(limit), int(offset)]
        cur = self.con.execute(sql, args)
        yield cols
        while True:
            chunk = cur.fetchmany(2000)
            if not chunk:
                break
            for r in chunk:
                yield list(r)

    def export_csv(self, out, dataset, periods=None, filters=None, limit=None):
        w = csv.writer(out)
        n = -1
        for row in self.rows(dataset, periods, filters, limit):
            w.writerow(row)
            n += 1
        return n

    def drop(self, dataset, period=None, part=None):
        table = self._table(dataset)
        if period and part is not None:
            # One part of one month, leaving the rest of that month alone.
            self.con.execute("DELETE FROM %s WHERE _period=? AND COALESCE(_part,'')=?" % table,
                             (period, part))
            self.con.execute("DELETE FROM _imports WHERE dataset=? AND period=? AND part=?",
                             (dataset, period, part))
        elif period:
            self.con.execute("DELETE FROM %s WHERE _period=?" % table, (period,))
            self.con.execute("DELETE FROM _imports WHERE dataset=? AND period=?", (dataset, period))
        else:
            self.con.execute("DROP TABLE IF EXISTS %s" % table)
            self.con.execute("DELETE FROM _imports WHERE dataset=?", (dataset,))
        self.con.commit()
