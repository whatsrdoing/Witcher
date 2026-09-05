#!/usr/bin/env python3
"""Checks appstore.py's dashboard_cache table -- the fingerprinting a
dashboard's server-side cache lives and dies by, and a plain read/write
round trip -- without going anywhere near a browser or serve.py's HTTP
layer.

    python3 test_dashboard_cache.py

Uses a temporary data directory (PARAS_DATA_DIR) for every phase, never the
real data folder. Exit code 0 = all good.
"""
import csv
import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

passed = failed = 0


def check(label, ok, detail=""):
    global passed, failed
    if ok:
        passed += 1
        print("  PASS  %s" % label)
    else:
        failed += 1
        print("  FAIL  %s%s" % (label, ("  -- " + detail) if detail else ""))


def fresh_modules(data_dir):
    """Brand-new appstore/datastore/paths modules bound to a fresh data
    directory -- both appstore and datastore cache one open connection per
    process, so each phase below needs its own throwaway pair of databases,
    same idiom test_appstore.py already uses for appstore alone."""
    os.environ["PARAS_DATA_DIR"] = data_dir
    for mod in ("appstore", "datastore", "paths"):
        sys.modules.pop(mod, None)
    import paths as p
    p._resolved = None
    import appstore as a
    import datastore as d
    return a, d


