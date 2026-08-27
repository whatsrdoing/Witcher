#!/usr/bin/env python3
"""Check that the Data Library stores files safely.

    python3 selftest.py

Starts a throwaway copy of the server against a temporary folder -- your own
data/library is never touched -- and checks the promises that matter when the
thing being stored is a register somebody will report numbers from:

  * a file read back is byte-for-byte the file that went in
  * an upload that is cut off part way is refused, not filed as if it were whole
  * files arriving at the same time all survive (no silently dropped entries)
  * the index survives being written while it is being read
  * deleting removes both the entry and the bytes; renaming sticks

Exit code is 0 when everything passes, 1 otherwise, so it can be wired into
whatever runs before a release.
"""
import hashlib
import http.client
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))
PREFIX = "/supply-chain/command-centre"

passed = failed = 0


def check(label, ok, detail=""):
    global passed, failed
    if ok:
        passed += 1
        print("  PASS  %s" % label)
    else:
        failed += 1
        print("  FAIL  %s%s" % (label, ("  -- " + detail) if detail else ""))
    return ok


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def url(port, path):
    return "http://127.0.0.1:%d%s/__library%s" % (port, PREFIX, path)


def post(port, path, body=b""):
    req = urllib.request.Request(url(port, path), data=body, method="POST")
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def get(port, path=""):
    try:
        with urllib.request.urlopen(url(port, path)) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def index(port):
    return json.loads(get(port)[1].decode("utf-8"))["files"]


def upload(port, fid, blob, name="f.csv"):
    qs = "/%s?id=%s&dashboardId=__library__&name=%s&type=text/csv&headers=%%5B%%5D" % (fid, fid, name)
    return post(port, qs, blob)


def wait_up(port, tries=60):
    for _ in range(tries):
        try:
            get(port)
            return True
        except OSError:
            time.sleep(0.25)
    return False


def main():
    global failed
    tmp = tempfile.mkdtemp(prefix="paras-selftest-")
    # A fresh data directory otherwise gets seeded from the repo's own
    # checked-in auth.json on first run (paths.migrate(), so a plain
    # extract-and-run has *some* working sign-in) -- which would make every
    # /__library call below require a session this script has no password
    # to obtain. This test is about the Library's own file-handling
    # promises, not sign-in, so it explicitly disables auth for its own
    # throwaway directory rather than skip what it is actually here to check.
    with open(os.path.join(tmp, "auth.json"), "w", encoding="utf-8") as fh:
        json.dump({"enabled": False}, fh)
    port = free_port()
    env = dict(os.environ, PARAS_DATA_DIR=tmp)
    proc = subprocess.Popen([sys.executable, os.path.join(ROOT, "serve.py"), "--no-open", "--port", str(port)],
                            cwd=ROOT, env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        if not wait_up(port):
            print("Could not start a test server on port %d." % port)
            return 1
        print("Data Library self-test  (temp folder: %s)\n" % tmp)

        # 1. round trip -- what comes back must be what went in, exactly.
        blob = os.urandom(3 * 1024 * 1024)
        code, _ = upload(port, "roundtrip", blob, "register.csv")
        check("upload accepted", code == 200, "HTTP %s" % code)
        code, back = get(port, "/roundtrip")
        check("download is byte-identical (3MB)",
              code == 200 and hashlib.md5(back).hexdigest() == hashlib.md5(blob).hexdigest())

        # 2. a cut-off upload must be refused outright. Filing a truncated
        #    register as if it were complete is the dangerous case: it reads
        #    fine and quietly reports totals that are short.
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
        conn.putrequest("POST", "%s/__library/truncated?id=truncated&dashboardId=__library__"
                                "&name=cut.csv&type=text/csv&headers=%%5B%%5D" % PREFIX)
        conn.putheader("Content-Length", "100000")
        conn.endheaders()
        conn.send(b"x" * 500)
        conn.sock.shutdown(socket.SHUT_WR)
        status = conn.getresponse().status
        conn.close()
        check("truncated upload rejected", status == 400, "got HTTP %s" % status)
        check("truncated upload left no index entry",
              not any(f["id"] == "truncated" for f in index(port)))
        check("truncated upload left no bytes behind",
              not os.path.exists(os.path.join(tmp, "library", "blobs", "truncated")))
        check("truncated upload left no .part file",
              not [f for f in os.listdir(os.path.join(tmp, "library", "blobs")) if f.endswith(".part")])

        # 3. simultaneous uploads -- read-modify-write on one index file is
        #    where entries go missing without a lock.
        n = 12
        errs = []
        def one(i):
            try:
                upload(port, "conc%02d" % i, b"a,b\n1,2\n", "c%02d.csv" % i)
            except Exception as exc:              # noqa: BLE001
                errs.append(exc)
        ths = [threading.Thread(target=one, args=(i,)) for i in range(n)]
        [t.start() for t in ths]
        [t.join() for t in ths]
        got = len([f for f in index(port) if f["id"].startswith("conc")])
        check("%d simultaneous uploads all kept" % n, got == n and not errs,
              "only %d survived" % got)

        # 4. the index must still parse, and must agree with what is on disk.
        files = index(port)
        blobs = set(os.listdir(os.path.join(tmp, "library", "blobs")))
        ids = {f["id"] for f in files}
        check("index is valid JSON and non-empty", len(files) > 0)
        check("every index entry has its bytes", not (ids - blobs), str(sorted(ids - blobs)[:3]))
        check("no orphaned bytes", not (blobs - ids), str(sorted(blobs - ids)[:3]))

        # 5. rename sticks; delete removes both halves.
        code, _ = post(port, "/roundtrip/rename?name=renamed.csv")
        check("rename accepted", code == 200)
        check("rename persisted",
              any(f["id"] == "roundtrip" and f["name"] == "renamed.csv" for f in index(port)))
        req = urllib.request.Request(url(port, "/roundtrip"), method="DELETE")
        urllib.request.urlopen(req).read()
        check("delete removed the index entry",
              not any(f["id"] == "roundtrip" for f in index(port)))
        check("delete removed the bytes",
              not os.path.exists(os.path.join(tmp, "library", "blobs", "roundtrip")))

        print("\n%d passed, %d failed" % (passed, failed))
        return 1 if failed else 0
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
