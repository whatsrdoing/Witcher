#!/usr/bin/env python3
"""Checks who may read which register, and which dashboard pages are servable.

    python3 test_dataset_access.py

Hiding a dashboard used to be a decision made in the browser: app.js filtered
the hub's grid, but the page itself was still served to anyone signed in who
typed its address, and it then loaded its own registers and rendered in full.
These tests pin down the two rules that replaced that:

  - a dashboard marked admin-only is not servable to a non-admin at all;
  - a register no visible dashboard reads is not exportable by a non-admin.

The second rule is deliberately narrow, and the tests say so explicitly: a
register a *visible* dashboard needs has to stay readable, or that dashboard
breaks for every non-admin account. Locking down more than this is a product
decision (mark the dashboard admin-only), not something the data layer should
infer on its own.

Runs a real server on a spare port against a throwaway data directory.
Exit code 0 = all good.
"""
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, ROOT)

passed = failed = 0


def check(label, ok, detail=""):
    global passed, failed
    if ok:
        passed += 1
        print("  PASS  %s" % label)
    else:
        failed += 1
        print("  FAIL  %s%s" % (label, ("  -- " + detail) if detail else ""))


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def request(base, path, token=None, method="GET", body=None):
    req = urllib.request.Request(base + path, method=method)
    if token:
        req.add_header("Cookie", "paras_session=" + token)
    if body is not None:
        req.add_header("Content-Type", "application/json")
        req.data = json.dumps(body).encode()
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")


def sign_in(base, login, password):
    """Mirrors gate.js: the browser derives the digest, the server compares it."""
    import hashlib
    status, body = request(base, "/auth.json")
    auth = json.loads(body)
    acct = next(a for a in auth["accounts"] if a["login"] == login)
    # crypto.js unhexes the salt before deriving (see ParasCrypto.derive), so
    # the bytes -- not the hex text -- are what PBKDF2 is salted with.
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(),
                                 bytes.fromhex(acct["salt"]), acct["iterations"]).hex()
    req = urllib.request.Request(base + "/__session", method="POST")
    req.add_header("Content-Type", "application/json")
    req.data = json.dumps({"login": login, "digest": digest}).encode()
    with urllib.request.urlopen(req, timeout=15) as r:
        cookie = r.headers.get("Set-Cookie") or ""
        r.read()
    for part in cookie.split(";"):
        if part.strip().startswith("paras_session="):
            return part.strip()[len("paras_session="):]
    raise AssertionError("no session cookie for %s" % login)


