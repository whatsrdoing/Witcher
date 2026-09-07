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


def raw_request(base, path, token=None, method="GET"):
    """Sends a request target exactly as spelled, over a bare socket.

    urllib -- and every real browser -- treats a "#" in a URL as a
    fragment: client-side only, never put on the wire. That is exactly
    why the 5th audit's fragment bypass survived undetected by the first
    61-case suite here, which is built entirely on urllib's request(). A
    hand-rolled request line is the only way to prove the server-side fix
    actually holds against a request that spells one out.
    """
    from urllib.parse import urlsplit
    u = urlsplit(base)
    host, port = u.hostname, u.port
    target = u.path + path
    lines = ["%s %s HTTP/1.1" % (method, target), "Host: %s:%d" % (host, port),
             "Connection: close"]
    if token:
        lines.append("Cookie: paras_session=" + token)
    lines.append("")
    lines.append("")
    with socket.create_connection((host, port), timeout=15) as s:
        s.sendall("\r\n".join(lines).encode())
        chunks = []
        while True:
            chunk = s.recv(65536)
            if not chunk:
                break
            chunks.append(chunk)
    resp = b"".join(chunks)
    status_line = resp.split(b"\r\n", 1)[0].decode("latin-1")
    status = int(status_line.split(" ", 2)[1])
    body = resp.split(b"\r\n\r\n", 1)[1] if b"\r\n\r\n" in resp else b""
    return status, body.decode("utf-8", "replace")


