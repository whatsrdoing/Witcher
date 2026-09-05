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
import json
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
        self._migrate_headers()

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

    def _migrate_headers(self):
        """Remember each import's original column headings.

        A heading becomes a safe SQL identifier on the way in (slug(): "PO
        Amount" -> PO_Amount, "EPR." -> EPR), and until now that was the only
        form kept. Anything reading the data back therefore had to guess the
        original wording, and a consumer that guessed wrong got a column it
        could not find -- silently, because a missing column reads as blank
        rather than raising.

        Storing the headings the file actually arrived with removes the guess
        entirely. Added rather than rebuilt: ALTER TABLE ADD COLUMN is cheap
        and non-destructive, and rows imported before this stay readable with
        headers NULL, which header_map() below treats as "no record, fall
        back to the identifier" exactly as it behaved before.
        """
        cols = [r[1] for r in self.con.execute("PRAGMA table_info(_imports)")]
        if "headers" in cols:
            return
        self.con.execute("ALTER TABLE _imports ADD COLUMN headers TEXT")
        self.con.commit()

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
                # cols and header are parallel: cols[i] is the identifier that
                # header[i] became, dedupe suffix included, so the pairing is
                # exact even when a file repeats a heading.
                self.con.execute(
                    "INSERT OR REPLACE INTO _imports VALUES (?,?,?,?,?,?,?,?)",
                    (dataset, period, part, source, n, ncols, int(time.time() * 1000),
                     json.dumps(list(zip(cols, header)))))
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

    # ---- aggregation ----------------------------------------------------
    #
    # Every column in every dataset table is TEXT (see _ensure_table): a CSV
    # import cannot know which columns are meant to be numbers, and guessing
    # per month would make August's schema disagree with July's. That is fine
    # for storage and for export, but it means SUM() and date comparison have
    # to normalise on the way past, or they would quietly return nonsense --
    # SUM('1,84,599.45') is 1 in SQLite, not 184599.45, and 'dd-mm-yyyy'
    # strings sort by day before month.
    #
    # The two helpers below are exact mirrors of what the dashboards' own
    # JavaScript already does to the same values, so a figure computed here
    # equals the figure computed in the browser rather than merely resembling
    # it:
    #
    #   parseNum(s)  -> String(s).replace(/,/g,'').trim() then parseFloat,
    #                   NaN treated as 0.
    #                   CAST(REPLACE(col,',','') AS REAL) matches this
    #                   exactly: SQLite's CAST takes the leading numeric
    #                   prefix and yields 0.0 for text that has none, which
    #                   is parseFloat + the isNaN?0 branch in one step.
    #                   COALESCE covers NULL (a column a later month added,
    #                   read back on an earlier month's rows).
    #
    #   parseTransferDate/dateKey -> 'dd-mm-yyyy hh:mm' read as day, month,
    #                   year and re-emitted as 'yyyy-mm-dd'. Rebuilt here with
    #                   substr() so the result is the same ISO key the
    #                   dashboards filter and group on, and so it sorts and
    #                   compares correctly as text.

    @staticmethod
    def _num_expr(col):
        """One TEXT column read as a number, exactly as parseNum() does."""
        return "COALESCE(CAST(REPLACE(\"%s\", ',', '') AS REAL), 0)" % col

    @staticmethod
    def _date_expr(col):
        """One 'dd-mm-yyyy[ hh:mm]' TEXT column as a sortable 'yyyy-mm-dd'.

        Anything that is not in that shape (an empty cell, a stray header
        repeated mid-file) yields NULL rather than a wrong date, so it drops
        out of a range filter instead of landing in an arbitrary month --
        the same outcome as parseTransferDate() returning null and the row
        being skipped."""
        return ("CASE WHEN substr(\"{c}\",3,1)='-' AND substr(\"{c}\",6,1)='-' "
                "THEN substr(\"{c}\",7,4)||'-'||substr(\"{c}\",4,2)||'-'||substr(\"{c}\",1,2) "
                "END").format(c=col)

    AGG_FUNCTIONS = ("sum", "avg", "min", "max", "count", "count_distinct", "sum_product")

    def _checked_col(self, known, col):
        c = slug(col)
        if c not in known:
            raise DataStoreError("no column %r in this dataset" % col)
        return c

    def aggregate(self, dataset, measures, group_by=None, periods=None, filters=None,
                  date_col=None, date_from=None, date_to=None, order_by=None,
                  descending=True, limit=None):
        """Group and total rows inside SQLite instead of in the browser.

        Returns {"columns": [...], "rows": [[...], ...]} -- already reduced to
        the handful of numbers a dashboard actually draws, so a month of
        20,000 rows crosses the wire as a few hundred bytes.

        Every column name reaching SQL is checked against the table's real
        columns first (same rule as _where), so nothing here interpolates
        caller-supplied text into a statement. Values are always bound.

        measures: [{"fn": ..., "col": ..., "as": ...}]
          count           -- COUNT(*), no column needed
          count_distinct  -- distinct non-empty values of one column
          sum/avg/min/max -- over one column, read as a number
          sum_product     -- SUM(a*b) over two columns, both read as numbers
                             (quantity x rate, which no single column holds)

        group_by: column names, or {"col": ..., "as": ..., "by": "month"|"day"}
          to group a 'dd-mm-yyyy' column by month or day instead of verbatim.

        date_col + date_from/date_to: an inclusive range over a 'dd-mm-yyyy'
          column, compared as 'yyyy-mm-dd' so it means what it says.
        """
        table = self._table(dataset)
        known = set(self._existing_columns(table))
        if not measures:
            raise DataStoreError("at least one measure is required")

        select, names = [], []

        group_exprs = []
        for g in (group_by or []):
            spec = {"col": g} if isinstance(g, str) else dict(g)
            col = self._checked_col(known, spec.get("col"))
            by = spec.get("by")
            if by == "month":
                expr = "substr(%s,1,7)" % self._date_expr(col)
            elif by == "day":
                expr = self._date_expr(col)
            elif by:
                raise DataStoreError("unknown group transform %r" % by)
            else:
                expr = '"%s"' % col
            group_exprs.append(expr)
            select.append(expr)
            names.append(spec.get("as") or col)

        for m in measures:
            if not isinstance(m, dict):
                raise DataStoreError("each measure must be an object")
            fn = str(m.get("fn") or "").lower()
            if fn not in self.AGG_FUNCTIONS:
                raise DataStoreError("unknown measure function %r" % m.get("fn"))
            if fn == "count":
                expr = "COUNT(*)"
            elif fn == "sum_product":
                cols = m.get("cols") or []
                if len(cols) != 2:
                    raise DataStoreError("sum_product needs exactly two columns")
                a = self._checked_col(known, cols[0])
                b = self._checked_col(known, cols[1])
                expr = "SUM(%s * %s)" % (self._num_expr(a), self._num_expr(b))
            elif fn == "count_distinct":
                c = self._checked_col(known, m.get("col"))
                # Blank cells are not a value anyone counts -- the browser's
                # Set-based equivalents never add an empty string either.
                expr = "COUNT(DISTINCT NULLIF(TRIM(\"%s\"), ''))" % c
            else:
                c = self._checked_col(known, m.get("col"))
                expr = "%s(%s)" % (fn.upper(), self._num_expr(c))
            select.append(expr)
            names.append(m.get("as") or fn)

        where, args = self._where(dataset, periods, filters)

        if date_col and (date_from or date_to):
            dcol = self._checked_col(known, date_col)
            dexpr = self._date_expr(dcol)
            parts = []
            if date_from:
                parts.append("%s >= ?" % dexpr)
                args.append(str(date_from))
            if date_to:
                parts.append("%s <= ?" % dexpr)
                args.append(str(date_to))
            clause = " AND ".join(parts)
            where = (where + " AND " + clause) if where else (" WHERE " + clause)

        sql = "SELECT %s FROM %s%s" % (", ".join(select), table, where)
        if group_exprs:
            sql += " GROUP BY " + ", ".join(group_exprs)

        if order_by is not None:
            if isinstance(order_by, int):
                idx = order_by
            else:
                if order_by not in names:
                    raise DataStoreError("cannot order by %r -- not selected" % order_by)
                idx = names.index(order_by)
            if not 0 <= idx < len(names):
                raise DataStoreError("order_by out of range")
            # Ordinal, not the expression again: SQLite resolves it against
            # the select list, and it cannot carry caller text into the SQL.
            sql += " ORDER BY %d %s" % (idx + 1, "DESC" if descending else "ASC")

        if limit is not None:
            sql += " LIMIT ?"
            args = args + [int(limit)]

        rows = [list(r) for r in self.con.execute(sql, args).fetchall()]
        return {"columns": names, "rows": rows}

    def header_map(self, dataset):
        """{identifier: the heading the file actually arrived with}.

        Built from what import_csv recorded, most recent import last so a
        register that renamed a column between months reports its current
        wording. Identifiers with nothing on record -- imported before
        headers were kept, or a column only an older month had -- are simply
        absent, and callers fall back to the identifier itself.
        """
        out = {}
        try:
            rows = self.con.execute(
                "SELECT headers FROM _imports WHERE dataset=? ORDER BY imported_at ASC",
                (dataset,)).fetchall()
        except sqlite3.OperationalError:
            return out
        for (blob,) in rows:
            if not blob:
                continue
            try:
                pairs = json.loads(blob)
            except ValueError:
                continue
            for pair in pairs:
                if isinstance(pair, (list, tuple)) and len(pair) == 2 and pair[1]:
                    out[pair[0]] = pair[1]
        return out

    def rows(self, dataset, periods=None, filters=None, limit=None, offset=0,
             original_headers=False, include_meta=True):
        """Streams matching rows. Never materialises the whole result.

        original_headers replaces the SQL identifiers in the header row with
        the headings the files were imported with (see header_map), so a
        consumer that only knows the register's own wording can read the
        export without translating anything.

        include_meta=False drops the four bookkeeping columns this store adds
        (_period, _source, _rowno, _part). They are the store's record of
        where a row came from, not part of the register, and a consumer that
        treats every column as data will otherwise count them -- a blank
        _part on a register that has no parts reads as an empty column.
        """
        table = self._table(dataset)
        cols = self._existing_columns(table)
        if not include_meta:
            cols = [c for c in cols if c not in META]
        if not cols:
            yield []
            return
        where, args = self._where(dataset, periods, filters)
        sql = "SELECT %s FROM %s%s" % (",".join('"%s"' % c for c in cols), table, where)
        if limit is not None:
            sql += " LIMIT ? OFFSET ?"
            args = args + [int(limit), int(offset)]
        cur = self.con.execute(sql, args)
        if original_headers:
            names = self.header_map(dataset)
            yield [names.get(c, c) for c in cols]
        else:
            yield cols
        while True:
            chunk = cur.fetchmany(2000)
            if not chunk:
                break
            for r in chunk:
                yield list(r)

    def export_csv(self, out, dataset, periods=None, filters=None, limit=None,
                   original_headers=False, include_meta=True):
        w = csv.writer(out)
        n = -1
        for row in self.rows(dataset, periods, filters, limit,
                             original_headers=original_headers, include_meta=include_meta):
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
