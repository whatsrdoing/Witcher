#!/usr/bin/env python3
"""Checks the month-on-month store keeps every row exactly as given.

    python3 test_datastore.py

Uses a temporary database, never data/library.db. Exit code 0 = all good.
"""
import io
import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from datastore import DataStore, DataStoreError, slug   # noqa: E402

passed = failed = 0


def check(label, ok, detail=""):
    global passed, failed
    if ok:
        passed += 1
        print("  PASS  %s" % label)
    else:
        failed += 1
        print("  FAIL  %s%s" % (label, ("  -- " + detail) if detail else ""))


def write(path, text):
    with open(path, "w", newline="", encoding="utf-8") as fh:
        fh.write(text)
    return path


def main():
    tmp = tempfile.mkdtemp(prefix="paras-ds-")
    db = DataStore(os.path.join(tmp, "test.db"))
    try:
        july = write(os.path.join(tmp, "july.csv"),
                     "Bill No,Item Code,Store,Qty,Value\n"
                     "B001,IT100,Panipat,10,250.00\n"
                     "B002,IT100,Panipat,5,125.00\n"
                     "B003,IT200,Gurgaon,3,99.50\n")
        aug = write(os.path.join(tmp, "aug.csv"),
                    "Bill No,Item Code,Store,Qty,Value\n"
                    "B010,IT100,Panipat,7,175.00\n"
                    "B011,IT300,Ranchi,2,60.00\n")

        r = db.import_csv(july, "cogs", "2026-07")
        check("import July", r["rows"] == 3, "got %s" % r["rows"])
        db.import_csv(aug, "cogs", "2026-08")

        check("both months stored", db.count("cogs") == 5, "got %d" % db.count("cogs"))
        check("one month filterable", db.count("cogs", ["2026-07"]) == 3)

        # every row kept, nothing merged or dropped
        rows = list(db.rows("cogs", ["2026-07"]))
        check("all raw rows kept (no summarising)", len(rows) - 1 == 3)

        # the detail lookup this whole thing exists for
        hdr, *hit = list(db.rows("cogs", filters={"Bill_No": "B003"}))
        check("find one bill across months", len(hit) == 1 and "B003" in hit[0])

        # an item's history across months
        it = db.count("cogs", filters={"Item_Code": "IT100"})
        check("one item across all months", it == 3, "got %d" % it)

        # re-import must replace, not duplicate -- the silent-doubling trap
        db.import_csv(july, "cogs", "2026-07")
        check("re-importing July does not duplicate", db.count("cogs") == 5,
              "got %d" % db.count("cogs"))

        # values must survive byte-for-byte: leading zeros, commas, brackets,
        # a big number -- anything that a type-guessing importer would mangle
        odd = write(os.path.join(tmp, "odd.csv"),
                    "Item Code,Amount,Note\n"
                    "007,\"1,250.00\",ok\n"
                    "0012,(45),negative in brackets\n"
                    "IT9,00123,leading zeros\n")
        db.import_csv(odd, "odd", "2026-07")
        out = list(db.rows("odd"))
        hd = out[0]                      # rows() yields the header first; data
        ic, am = hd.index("Item_Code"), hd.index("Amount")   # columns follow _period/_source/_rowno
        got = {r[ic]: (r[am],) for r in out[1:]}
        check("leading zeros preserved ('007')", "007" in got, str(list(got)))
        check("thousands separator preserved ('1,250.00')", got.get("007", ("",))[0] == "1,250.00",
              repr(got.get("007")))
        check("bracketed negative preserved ('(45)')", got.get("0012", ("",))[0] == "(45)",
              repr(got.get("0012")))
        check("leading-zero number preserved ('00123')", got.get("IT9", ("",))[0] == "00123",
              repr(got.get("IT9")))

        # a later month gaining a column must not orphan the earlier one
        sep = write(os.path.join(tmp, "sep.csv"),
                    "Bill No,Item Code,Store,Qty,Value,Batch No\n"
                    "B020,IT100,Patna,4,100.00,BT77\n")
        db.import_csv(sep, "cogs", "2026-09")
        check("new column in a later month accepted", "Batch_No" in db.columns("cogs"))
        check("earlier months still readable", db.count("cogs", ["2026-07"]) == 3)
        check("total across three months", db.count("cogs") == 6, "got %d" % db.count("cogs"))

        # ragged rows: short and long lines are normal in real exports
        ragged = write(os.path.join(tmp, "ragged.csv"),
                       "A,B,C\n1,2,3\n4,5\n6,7,8,9\n")
        rr = db.import_csv(ragged, "ragged", "2026-07")
        check("ragged rows imported without failing", rr["rows"] == 3, "got %s" % rr["rows"])
        rout = list(db.rows("ragged"))
        a = rout[0].index("A")           # skip the meta columns by name
        vals = [r[a:a + 3] for r in rout[1:]]
        check("short row padded, long row trimmed",
              vals[1] == ["4", "5", ""] and vals[2] == ["6", "7", "8"], str(vals))

        # export must round-trip
        buf = io.StringIO()
        n = db.export_csv(buf, "cogs", ["2026-08"])
        check("export writes the matching rows", n == 2, "got %s" % n)
        check("export includes a header", buf.getvalue().splitlines()[0].startswith("_period"))

        # a bad dataset name must never reach SQL
        try:
            db.count("cogs; DROP TABLE ds_cogs")
            hit_sql = True
        except Exception:
            hit_sql = False
        check("injection-shaped dataset name rejected/neutralised",
              not hit_sql or db.count("cogs") == 6)
        check("unknown filter column rejected",
              _raises(db.count, "cogs", None, {"nope": "x"}))
        check("missing period rejected", _raises(db.import_csv, july, "cogs", ""))

        # dropping one month leaves the others
        db.drop("cogs", "2026-07")
        check("dropping one month leaves the rest", db.count("cogs") == 3,
              "got %d" % db.count("cogs"))

        print("\n%d passed, %d failed" % (passed, failed))
        return 1 if failed else 0
    finally:
        db.close()
        shutil.rmtree(tmp, ignore_errors=True)


def _raises(fn, *a):
    try:
        fn(*a)
        return False
    except Exception:
        return True


if __name__ == "__main__":
    raise SystemExit(main())