def raw_oversized_post(base, path, token, declared_length, actual_body):
    """POSTs a Content-Length far larger than what actually follows.

    This is what proves _drain_body() actually works, and the signal is
    specifically whether *sending* actual_body succeeds, not just whether
    a response eventually comes back. A server that rejects on the
    declared length without reading anything answers and closes the
    socket immediately, with actual_body still queued up behind it in the
    kernel's send buffer -- once that buffer is bigger than the OS will
    silently absorb (a handful of KB is not enough; low-single-digit MB
    reliably is, which is why the caller uses a multi-MB body, not a
    token-sized one), closing the read side while bytes are still
    arriving sends a TCP reset instead of a clean FIN. The client's
    sendall() surfaces that reset as BrokenPipeError/ConnectionError --
    exactly the exception class a real browser's fetch() reports as a
    bare "Failed to fetch" network error, no status code, nothing to show
    the user -- regardless of whether a well-formed response happens to
    have already reached the kernel's receive buffer before the reset
    (verified by reproducing this exact scenario against the unfixed
    code: sendall() raised BrokenPipeError there even though a complete,
    correctly-formed 400 response could still be read back afterward --
    so reading a clean response is not by itself proof the upload worked;
    only an unraised sendall() is).

    Returns (send_ok, status, body) -- send_ok is the real pass/fail signal.
    """
    from urllib.parse import urlsplit
    u = urlsplit(base)
    host, port = u.hostname, u.port
    target = u.path + path
    lines = ["POST %s HTTP/1.1" % target, "Host: %s:%d" % (host, port),
              "Content-Length: %d" % declared_length, "Connection: close"]
    if token:
        lines.append("Cookie: paras_session=" + token)
    lines.append("")
    lines.append("")
    s = socket.create_connection((host, port), timeout=15)
    send_ok = True
    try:
        s.sendall("\r\n".join(lines).encode() + actual_body)
    except OSError:
        send_ok = False
    try:
        s.shutdown(socket.SHUT_WR)
    except OSError:
        pass
    chunks = []
    try:
        while True:
            chunk = s.recv(65536)
            if not chunk:
                break
            chunks.append(chunk)
    except OSError:
        pass
    s.close()
    resp = b"".join(chunks)
    if b"\r\n" not in resp:
        return send_ok, None, resp.decode("utf-8", "replace")
    status_line = resp.split(b"\r\n", 1)[0].decode("latin-1")
    status = int(status_line.split(" ", 2)[1])
    body = resp.split(b"\r\n\r\n", 1)[1] if b"\r\n\r\n" in resp else b""
    return send_ok, status, body.decode("utf-8", "replace")


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
        s, _ = request(base, "/__where")
        check("signed out, /__where does not disclose the install's absolute paths",
              s == 401, "got %d" % s)
        s, body = request(base, "/__where", staff)
        check("a signed-in account still gets it", s == 200 and "dataDir" in json.loads(body), "got %d" % s)

        # --- auth.js / the legacy auth.json must never reach anyone over HTTP -
        #
        # The 4th audit's most serious finding: sync.mirror_auth() writes the
        # *unredacted* account list -- every password hash, the admin-key
        # hash -- into auth.js in the app folder, for file://-mode sign-in.
        # serve.py's static handler had no idea that file was special, so it
        # served it to anyone, no session at all, and the leaked hash is not
        # merely crackable offline -- _session_login_post compares it with
        # hmac.compare_digest, so it *is* the credential the server accepts.
        # No session/token needed for any of these -- that is the point.
        s, _ = request(base, "/auth.js")
        check("auth.js is never served over HTTP, signed out", s == 404, "got %d" % s)
        s, _ = request(base, "/auth.js", staff)
        check("...nor to a signed-in non-admin", s == 404, "got %d" % s)
        s, _ = request(base, "/auth.js", admin)
        check("...nor even to the admin -- file:// mode is the only consumer", s == 404, "got %d" % s)

        # The app root also still carries a stale, unredacted auth.json --
        # nothing reads it any more (accounts live in appstore's state.db),
        # but it sat there on disk, servable, until this fix. The live
        # /auth.json route matches on the *raw* final path segment, so a
        # percent-encoded spelling used to walk past that match and reach
        # the stale file underneath -- served by the static handler with
        # every hash intact -- instead of the redacted route. Every one of
        # these has to come back exactly as the plain spelling does.
        s, canonical = request(base, "/auth.json")
        canonical_hash = json.loads(canonical)["accounts"][0].get("hash")
        check("the canonical /auth.json route is already redacted (sanity check)",
              not canonical_hash, "got hash %r" % canonical_hash)
        for spelling in ("/%61uth.json", "/auth%2ejson", "/auth.%6ason",
                         "/./%61uth.json", "/dashboards/../%61uth.json"):
            s, body = request(base, spelling)
            check("auth.json asked for as %s is still the redacted route, not the raw file" % spelling,
                  s == 200 and json.loads(body) == json.loads(canonical), "got %d, %r" % (s, body[:120]))

        # --- a URL fragment must not survive to bypass any of the above ------
        #
        # The 5th audit's finding: do_GET/do_HEAD compute path_only by
        # splitting off "?" only, but translate_path() -- the code that
        # actually resolves a static file -- splits off "?" *and* "#"
        # (stdlib http.server does this itself, unprompted). So
        # "auth.js#x" and "auth.js" compared unequal to every check built
        # on _normalized_path(), while the static handler underneath
        # resolved them identically -- reopening auth.js's exposure, the
        # stale auth.json's, and the admin-only-dashboard bypass, all for
        # one extra character. A real browser never puts a fragment on the
        # wire, which is exactly why this needs a raw socket to catch.
        for frag in ("#", "#x", "##", "#?a=1"):
            s, _ = raw_request(base, "/auth.js" + frag)
            check("auth.js is still refused with a fragment appended (%r)" % frag,
                  s == 404, "got %d" % s)
        s, body = raw_request(base, "/auth.json#x")
        check("auth.json#x is still the redacted route, not the raw file",
              s == 200 and json.loads(body) == json.loads(canonical), "got %d, %r" % (s, body[:120]))
        s, _ = raw_request(base, page + "#x", staff)
        check("an admin-only dashboard page is still refused with a fragment appended",
              s == 404, "got %d" % s)
        s, _ = raw_request(base, page + "#x", staff, "HEAD")
        check("...over HEAD too", s == 404, "got %d" % s)

        # --- an oversized upload must fail cleanly, not as a dead connection -
        #
        # A real 386MB COGS file hit exactly this: rejected on Content-Length
        # alone in a fraction of a second, with the browser still streaming
        # hundreds of megabytes into a socket the server had already stopped
        # reading from -- closing it that way sends a TCP reset, which shows
        # up client-side as a bare connection failure ("the local server is
        # not answering"), not the 400/413 JSON this route is actually
        # trying to send. Every route sharing this check needed the same
        # fix; __cache's POST body is the cheapest one to reach here (any
        # signed-in session, not admin-only), so it is what stands in for
        # all four. A multi-MB body is what actually exercises this -- a
        # few hundred bytes fits inside the kernel's own receive buffer and
        # never reveals the difference (checked by hand against the
        # unfixed code: a 500-byte version of this same test passed either
        # way).
        oversized = 1024 * 1024 * 1024 + 1_000_000     # just over MAX_UPLOAD_BYTES
        send_ok, status, body = raw_oversized_post(
            base, "/__cache/store-transfer/grn-register/rows", staff,
            oversized, b"x" * (4 * 1024 * 1024))
        check("the upload itself completes without the connection being reset",
              send_ok, "got %r" % body)
        check("...and it is answered with the real size-rejection, not something else",
              status == 400, "got %s, %r" % (status, body))
    finally:
        if proc:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
        shutil.rmtree(tmp, ignore_errors=True)

    test_data_folder_fallback_is_blocked()
    print("\n%d passed, %d failed" % (passed, failed))
    return 0 if failed == 0 else 1


