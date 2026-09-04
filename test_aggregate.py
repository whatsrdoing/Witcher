#!/usr/bin/env python3
"""Checks datastore.aggregate() returns exactly what the dashboards' own
JavaScript would compute over the same rows.

    python3 test_aggregate.py

The point of these tests is not that SQL can add up -- it is that the SQL
adds up *the same way the browser does*, over the messy TEXT that a real
register actually contains: Indian lakh/crore commas, 'dd-mm-yyyy hh:mm'
dates, blank cells, and text where a number should be. Every expected value
below is what parseNum()/parseTransferDate() in the dashboards produce for
that same input, worked out by hand and written as a literal -- not
recomputed here by the code under test.

Uses a temporary data directory, never the real one. Exit code 0 = all good.
"""
import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import datastore

passed = failed = 0


def check(label, ok, detail=""):
    global passed, failed
    if ok:
        passed += 1
        print("  PASS  %s" % label)
    else:
        failed += 1
        print("  FAIL  %s%s" % (label, ("  -- " + detail) if detail else ""))


def close(a, b, eps=1e-9):
    return abs(float(a) - float(b)) < eps


# Deliberately messy, exactly like a real STRPIR export: lakh-style commas,
# a blank quantity, a junk rate, and dates spread across two months.
ROWS = [
    # Transfer Date,      Transfer No., From Store, To Store,   Item Name, Transfered Qty., EPR
    ("01-07-2026 10:00", "TN-1", "Main", "Pharm A", "Paracetamol", "100",     "2.50"),
    ("15-07-2026 11:30", "TN-2", "Main", "Pharm B", "Ibuprofen",   "1,200",   "3.20"),
    ("20-07-2026 09:15", "TN-2", "Pharm A", "Pharm C", "Amoxicillin", "30",   "8.10"),
    ("05-08-2026 14:00", "TN-3", "Main", "Pharm A", "Paracetamol", "1,84,599", "1.00"),
    ("18-08-2026 16:45", "TN-4", "Main", "Pharm C", "Cetirizine",  "",        "1.75"),
    ("31-08-2026 08:30", "TN-5", "Pharm B", "Pharm A", "Ibuprofen", "60",     "junk"),
]
HEADER = ["Transfer Date", "Transfer No.", "From Store", "To Store",
          "Item Name", "Transfered Qty.", "EPR"]

# What the browser's parseNum() makes of that quantity column:
#   "100" -> 100, "1,200" -> 1200, "30" -> 30, "1,84,599" -> 184599,
#   "" -> 0 (parseFloat('') is NaN -> 0), "60" -> 60
QTY = [100.0, 1200.0, 30.0, 184599.0, 0.0, 60.0]
# ...and of the EPR column: "junk" -> NaN -> 0
EPR = [2.50, 3.20, 8.10, 1.00, 1.75, 0.0]
TOTAL_QTY = sum(QTY)                                   # 185989.0
TOTAL_EPR = sum(q * e for q, e in zip(QTY, EPR))       # qty x EPR, summed


def seed(tmp):
    csv_path = os.path.join(tmp, "transfers.csv")
    with open(csv_path, "w", encoding="utf-8", newline="") as fh:
        fh.write(",".join('"%s"' % h for h in HEADER) + "\n")
        for r in ROWS:
            fh.write(",".join('"%s"' % v for v in r) + "\n")
    store = datastore.DataStore(os.path.join(tmp, "library.db"))
    store.import_csv(csv_path, "stock-transfer", "2026-07", source="transfers.csv")
    return store