def write_csv(path, rows, header):
    with open(path, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(header)
        w.writerows(rows)


HEADER = ["Transfer Date", "From Store", "To Store", "Item Name", "Transfered Qty.", "EPR"]


def test_fingerprint_empty_and_changes():
    tmp = tempfile.mkdtemp(prefix="paras-cache-")
    try:
        a, d = fresh_modules(tmp)
        check("fingerprint of a dataset nobody imported yet is 'empty'",
              a.dataset_fingerprint("stock-transfer") == "empty")

        store = d.DataStore(os.path.join(tmp, "library.db"))
        csv_path = os.path.join(tmp, "april.csv")
        write_csv(csv_path, [["01-04-2026 10:00", "S1", "S2", "Paracetamol", "10", "5.00"]], HEADER)
        store.import_csv(csv_path, "stock-transfer", "2026-04", source="april.csv")

        fp1 = a.dataset_fingerprint("stock-transfer")
        check("fingerprint is no longer 'empty' once something is imported", fp1 != "empty")
        check("fingerprint is stable across repeated calls",
              a.dataset_fingerprint("stock-transfer") == fp1)
        check("a different, never-imported dataset still fingerprints 'empty'",
              a.dataset_fingerprint("purchase-register") == "empty")

        # A second month lands -- the combined fingerprint must move.
        csv_path2 = os.path.join(tmp, "may.csv")
        write_csv(csv_path2, [["05-05-2026 11:00", "S2", "S3", "Paracetamol", "20", "5.00"]], HEADER)
        store.import_csv(csv_path2, "stock-transfer", "2026-05", source="may.csv")
        fp2 = a.dataset_fingerprint("stock-transfer")
        check("importing a second period changes the fingerprint", fp2 != fp1)

        # Re-importing April with different data (a correction) must move it
        # again, even though the set of periods on record did not change.
        write_csv(csv_path, [["01-04-2026 10:00", "S1", "S2", "Paracetamol", "999", "5.00"]], HEADER)
        store.import_csv(csv_path, "stock-transfer", "2026-04", source="april.csv")
        fp3 = a.dataset_fingerprint("stock-transfer")
        check("reimporting an existing period (a correction) changes the fingerprint again",
              fp3 != fp2)

        store.close()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_cache_round_trip_and_invalidation():
    tmp = tempfile.mkdtemp(prefix="paras-cache-")
    try:
        a, d = fresh_modules(tmp)
        check("no cache yet -- read is a clean miss",
              a.read_dashboard_cache("store-transfer", "stock-transfer", "rows") is None)

        store = d.DataStore(os.path.join(tmp, "library.db"))
        csv_path = os.path.join(tmp, "april.csv")
        write_csv(csv_path, [["01-04-2026 10:00", "S1", "S2", "Paracetamol", "10", "5.00"]], HEADER)
        store.import_csv(csv_path, "stock-transfer", "2026-04", source="april.csv")

        fp = a.dataset_fingerprint("stock-transfer")
        payload = {"rows": [{"fromStore": "S1", "toStore": "S2", "itemName": "Paracetamol",
                              "qty": 10, "epr": 5.0, "totalEpr": 50.0, "dateKey": "2026-04-01"}],
                   "hasUnitColumn": False, "label": "test.csv"}
        a.write_dashboard_cache("store-transfer", "stock-transfer", "rows", fp, payload)

        back = a.read_dashboard_cache("store-transfer", "stock-transfer", "rows")
        check("cached payload round-trips exactly", back == payload)

        check("a different kind for the same dashboard/dataset is untouched",
              a.read_dashboard_cache("store-transfer", "stock-transfer", "default_view") is None)
        check("a different dashboard_id never sees this dashboard's cache",
              a.read_dashboard_cache("some-other-dashboard", "stock-transfer", "rows") is None)
        check("a different dataset under the same dashboard_id is untouched",
              a.read_dashboard_cache("store-transfer", "purchase-register", "rows") is None)

        # Reimporting May (new period) must invalidate the April-only cache
        # written above -- the fingerprint it was stamped with no longer
        # matches "current" once the dataset has moved on.
        csv_path2 = os.path.join(tmp, "may.csv")
        write_csv(csv_path2, [["05-05-2026 11:00", "S2", "S3", "Paracetamol", "20", "5.00"]], HEADER)
        store.import_csv(csv_path2, "stock-transfer", "2026-05", source="may.csv")
        check("cache read after a reimport is a miss (stale fingerprint)",
              a.read_dashboard_cache("store-transfer", "stock-transfer", "rows") is None)

        # A write is always stamped with whatever fingerprint the CALLER
        # computed, not one it invents -- writing with a fingerprint that
        # does not match current-right-now (simulating a stale write losing
        # a race) must itself read back as a miss the moment "current" moves
        # past it, exactly like any other stale cache would.
        stale_fp = fp   # the April-only fingerprint, already superseded above
        a.write_dashboard_cache("store-transfer", "stock-transfer", "rows", stale_fp, payload)
        check("a write stamped with an already-stale fingerprint is never served as a hit",
              a.read_dashboard_cache("store-transfer", "stock-transfer", "rows") is None)

        # ...but writing with the real current fingerprint works normally.
        fp2 = a.dataset_fingerprint("stock-transfer")
        payload2 = dict(payload, label="combined.csv")
        a.write_dashboard_cache("store-transfer", "stock-transfer", "rows", fp2, payload2)
        check("a write stamped with the true current fingerprint reads back as a hit",
              a.read_dashboard_cache("store-transfer", "stock-transfer", "rows") == payload2)

        store.close()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_corrupt_payload_is_never_surfaced():
    tmp = tempfile.mkdtemp(prefix="paras-cache-")
    try:
        a, d = fresh_modules(tmp)
        store = d.DataStore(os.path.join(tmp, "library.db"))
        csv_path = os.path.join(tmp, "april.csv")
        write_csv(csv_path, [["01-04-2026 10:00", "S1", "S2", "Paracetamol", "10", "5.00"]], HEADER)
        store.import_csv(csv_path, "stock-transfer", "2026-04", source="april.csv")
        fp = a.dataset_fingerprint("stock-transfer")

        # Write valid JSON through the normal path, then corrupt the row
        # directly -- the way a half-written disk or a manual DB edit could
        # -- and confirm the reader treats it exactly like "never cached"
        # rather than raising or handing back garbage.
        a.write_dashboard_cache("store-transfer", "stock-transfer", "rows", fp, {"rows": []})
        conn = a._connect()
        with a._LOCK, conn:
            conn.execute(
                "UPDATE dashboard_cache SET payload=? "
                "WHERE dashboard_id=? AND dataset=? AND kind=?",
                ("{not valid json", "store-transfer", "stock-transfer", "rows"))
        check("a corrupt payload reads back as a miss, not an exception",
              a.read_dashboard_cache("store-transfer", "stock-transfer", "rows") is None)

        store.close()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_kind_is_isolated_per_dashboard_and_dataset():
    tmp = tempfile.mkdtemp(prefix="paras-cache-")
    try:
        a, d = fresh_modules(tmp)
        store = d.DataStore(os.path.join(tmp, "library.db"))
        csv_path = os.path.join(tmp, "april.csv")
        write_csv(csv_path, [["01-04-2026 10:00", "S1", "S2", "Paracetamol", "10", "5.00"]], HEADER)
        store.import_csv(csv_path, "stock-transfer", "2026-04", source="april.csv")
        fp = a.dataset_fingerprint("stock-transfer")

        a.write_dashboard_cache("store-transfer", "stock-transfer", "rows", fp, {"rows": [1, 2, 3]})
        a.write_dashboard_cache("store-transfer", "stock-transfer", "default_view", fp, {"rowCount": 3})

        check("rows and default_view coexist independently under the same key prefix",
              a.read_dashboard_cache("store-transfer", "stock-transfer", "rows") == {"rows": [1, 2, 3]}
              and a.read_dashboard_cache("store-transfer", "stock-transfer", "default_view") == {"rowCount": 3})

        # Overwriting one kind must not disturb the other.
        a.write_dashboard_cache("store-transfer", "stock-transfer", "rows", fp, {"rows": [9]})
        check("rewriting one kind leaves the other untouched",
              a.read_dashboard_cache("store-transfer", "stock-transfer", "default_view") == {"rowCount": 3})

        store.close()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main():
    test_fingerprint_empty_and_changes()
    test_cache_round_trip_and_invalidation()
    test_corrupt_payload_is_never_surfaced()
    test_kind_is_isolated_per_dashboard_and_dataset()
    print("\n%d passed, %d failed" % (passed, failed))
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