def test_data_folder_fallback_is_blocked():
    """paths.py keeps the data directory outside the app folder normally,
    but falls back to "<app folder>/data" when the real per-machine
    location cannot be created -- a supported, documented install state,
    not a hypothetical one. When it happens, the static file handler would
    otherwise serve state.db (every account, every password hash),
    library.db (every register, restricted ones included), and every blob
    under library/ to anyone who can reach the port at all -- none of that
    ever goes through _require_session, because it is not meant to be a
    route in the first place. This starts a server with the data directory
    deliberately inside the app folder to pin that it is refused."""
    tmp = tempfile.mkdtemp(prefix="paras-access-fallback-")
    app = os.path.join(tmp, "app")
    shutil.copytree(ROOT, app, ignore=shutil.ignore_patterns(".git", "__pycache__", "*.pyc"))
    data = os.path.join(app, "data")            # inside the app folder, on purpose
    env = dict(os.environ, PARAS_DATA_DIR=data)
    proc = None
    try:
        # No pre-seeded content: the point is that whatever the app itself
        # creates there for real (accounts, registers, blobs) at PARAS_DATA_DIR
        # -- which, this once, is deliberately inside the app folder -- must
        # never come back out over the same port that serves the app's own
        # static files.
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

        subprocess.run([sys.executable, "set_password.py", "someone/here", "SomePass123!x"],
                       cwd=app, env=env, capture_output=True, timeout=120)
        check("the fallback location really did get real content (sanity check)",
              os.path.exists(os.path.join(data, "state.db")))

        for path in ("/data/", "/data/state.db", "/data/library/",
                     "/%64ata/state.db", "/dashboards/../data/state.db", "/DATA/state.db"):
            s, _ = request(base, path)
            check("the app-folder data fallback refuses %s" % path, s == 404, "got %d" % s)
        s, _ = request(base, "/data/state.db", method="HEAD")
        check("...over HEAD too", s == 404, "got %d" % s)
        s, _ = raw_request(base, "/data/state.db#x")
        check("a fragment cannot resurrect the app-folder data path either "
              "(it can only truncate a suffix, never grow one back)", s == 404, "got %d" % s)

        # The rest of the app still has to work with data living there --
        # this is a supported fallback, not a broken state, and the fix
        # must not have blocked the folder's own legitimate consumers
        # (appstore/datastore, which never go through HTTP to reach it).
        s, _ = request(base, "/")
        check("the app itself still loads with data in the fallback location",
              s == 200, "got %d" % s)
    finally:
        if proc:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