def test_numbers_match_parsenum():
    tmp = tempfile.mkdtemp(prefix="paras-agg-")
    try:
        store = seed(tmp)
        out = store.aggregate("stock-transfer", [
            {"fn": "count", "as": "lineItems"},
            {"fn": "count_distinct", "col": "Transfer No.", "as": "notes"},
            {"fn": "sum", "col": "Transfered Qty.", "as": "qty"},
            {"fn": "sum_product", "cols": ["Transfered Qty.", "EPR"], "as": "epr"},
        ])
        row = dict(zip(out["columns"], out["rows"][0]))

        check("counts every row", row["lineItems"] == len(ROWS))
        # TN-2 appears twice, so five distinct notes across six rows.
        check("count_distinct ignores repeats", row["notes"] == 5,
              "got %r" % row["notes"])
        check("lakh commas parsed like parseNum ('1,84,599' -> 184599)",
              close(row["qty"], TOTAL_QTY), "got %r want %r" % (row["qty"], TOTAL_QTY))
        check("blank cell counts as 0, not NULL", close(row["qty"], TOTAL_QTY))
        check("qty x EPR matches the browser, junk rate as 0",
              close(row["epr"], TOTAL_EPR), "got %r want %r" % (row["epr"], TOTAL_EPR))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_date_range_is_real_dates_not_text():
    tmp = tempfile.mkdtemp(prefix="paras-agg-")
    try:
        store = seed(tmp)
        # August only. Sorting 'dd-mm-yyyy' as plain text would put
        # '05-08-2026' before '15-07-2026' and get this wrong.
        aug = store.aggregate("stock-transfer",
                              [{"fn": "sum", "col": "Transfered Qty.", "as": "qty"},
                               {"fn": "count", "as": "n"}],
                              date_col="Transfer Date",
                              date_from="2026-08-01", date_to="2026-08-31")
        row = dict(zip(aug["columns"], aug["rows"][0]))
        check("August range picks exactly the three August rows", row["n"] == 3,
              "got %r" % row["n"])
        check("August quantity matches parseNum totals",
              close(row["qty"], 184599.0 + 0.0 + 60.0), "got %r" % row["qty"])

        jul = store.aggregate("stock-transfer",
                              [{"fn": "sum", "col": "Transfered Qty.", "as": "qty"}],
                              date_col="Transfer Date",
                              date_from="2026-07-01", date_to="2026-07-31")
        check("July quantity matches parseNum totals",
              close(jul["rows"][0][0], 100.0 + 1200.0 + 30.0),
              "got %r" % jul["rows"][0][0])

        # A single day, inclusive at both ends.
        one = store.aggregate("stock-transfer", [{"fn": "count", "as": "n"}],
                              date_col="Transfer Date",
                              date_from="2026-07-15", date_to="2026-07-15")
        check("range is inclusive at both ends", one["rows"][0][0] == 1)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_group_by():
    tmp = tempfile.mkdtemp(prefix="paras-agg-")
    try:
        store = seed(tmp)
        lanes = store.aggregate("stock-transfer",
                                [{"fn": "sum", "col": "Transfered Qty.", "as": "qty"}],
                                group_by=["From Store", "To Store"],
                                order_by="qty", descending=True)
        check("grouping by a store pair returns one row per real lane",
              len(lanes["rows"]) == 5, "got %d" % len(lanes["rows"]))
        top = lanes["rows"][0]
        check("ordered by the measure, biggest first",
              top[0] == "Main" and top[1] == "Pharm A" and close(top[2], 100.0 + 184599.0),
              "got %r" % (top,))

        months = store.aggregate("stock-transfer",
                                 [{"fn": "sum", "col": "Transfered Qty.", "as": "qty"}],
                                 group_by=[{"col": "Transfer Date", "by": "month",
                                            "as": "month"}],
                                 order_by="month", descending=False)
        got = {m: q for m, q in months["rows"]}
        check("grouping by month buckets on yyyy-mm, not on the raw text",
              sorted(got) == ["2026-07", "2026-08"], "got %r" % sorted(got))
        check("July bucket totals correctly", close(got["2026-07"], 1330.0))
        check("August bucket totals correctly", close(got["2026-08"], 184659.0))

        limited = store.aggregate("stock-transfer",
                                  [{"fn": "sum", "col": "Transfered Qty.", "as": "qty"}],
                                  group_by=["Item Name"], order_by="qty", limit=2)
        check("limit returns the top N only", len(limited["rows"]) == 2)
        check("top item is the one with the largest total",
              limited["rows"][0][0] == "Paracetamol")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_rejects_bad_input():
    tmp = tempfile.mkdtemp(prefix="paras-agg-")
    try:
        store = seed(tmp)

        def rejects(label, **kw):
            try:
                store.aggregate("stock-transfer", **kw)
            except datastore.DataStoreError:
                check(label, True)
            except Exception as exc:                      # noqa: BLE001
                check(label, False, "raised %s instead" % type(exc).__name__)
            else:
                check(label, False, "was accepted")

        rejects("unknown column is refused",
                measures=[{"fn": "sum", "col": "No Such Column"}])
        rejects("unknown function is refused",
                measures=[{"fn": "drop table", "col": "EPR"}])
        rejects("no measures is refused", measures=[])
        rejects("SQL in a column name is refused, not interpolated",
                measures=[{"fn": "sum", "col": 'EPR" ; DROP TABLE ds_stock_transfer --'}])
        rejects("SQL in a group-by is refused",
                measures=[{"fn": "count"}],
                group_by=['From Store" ; DELETE FROM ds_stock_transfer --'])
        rejects("ordering by something not selected is refused",
                measures=[{"fn": "count", "as": "n"}], order_by="qty")
        rejects("sum_product with one column is refused",
                measures=[{"fn": "sum_product", "cols": ["EPR"]}])

        # ...and the table is still intact after all that.
        still = store.aggregate("stock-transfer", [{"fn": "count", "as": "n"}])
        check("table survived the rejected inputs", still["rows"][0][0] == len(ROWS))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_periods_and_filters():
    tmp = tempfile.mkdtemp(prefix="paras-agg-")
    try:
        store = seed(tmp)
        csv2 = os.path.join(tmp, "sep.csv")
        with open(csv2, "w", encoding="utf-8", newline="") as fh:
            fh.write(",".join('"%s"' % h for h in HEADER) + "\n")
            fh.write('"02-09-2026 10:00","TN-9","Main","Pharm A","Paracetamol","7","2.00"\n')
        store.import_csv(csv2, "stock-transfer", "2026-09", source="sep.csv")

        both = store.aggregate("stock-transfer", [{"fn": "count", "as": "n"}])
        check("both months present after a second import", both["rows"][0][0] == 7)

        one = store.aggregate("stock-transfer", [{"fn": "count", "as": "n"}],
                              periods=["2026-09"])
        check("periods filter narrows to one month", one["rows"][0][0] == 1)

        filt = store.aggregate("stock-transfer",
                               [{"fn": "sum", "col": "Transfered Qty.", "as": "qty"}],
                               filters={"From Store": "Pharm B"})
        check("column filter narrows correctly", close(filt["rows"][0][0], 60.0),
              "got %r" % filt["rows"][0][0])
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main():
    test_numbers_match_parsenum()
    test_date_range_is_real_dates_not_text()
    test_group_by()
    test_rejects_bad_input()
    test_periods_and_filters()
    print("\n%d passed, %d failed" % (passed, failed))
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