def main():
    tmp = tempfile.mkdtemp(prefix="paras-access-")
    app = os.path.join(tmp, "app")
    data = os.path.join(tmp, "data")
    shutil.copytree(ROOT, app, ignore=shutil.ignore_patterns(".git", "__pycache__", "*.pyc"))
    os.makedirs(data, exist_ok=True)
    env = dict(os.environ, PARAS_DATA_DIR=data)
    proc = None
    try:
        # Two accounts. The last one written is the primary admin.
        for login, pw in (("staff/nurse", "StaffPass123!x"), ("admin/ritik", "AdminPass123!x")):
            subprocess.run([sys.executable, "set_password.py", login, pw],
                           cwd=app, env=env, capture_output=True, timeout=120)

        # One register a visible dashboard reads, and two restricted ones --
        # "formulary" whose raw name already equals its own slug key, and
        # "expiry-stock" whose does not (it slugs to "expiry_stock"). A fix
        # that compares a restricted set of *keys* against a listing of *raw*
        # names hides the first by coincidence and leaks the second -- seeding
        # only "formulary" is exactly what let that regression pass here once
        # already.
        import datastore
        store = datastore.DataStore(os.path.join(data, "library.db"))
        for dataset, header in (("grn-register", "UNIT,GRN No.,Received Qty."),
                                ("formulary", "ItemId,ITEM NAME,ITEM CODE"),
                                ("expiry-stock", "UNIT,Item Code,Expiry Date")):
            p = os.path.join(tmp, dataset + ".csv")
            with open(p, "w", newline="", encoding="utf-8") as fh:
                fh.write(header + "\nA,B,C\n")
            store.import_csv(p, dataset, "2026-07", source=dataset + ".csv")
        store.close()

        port = free_port()
        base = "http://127.0.0.1:%d/supply-chain/command-centre" % port
        proc = subprocess.Popen([sys.executable, "serve.py", "--port", str(port)],
                                cwd=app, env=env,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(60):
            try:
                request(base, "/")
                break
            except Exception:                             # noqa: BLE001
                time.sleep(0.5)
        else:
            raise AssertionError("server did not start")

        staff = sign_in(base, "staff/nurse", "StaffPass123!x")
        admin = sign_in(base, "admin/ritik", "AdminPass123!x")

        # --- admin-only dashboard pages -------------------------------------
        page = "/dashboards/Data_Health_Check_Dashboard.html"
        s, _ = request(base, page, staff)
        check("non-admin cannot fetch an admin-only dashboard page", s == 404, "got %d" % s)
        s, _ = request(base, page, admin)
        check("admin can fetch it", s == 200, "got %d" % s)
        s, _ = request(base, "/dashboards/Procurement_Dashboard.html", staff)
        check("non-admin can still fetch a visible dashboard page", s == 200, "got %d" % s)

        # --- registers -------------------------------------------------------
        s, _ = request(base, "/__data/formulary/export", staff)
        check("non-admin cannot export a register only an admin-only dashboard reads",
              s == 403, "got %d" % s)
        s, body = request(base, "/__data/grn-register/export", staff)
        check("non-admin can still export a register a visible dashboard needs",
              s == 200 and "GRN" in body, "got %d" % s)
        s, _ = request(base, "/__data/formulary/export", admin)
        check("admin can export it", s == 200, "got %d" % s)

        # --- aggregation follows the same rule -------------------------------
        spec = {"measures": [{"fn": "count", "as": "n"}]}
        s, _ = request(base, "/__agg/formulary", staff, "POST", spec)
        check("non-admin cannot aggregate a restricted register", s == 403, "got %d" % s)
        s, _ = request(base, "/__agg/grn-register", staff, "POST", spec)
        check("non-admin can aggregate an allowed register", s == 200, "got %d" % s)

        # --- the listing must not advertise what it will not serve ------------
        s, body = request(base, "/__data", staff)
        names = [d["dataset"] for d in json.loads(body).get("datasets", [])]
        check("restricted registers are absent from a non-admin's listing",
              "formulary" not in names and "grn-register" in names, "got %r" % (names,))
        check("...including one whose name needs normalising to match its key",
              "expiry-stock" not in names, "got %r" % (names,))
        s, _ = request(base, "/__data/expiry-stock/export", staff)
        check("and its rows are refused directly too", s == 403, "got %d" % s)
        s, body = request(base, "/__data", admin)
        names = [d["dataset"] for d in json.loads(body).get("datasets", [])]
        check("an admin still sees every register",
              "formulary" in names and "expiry-stock" in names, "got %r" % (names,))

        # --- the same rules, asked in every other spelling --------------------
        #
        # Each of these was a live bypass. A rule that only holds for the one
        # canonical spelling is not a rule, so they are pinned individually
        # rather than as one "variants" check: a regression should name which
        # spelling came back.

        # A dataset name reaches its table through slug(), and SQLite
        # identifiers are case-insensitive, so all of these read the same
        # register that "formulary" names.
        for spelling in ("Formulary", "FORMULARY", "fOrmulary", "formulary%20", "formulary."):
            s, _ = request(base, "/__data/%s/export" % spelling, staff)
            check("non-admin refused a restricted register spelled %r" % spelling,
                  s == 403, "got %d" % s)
        s, _ = request(base, "/__agg/Formulary", staff, "POST", spec)
        check("non-admin refused aggregating a restricted register by another spelling",
              s == 403, "got %d" % s)

        # The file a path reaches is chosen after normalisation, so the check
        # has to normalise too -- a doubled slash in the address bar was
        # enough to open a hidden dashboard. The first version of this fix
        # normalised the path but tested the *raw* one for a .html/.htm
        # suffix before ever reaching that normalisation, as a cheap early
        # exit -- so every one of these, which all fail that raw suffix
        # test, fell through the exit and reached the static file handler
        # unchecked. Pinned individually, and including the two that need
        # nothing more exotic than what an ordinary Windows install already
        # does to a filename on its own (case folding, dropping a trailing
        # dot or space) -- this app ships for Windows.
        for trick in ("/dashboards//Data_Health_Check_Dashboard.html",
                      "/dashboards/./Data_Health_Check_Dashboard.html",
                      "/dashboards/%2e/Data_Health_Check_Dashboard.html",
                      "/dashboards/x/../Data_Health_Check_Dashboard.html",
                      "/dashboards//Data_Library.html",
                      "/dashboards/Data_Health_Check_Dashboard.html/.",
                      "/dashboards/Data_Health_Check_Dashboard.html/x/..",
                      "/dashboards/Data_Health_Check_Dashboard.html//.",
                      "/dashboards/Data_Health_Check_Dashboard.html/./.",
                      "/dashboards/Data_Health_Check_Dashboard.html%2f.",
                      "/dashboards/data_health_check_dashboard.html",
                      "/dashboards/Data_Health_Check_Dashboard.html.",
                      "/dashboards/Data_Health_Check_Dashboard.html%20"):
            s, _ = request(base, trick, staff)
            check("non-admin refused an admin-only page asked for as %s" % trick,
                  s == 404, "got %d" % s)

        # HEAD carries no body, but its status and Content-Length alone would
        # still tell a non-admin whether the page exists and how large it is.
        s, _ = request(base, page, staff, "HEAD")
        check("non-admin refused the same page over HEAD too", s == 404, "got %d" % s)
        s, _ = request(base, page, admin, "HEAD")
        check("admin still gets it over HEAD", s == 200, "got %d" % s)

        # --- the cache holds the same rows, so it needs the same rules --------
        s, _ = request(base, "/__cache/data-health-check/formulary/rows", staff)
        check("non-admin cannot read the cache of a restricted register",
              s == 403, "got %d" % s)

        # Nothing can tell rows computed from a register apart from rows
        # someone typed, and every account reads the same cache, so an open
        # write let any account put invented figures in front of everyone.
        forged = {"payload": {"rows": [{"itemName": "PWNED", "qty": 999999}],
                              "label": "Attacker supplied"}}
        s, _ = request(base, "/__cache/store-transfer/grn-register/rows",
                       staff, "POST", forged)
        check("non-admin cannot write the shared dashboard cache", s == 403, "got %d" % s)
        s, _ = request(base, "/__cache/store-transfer/grn-register/rows",
                       admin, "POST", {"payload": {"rows": [], "label": "admin"}})
        check("an admin still can, so the cache is still warmed", s == 200, "got %d" % s)
        s, body = request(base, "/__cache/store-transfer/grn-register/rows", staff)
        check("a non-admin still reads a register it is allowed", s == 200, "got %d" % s)

        # --- a register uploaded through the Data Library, not imported -----
        #
        # /__data and /__agg read straight from datastore.py, but a file can
        # also arrive through the Data Library's own upload-and-list route,
        # under the same dataset by convention (see _library_dataset_of --
        # the Data Library page itself writes dashboardId as "ds:<dataset>").
        # Gating one path and not the other just moves where the same
        # restricted register can still be read from.
        blob_id = "b" * 32
        blob_dir = os.path.join(data, "library", "blobs")
        os.makedirs(blob_dir, exist_ok=True)
        with open(os.path.join(blob_dir, blob_id), "wb") as fh:
            fh.write(b"ItemId,ITEM NAME,ITEM CODE\n1,Item One,IC1\n")
        import appstore
        os.environ["PARAS_DATA_DIR"] = data
        for mod in ("appstore", "paths"):
            sys.modules.pop(mod, None)
        import paths as _p
        _p._resolved = None
        import appstore as _appstore
        _appstore.library_write_index([{
            "id": blob_id, "dashboardId": "ds:formulary", "name": "formulary.csv",
            "size": 42, "type": "text/csv", "addedAt": 0, "updatedAt": 0,
            "headers": ["ItemId", "ITEM NAME", "ITEM CODE"], "uploadedBy": "admin/ritik",
        }])

        s, body = request(base, "/__library", staff)
        ids = [f["id"] for f in json.loads(body).get("files", [])]
        check("a library file scoped to a restricted dataset is absent from a non-admin's listing",
              blob_id not in ids, "got %r" % (ids,))
        s, _ = request(base, "/__library/" + blob_id, staff)
        check("and cannot be downloaded directly either", s == 403, "got %d" % s)
        s, body = request(base, "/__library", admin)
        ids = [f["id"] for f in json.loads(body).get("files", [])]
        check("an admin still sees it in the listing", blob_id in ids, "got %r" % (ids,))
        s, _ = request(base, "/__library/" + blob_id, admin)
        check("and can still download it", s == 200, "got %d" % s)

        # --- signed out ------------------------------------------------------
        s, _ = request(base, "/__data/grn-register/export")
        check("signed out, no register is readable at all", s == 401, "got %d" % s)
        s, _ = request(base, "/__cache/store-transfer/grn-register/rows")
        check("signed out, the cache is not readable either", s == 401, "got %d" % s)
    finally:
        if proc:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
        shutil.rmtree(tmp, ignore_errors=True)

    print("\n%d passed, %d failed" % (passed, failed))
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
