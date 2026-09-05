#!/usr/bin/env python3
"""Checks an export can be read back with the headings the file arrived with.

    python3 test_export_headings.py

A heading becomes a safe SQL identifier on the way in ("PO Amount" ->
PO_Amount, "PO Qty." -> PO_Qty), and a dashboard reading the export looks for
the original wording. Getting that mapping wrong is silent: a column a
dashboard cannot find reads as blank, every figure derived from it becomes
zero, and the dashboard still reports a successful load. That is exactly what
happened to the Procurement dashboard, so these tests exist to make that
class of failure loud.

Uses a temporary data directory, never the real one. Exit code 0 = all good.
"""
import io
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


# Headings picked to cover every way slug() rewrites one: a space, a trailing
# period, a percent sign, a slash, a leading digit, and a pair that collide.
HEADER = ["UNIT", "PO No.", "PO Amount", "PO Qty.", "GST %", "Item/Code",
          "2nd Approver", "Supplier Name", "PO No"]
ROWS = [
    ["GGN", "PO-1", "1,84,599.45", "10", "18", "IT1", "boss", "Acme Ltd", "PO-1-ALT"],
    ["KNP", "PO-2", "11,251.55", "5", "12", "IT2", "other", "Beta Ltd", "PO-2-ALT"],
]


def seed(tmp, header=None, rows=None, dataset="purchase-register", period="2026-07"):
    path = os.path.join(tmp, "reg-%s-%s.csv" % (dataset, period))
    with open(path, "w", newline="", encoding="utf-8") as fh:
        fh.write(",".join('"%s"' % h for h in (header or HEADER)) + "\n")
        for r in (rows or ROWS):
            fh.write(",".join('"%s"' % v for v in r) + "\n")
    store = datastore.DataStore(os.path.join(tmp, "library.db"))
    store.import_csv(path, dataset, period, source=os.path.basename(path))
    return store


def export(store, dataset, **kw):
    buf = io.StringIO()
    store.export_csv(buf, dataset, **kw)
    return buf.getvalue().splitlines()


def test_headings_round_trip():
    tmp = tempfile.mkdtemp(prefix="paras-hdr-")
    try:
        store = seed(tmp)
        lines = export(store, "purchase-register", original_headers=True, include_meta=False)
        got = next(__import__("csv").reader([lines[0]]))
        check("every heading comes back exactly as imported", got == HEADER,
              "got %r" % (got,))
        check("a trailing period survives ('PO Qty.')", "PO Qty." in got)
        check("a percent sign survives ('GST %')", "GST %" in got)
        check("a slash survives ('Item/Code')", "Item/Code" in got)
        check("a heading starting with a digit survives ('2nd Approver')",
              "2nd Approver" in got)
        # "PO No." and "PO No" both slug to PO_No; the importer keeps them
        # apart as PO_No and PO_No_1, and both must map back to their own text.
        check("two headings that slug alike stay distinct",
              got.count("PO No.") == 1 and got.count("PO No") == 1)

        body = next(__import__("csv").reader([lines[1]]))
        check("row values are unchanged", body == ROWS[0], "got %r" % (body,))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_meta_columns_can_be_left_out():
    tmp = tempfile.mkdtemp(prefix="paras-hdr-")
    try:
        store = seed(tmp)
        with_meta = export(store, "purchase-register")
        without = export(store, "purchase-register", include_meta=False)
        head_with = next(__import__("csv").reader([with_meta[0]]))
        head_without = next(__import__("csv").reader([without[0]]))

        check("meta columns are present by default",
              all(c in head_with for c in datastore.META))
        check("include_meta=False drops exactly the four meta columns",
              [c for c in head_without if c in datastore.META] == []
              and len(head_without) == len(head_with) - len(datastore.META),
              "got %r" % (head_without,))
        # A register with no parts has a blank _part on every row; a consumer
        # that scans for empty columns counts that as a data-quality problem,
        # which is why leaving it out matters rather than being cosmetic.
        check("no blank _part column is exposed to a consumer",
              "_part" not in head_without)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_defaults_are_unchanged():
    """The old behaviour is still the default, so nothing that called this
    before these options existed sees a different export."""
    tmp = tempfile.mkdtemp(prefix="paras-hdr-")
    try:
        store = seed(tmp)
        lines = export(store, "purchase-register")
        head = next(__import__("csv").reader([lines[0]]))
        check("default export still starts with the meta columns",
              head[:4] == list(datastore.META), "got %r" % (head[:4],))
        check("default export still uses SQL identifiers",
              "PO_Amount" in head and "PO Amount" not in head)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_latest_import_wins_a_renamed_column():
    tmp = tempfile.mkdtemp(prefix="paras-hdr-")
    try:
        store = seed(tmp)
        # August arrives with the same column worded differently. Same slug,
        # so it is the same column in the table; the newer wording is what a
        # dashboard should be handed.
        aug = list(HEADER)
        aug[aug.index("PO Amount")] = "PO  Amount"
        seed(tmp, header=aug, period="2026-08")
        store = datastore.DataStore(os.path.join(tmp, "library.db"))
        head = next(__import__("csv").reader(
            [export(store, "purchase-register", original_headers=True, include_meta=False)[0]]))
        check("the most recent import's wording is the one returned",
              "PO  Amount" in head, "got %r" % (head,))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_store_written_before_headings_were_kept():
    """A database imported by an older build has no headings on record. It
    must still export -- falling back to the identifiers, exactly as it did
    before -- rather than failing or inventing names."""
    tmp = tempfile.mkdtemp(prefix="paras-hdr-")
    try:
        store = seed(tmp)
        store.con.execute("UPDATE _imports SET headers=NULL")
        store.con.commit()
        check("header_map is empty when nothing was recorded",
              store.header_map("purchase-register") == {})
        head = next(__import__("csv").reader(
            [export(store, "purchase-register", original_headers=True, include_meta=False)[0]]))
        check("export falls back to the identifiers, and still works",
              "PO_Amount" in head, "got %r" % (head,))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_periods_scope_the_export():
    tmp = tempfile.mkdtemp(prefix="paras-hdr-")
    try:
        seed(tmp)
        seed(tmp, period="2026-08")
        store = datastore.DataStore(os.path.join(tmp, "library.db"))
        both = export(store, "purchase-register", include_meta=False)
        one = export(store, "purchase-register", periods=["2026-08"], include_meta=False)
        check("both months are there when no period is named", len(both) - 1 == 4,
              "got %d rows" % (len(both) - 1))
        check("naming one period returns only that month", len(one) - 1 == 2,
              "got %d rows" % (len(one) - 1))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main():
    test_headings_round_trip()
    test_meta_columns_can_be_left_out()
    test_defaults_are_unchanged()
    test_latest_import_wins_a_renamed_column()
    test_store_written_before_headings_were_kept()
    test_periods_scope_the_export()
    print("\n%d passed, %d failed" % (passed, failed))
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
