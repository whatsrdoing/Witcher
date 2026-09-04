"""Everything the app stores server-side except the report data itself.

Accounts/passwords, TOTP secrets, the pending-requests queue, feedback, the
login/view/ask-usage logs, and the Data Library's file index all used to be
flat JSON/JSONL files under the data folder, each read and rewritten in full
on every access. That gets slower, with no ceiling, as the logs grow -- and
two of the admin panel's own once-a-second refresh calls were doing exactly
that. This module moves all of it into one SQLite database, data/state.db,
next to (but separate from) datastore.py's own library.db -- that one holds
the real report data pulled from uploaded registers and this module never
writes to it. dashboard_cache (see its own section below) does open a
short-lived read-only-in-spirit connection to library.db, but only to
fingerprint what is on record there -- never to change it.

Every function below keeps the exact name and return shape its flat-file
predecessor in serve.py had, so serve.py's own callers did not need to
change -- only where the bytes actually live did. Most tables store each
record as a JSON blob under its natural key (login, id), which is what today's
"rewrite the whole file" callers already assume and costs nothing extra at
this scale; the three append-only logs (login_history, view_history,
ask_usage) are real indexed columns instead, which is what turns the admin
panel's replay-the-whole-file reads into indexed queries -- the actual
performance fix.

migrate_from_json() runs once, automatically, the first time this module
opens the database: if state.db does not exist yet and any of the legacy
files do, it imports them (reusing nothing destructive -- the originals are
never deleted or rewritten, same idiom as paths.migrate()).
"""
import json
import os
import sqlite3
import threading
import time

import paths

ROOT = os.path.dirname(os.path.abspath(__file__))
DASHBOARDS_JSON = os.path.join(ROOT, "dashboards.json")
DB_PATH = os.path.join(paths.data_dir(), "state.db")

_LOCK = threading.Lock()
_conn = None


def _connect():
    global _conn
    if _conn is not None:
        return _conn
    with _LOCK:
        if _conn is not None:
            return _conn
        os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
        conn = sqlite3.connect(DB_PATH, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        _init_schema(conn)
        _conn = conn
        _migrate_from_json(conn)
        return _conn


def _init_schema(conn):
    conn.executescript("""
    CREATE TABLE IF NOT EXISTS accounts (
        login TEXT PRIMARY KEY,
        ord   INTEGER NOT NULL,
        data  TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auth_meta (
        id   INTEGER PRIMARY KEY CHECK (id = 1),
        data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS totp (
        login TEXT PRIMARY KEY,
        data  TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pending_requests (
        id   TEXT PRIMARY KEY,
        ord  INTEGER NOT NULL,
        data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS feedback (
        id   TEXT PRIMARY KEY,
        ord  INTEGER NOT NULL,
        data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS library_index (
        id   TEXT PRIMARY KEY,
        ord  INTEGER NOT NULL,
        data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS dashboard_overrides (
        dashboard_id TEXT PRIMARY KEY,
        data         TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mail_config (
        id   INTEGER PRIMARY KEY CHECK (id = 1),
        data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS llm_config (
        id   INTEGER PRIMARY KEY CHECK (id = 1),
        data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS login_history (
        id    INTEGER PRIMARY KEY AUTOINCREMENT,
        ts    INTEGER NOT NULL,
        login TEXT NOT NULL,
        event TEXT NOT NULL,
        ip    TEXT
    );
    CREATE INDEX IF NOT EXISTS ix_login_history_login ON login_history(login);
    CREATE INDEX IF NOT EXISTS ix_login_history_ts ON login_history(ts);

    CREATE TABLE IF NOT EXISTS view_history (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        ts           INTEGER NOT NULL,
        login        TEXT NOT NULL,
        dashboard_id TEXT
    );
    CREATE INDEX IF NOT EXISTS ix_view_history_login ON view_history(login);

    CREATE TABLE IF NOT EXISTS ask_usage (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        ts            INTEGER NOT NULL,
        model         TEXT,
        input_tokens  INTEGER,
        output_tokens INTEGER
    );
    CREATE INDEX IF NOT EXISTS ix_ask_usage_ts ON ask_usage(ts);

    CREATE TABLE IF NOT EXISTS _migration (
        key      TEXT PRIMARY KEY,
        done_at  INTEGER
    );

    -- A dashboard's own precomputed view of one dataset from the month-on-
    -- month store (datastore.py's library.db) -- see the dashboard_cache
    -- section below for how this is kept honest.
    CREATE TABLE IF NOT EXISTS dashboard_cache (
        dashboard_id    TEXT,
        dataset         TEXT,
        kind            TEXT,
        source_version  TEXT NOT NULL,
        payload         TEXT NOT NULL,
        computed_at     INTEGER,
        PRIMARY KEY (dashboard_id, dataset, kind)
    );
    """)
    conn.commit()


# ---------------------------------------------------------------------------
# accounts / auth.json
# ---------------------------------------------------------------------------

def read_auth():
    """Reconstructs the exact dict shape auth.json used to be: every
    top-level field (enabled, hint, adminKeyHash, the legacy accounts[0]
    mirror, ...) plus "accounts" as an ordered list. Returns {} when no
    accounts are configured at all -- same as a missing/empty auth.json."""
    conn = _connect()
    with _LOCK:
        acc_rows = conn.execute("SELECT login, data FROM accounts ORDER BY ord").fetchall()
        meta_row = conn.execute("SELECT data FROM auth_meta WHERE id=1").fetchone()
    if not acc_rows and not meta_row:
        return {}
    auth = json.loads(meta_row["data"]) if meta_row else {}
    accounts = []
    for r in acc_rows:
        acc = json.loads(r["data"])
        acc["login"] = r["login"]
        accounts.append(acc)
    auth["accounts"] = accounts
    return auth


def write_auth(auth):
    """Replaces every account and every top-level field in one transaction --
    the same "overwrite the whole thing" semantics auth.json writes always
    had, just atomic now instead of a plain open()+json.dump()."""
    auth = dict(auth or {})
    accounts = auth.pop("accounts", None) or []
    conn = _connect()
    with _LOCK, conn:
        conn.execute("DELETE FROM accounts")
        for i, acc in enumerate(accounts):
            acc = dict(acc)
            login = acc.pop("login", None)
            if not login:
                continue
            conn.execute("INSERT INTO accounts (login, ord, data) VALUES (?,?,?)",
                         (login, i, json.dumps(acc, ensure_ascii=False)))
        conn.execute(
            "INSERT INTO auth_meta (id, data) VALUES (1, ?) "
            "ON CONFLICT(id) DO UPDATE SET data=excluded.data",
            (json.dumps(auth, ensure_ascii=False),))


# ---------------------------------------------------------------------------
# totp.json
# ---------------------------------------------------------------------------

def read_totp():
    conn = _connect()
    with _LOCK:
        rows = conn.execute("SELECT login, data FROM totp").fetchall()
    return {r["login"]: json.loads(r["data"]) for r in rows}


def write_totp(data):
    conn = _connect()
    with _LOCK, conn:
        conn.execute("DELETE FROM totp")
        for login, val in (data or {}).items():
            conn.execute("INSERT INTO totp (login, data) VALUES (?,?)",
                         (login, json.dumps(val, ensure_ascii=False)))


# ---------------------------------------------------------------------------
# pending_requests.json / feedback.json / library_index.json -- same shape:
# an ordered list of dicts, each with an "id", rewritten wholesale.
# ---------------------------------------------------------------------------

def _read_list(table):
    conn = _connect()
    with _LOCK:
        rows = conn.execute("SELECT data FROM %s ORDER BY ord" % table).fetchall()
    return [json.loads(r["data"]) for r in rows]


def _write_list(table, items):
    conn = _connect()
    with _LOCK, conn:
        conn.execute("DELETE FROM %s" % table)
        for i, item in enumerate(items or []):
            item_id = item.get("id")
            if not item_id:
                continue
            conn.execute("INSERT INTO %s (id, ord, data) VALUES (?,?,?)" % table,
                         (item_id, i, json.dumps(item, ensure_ascii=False)))


def read_requests(): return _read_list("pending_requests")
def write_requests(requests): _write_list("pending_requests", requests)
def read_feedback(): return _read_list("feedback")
def write_feedback(items): _write_list("feedback", items)
def library_read_index(): return _read_list("library_index")
def library_write_index(files): _write_list("library_index", files)


# ---------------------------------------------------------------------------
# dashboards.json's one piece of runtime state: which dashboards an admin
# has hidden from everyone else. dashboards.json itself stays a plain file
# shipped with the app (it ships new dashboards on every update, the same
# way a new index.html does) -- only the admin's own per-install choice to
# hide one lives here, so it is no longer silently lost every time a new
# build gets unzipped over the old one, which is what writing straight into
# the shipped file used to do.
#
# No row for a dashboard means "use whatever dashboards.json itself says";
# a row always carries an explicit True/False the admin actually chose,
# which is why toggling "off" writes a row instead of deleting one -- it
# has to keep winning over the shipped file even if a future update ships
# that same dashboard as adminOnly by default.
# ---------------------------------------------------------------------------

def read_dashboard_overrides():
    conn = _connect()
    with _LOCK:
        rows = conn.execute("SELECT dashboard_id, data FROM dashboard_overrides").fetchall()
    return {r["dashboard_id"]: json.loads(r["data"]) for r in rows}


def set_dashboard_admin_only(dashboard_id, admin_only):
    conn = _connect()
    with _LOCK, conn:
        conn.execute(
            "INSERT INTO dashboard_overrides (dashboard_id, data) VALUES (?,?) "
            "ON CONFLICT(dashboard_id) DO UPDATE SET data=excluded.data",
            (dashboard_id, json.dumps({"adminOnly": bool(admin_only)})))


def read_dashboards_registry():
    """dashboards.json (the shipped list -- name, file, category, ...) with
    each dashboard's adminOnly flag overridden by whatever is in the
    dashboard_overrides table, if anything is. The one place both serve.py
    (the live /dashboards.json route and the admin panel's own listing) and
    sync.py (the dashboards.js file:// mirror) get this merged view from,
    so the two can never disagree about which dashboards are hidden."""
    try:
        with open(DASHBOARDS_JSON, encoding="utf-8") as fh:
            reg = json.load(fh)
    except (OSError, ValueError):
        return {}
    overrides = read_dashboard_overrides()
    if overrides:
        reg = dict(reg)
        reg["dashboards"] = [
            dict(d, adminOnly=overrides[d["id"]]["adminOnly"]) if d.get("id") in overrides else d
            for d in reg.get("dashboards") or []
        ]
    return reg


# ---------------------------------------------------------------------------
# mail_config.json / llm_config.json -- an SMTP credential and an Anthropic
# API key, each set locally by set_mail.py / set_llm.py, never typed into
# the app itself and never mirrored anywhere the browser can read. Same
# single-row idiom as auth_meta; write with cfg=None to clear it (what
# --remove used to do by deleting the file).
# ---------------------------------------------------------------------------

def read_mail_config():
    conn = _connect()
    with _LOCK:
        row = conn.execute("SELECT data FROM mail_config WHERE id=1").fetchone()
    return json.loads(row["data"]) if row else None


def write_mail_config(cfg):
    conn = _connect()
    with _LOCK, conn:
        if cfg is None:
            conn.execute("DELETE FROM mail_config WHERE id=1")
        else:
            conn.execute(
                "INSERT INTO mail_config (id, data) VALUES (1, ?) "
                "ON CONFLICT(id) DO UPDATE SET data=excluded.data",
                (json.dumps(cfg, ensure_ascii=False),))


def read_llm_config():
    conn = _connect()
    with _LOCK:
        row = conn.execute("SELECT data FROM llm_config WHERE id=1").fetchone()
    return json.loads(row["data"]) if row else None


def write_llm_config(cfg):
    conn = _connect()
    with _LOCK, conn:
        if cfg is None:
            conn.execute("DELETE FROM llm_config WHERE id=1")
        else:
            conn.execute(
                "INSERT INTO llm_config (id, data) VALUES (1, ?) "
                "ON CONFLICT(id) DO UPDATE SET data=excluded.data",
                (json.dumps(cfg, ensure_ascii=False),))


# ---------------------------------------------------------------------------
# dashboard_cache: a dashboard's own precomputed view (parsed rows, or a
# small default-filters summary) of one dataset from the month-on-month
# store -- datastore.py's own library.db, a separate SQLite file this module
# never writes to and does not import datastore.py to reach.
#
# The whole point of a cache is that it can go stale, and a stale cache
# showing wrong numbers is worse than no cache at all. So every read is
# guarded by a fingerprint recomputed HERE, right now, from the one place
# that cannot lie about what is actually stored: datastore.py's own
# _imports table, which it rewrites on every import or reimport. A client
# never gets to say what "current" means -- read_dashboard_cache() always
# recomputes it before answering, and write_dashboard_cache() is always
# handed a version its caller just computed the same way, moments before
# the write (see serve.py's __cache POST handler). Even a write that races
# a concurrent reimport is still honest: it is stamped with whatever the
# fingerprint truly was at the instant of that write, so it can never claim
# to represent data it does not -- the worst a race costs is one wasted
# recompute next time, never a wrong number on screen.
# ---------------------------------------------------------------------------

def dataset_fingerprint(dataset):
    """A short, stable fingerprint of everything currently on record for one
    dataset in the month-on-month store, straight from _imports: every
    (period, part, imported_at) triple, sorted and hashed. Reimporting any
    period or part -- at any time, from any process -- changes this; reading
    it back in a different order, or from two different server processes,
    never does.

    Opens its own short-lived connection rather than sharing datastore.py's
    (or importing that module at all): SQLite's WAL mode lets a reader like
    this see the writer's committed data without blocking it or being
    blocked by it, and a problem reading here can never reach the writer's
    own connection or its indexes. A store that does not exist yet, or has
    never seen this dataset, fingerprints the same way empty always does --
    "empty" -- so a fresh install's first cache write and a since-emptied
    dataset both invalidate any old cache honestly instead of erroring."""
    path = paths.db_path()
    if not os.path.exists(path):
        return "empty"
    try:
        conn = sqlite3.connect(path, timeout=5)
        try:
            rows = conn.execute(
                "SELECT period, part, imported_at FROM _imports WHERE dataset=? "
                "ORDER BY period, part", (dataset,)).fetchall()
        finally:
            conn.close()
    except sqlite3.Error:
        return "empty"
    if not rows:
        return "empty"
    import hashlib
    blob = "|".join("%s:%s:%s" % (p, pt or "", at) for p, pt, at in rows)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:32]


def read_dashboard_cache(dashboard_id, dataset, kind):
    """The cached payload for (dashboard_id, dataset, kind), already
    json.loads'd -- but only if it is still valid for the dataset's CURRENT
    state. Returns None on any kind of miss: nothing cached yet, a stale
    fingerprint (the dataset changed since this was written), or a payload
    that no longer parses as JSON. A corrupt row is never surfaced as data;
    the caller sees exactly the same None it would see for "never cached"
    and falls through to a real recompute."""
    current = dataset_fingerprint(dataset)
    conn = _connect()
    with _LOCK:
        row = conn.execute(
            "SELECT source_version, payload FROM dashboard_cache "
            "WHERE dashboard_id=? AND dataset=? AND kind=?",
            (dashboard_id, dataset, kind)).fetchone()
    if not row or row["source_version"] != current:
        return None
    try:
        return json.loads(row["payload"])
    except ValueError:
        return None


def write_dashboard_cache(dashboard_id, dataset, kind, source_version, payload):
    """Stores payload stamped with source_version -- which the caller must
    have just computed via dataset_fingerprint(dataset), as close to this
    call as practical (see the module-level note above for why that ordering
    is what keeps a write always honest even under a race)."""
    conn = _connect()
    with _LOCK, conn:
        conn.execute(
            "INSERT INTO dashboard_cache "
            "(dashboard_id, dataset, kind, source_version, payload, computed_at) "
            "VALUES (?,?,?,?,?,?) "
            "ON CONFLICT(dashboard_id, dataset, kind) DO UPDATE SET "
            "source_version=excluded.source_version, payload=excluded.payload, "
            "computed_at=excluded.computed_at",
            (dashboard_id, dataset, kind, source_version,
             json.dumps(payload, ensure_ascii=False), int(time.time())))


# ---------------------------------------------------------------------------
# login_history.jsonl
# ---------------------------------------------------------------------------

def log_history(login, event, ip=None):
    if not login:
        return
    conn = _connect()
    with _LOCK, conn:
        conn.execute("INSERT INTO login_history (ts, login, event, ip) VALUES (?,?,?,?)",
                     (int(time.time() * 1000), login, event, ip))


def read_history(limit=200):
    """Most recent entries first -- an indexed query now, not a full replay."""
    conn = _connect()
    with _LOCK:
        rows = conn.execute(
            "SELECT ts, login, event, ip FROM login_history ORDER BY id DESC LIMIT ?",
            (limit,)).fetchall()
    out = []
    for r in rows:
        e = {"ts": r["ts"], "login": r["login"], "event": r["event"]}
        if r["ip"]:
            e["ip"] = r["ip"]
        out.append(e)
    return out


def history_stats():
    conn = _connect()
    with _LOCK:
        rows = conn.execute(
            "SELECT ts, login, event FROM login_history ORDER BY id ASC").fetchall()
    open_since = {}
    stats = {}
    now_ms = time.time() * 1000
    for r in rows:
        login, event, ts = r["login"], r["event"], r["ts"]
        if not login or ts is None:
            continue
        s = stats.setdefault(login, {"totalMs": 0, "sessions": 0})
        if event == "login_ok":
            open_since[login] = ts
            s["sessions"] += 1
        elif event in ("logout", "force_logout") and login in open_since:
            s["totalMs"] += max(0, ts - open_since.pop(login))
    for login, start in open_since.items():
        stats.setdefault(login, {"totalMs": 0, "sessions": 0})
        stats[login]["totalMs"] += max(0, now_ms - start)
    return stats


# ---------------------------------------------------------------------------
# view_history.jsonl
# ---------------------------------------------------------------------------

def log_view(login, dashboard_id):
    if not login:
        return
    conn = _connect()
    with _LOCK, conn:
        conn.execute("INSERT INTO view_history (ts, login, dashboard_id) VALUES (?,?,?)",
                     (int(time.time() * 1000), login, dashboard_id))


def _day_str(ms):
    return time.strftime("%Y-%m-%d", time.localtime(ms / 1000.0))


def _split_ms_by_day(start_ms, end_ms):
    cur = start_ms
    while cur < end_ms:
        t = time.localtime(cur / 1000.0)
        next_midnight = time.mktime((t.tm_year, t.tm_mon, t.tm_mday, 0, 0, 0, 0, 0, -1)) * 1000 + 86400000
        seg_end = min(end_ms, next_midnight)
        if seg_end > cur:
            yield (_day_str(cur), seg_end - cur)
        cur = seg_end


def usage_report():
    """Per-login, per-day signed-in time and per-dashboard time, replayed
    from login_history + view_history the same way the old file-based
    version did -- see serve.py's original usage_report() docstring for why
    this is a replay rather than a live counter."""
    import bisect
    conn = _connect()
    with _LOCK:
        hist_rows = conn.execute(
            "SELECT ts, login, event FROM login_history ORDER BY id ASC").fetchall()
        view_rows = conn.execute(
            "SELECT ts, login, dashboard_id FROM view_history ORDER BY id ASC").fetchall()

    views_by_login = {}
    for r in view_rows:
        login, ts = r["login"], r["ts"]
        if not login or ts is None:
            continue
        views_by_login.setdefault(login, []).append({"ts": ts, "dashboardId": r["dashboard_id"]})
    for v in views_by_login.values():
        v.sort(key=lambda e: e["ts"])

    now_ms = int(time.time() * 1000)
    days = {}

    def credit(login, start_ms, end_ms):
        if end_ms <= start_ms:
            return
        by_day = days.setdefault(login, {})
        vlist = views_by_login.get(login) or []
        ts_list = [e["ts"] for e in vlist]
        idx = bisect.bisect_right(ts_list, start_ms) - 1
        cur = start_ms
        while cur < end_ms:
            dash = vlist[idx]["dashboardId"] if idx >= 0 else None
            nxt = vlist[idx + 1]["ts"] if idx + 1 < len(vlist) else end_ms
            seg_end = min(end_ms, nxt)
            for day, ms in _split_ms_by_day(cur, seg_end):
                d = by_day.setdefault(day, {"totalMs": 0, "dashboards": {}})
                d["totalMs"] += ms
                if dash:
                    d["dashboards"][dash] = d["dashboards"].get(dash, 0) + ms
            cur = seg_end
            idx += 1

    open_since = {}
    for r in hist_rows:
        login, event, ts = r["login"], r["event"], r["ts"]
        if not login or ts is None:
            continue
        if event == "login_ok":
            open_since[login] = ts
        elif event in ("logout", "force_logout") and login in open_since:
            credit(login, open_since.pop(login), ts)
    for login, start in open_since.items():
        credit(login, start, now_ms)

    return days


# ---------------------------------------------------------------------------
# ask_usage.jsonl
# ---------------------------------------------------------------------------

def log_ask_usage(model, input_tokens, output_tokens):
    conn = _connect()
    with _LOCK, conn:
        conn.execute(
            "INSERT INTO ask_usage (ts, model, input_tokens, output_tokens) VALUES (?,?,?,?)",
            (int(time.time() * 1000), model, input_tokens, output_tokens))


def ask_usage_report():
    import assistant
    now_ms = int(time.time() * 1000)
    today = _day_str(now_ms)
    month = time.strftime("%Y-%m", time.localtime(now_ms / 1000.0))
    totals = {"today": {"tokens": 0, "cost": 0.0}, "month": {"tokens": 0, "cost": 0.0}}
    conn = _connect()
    with _LOCK:
        rows = conn.execute(
            "SELECT ts, model, input_tokens, output_tokens FROM ask_usage").fetchall()
    for r in rows:
        ts = r["ts"]
        if ts is None:
            continue
        in_tok, out_tok = r["input_tokens"] or 0, r["output_tokens"] or 0
        cost = assistant.estimate_cost(r["model"], in_tok, out_tok) or 0.0
        if time.strftime("%Y-%m", time.localtime(ts / 1000.0)) == month:
            totals["month"]["tokens"] += in_tok + out_tok
            totals["month"]["cost"] += cost
        if _day_str(ts) == today:
            totals["today"]["tokens"] += in_tok + out_tok
            totals["today"]["cost"] += cost
    totals["today"]["cost"] = round(totals["today"]["cost"], 4)
    totals["month"]["cost"] = round(totals["month"]["cost"], 4)
    return totals


# ---------------------------------------------------------------------------
# One-time import from the legacy flat files -- never touches the originals.
# ---------------------------------------------------------------------------

def _migrate_from_json(conn):
    if conn.execute("SELECT 1 FROM _migration WHERE key='legacy_json'").fetchone():
        return
    d = paths.data_dir()
    try:
        _migrate_auth(conn, paths.auth_path())
        _migrate_totp(conn, os.path.join(d, "totp.json"))
        _migrate_list(conn, os.path.join(d, "pending_requests.json"), "requests", "pending_requests")
        _migrate_list(conn, os.path.join(d, "feedback.json"), "items", "feedback")
        _migrate_list(conn, paths.library_index(), "files", "library_index")
        _migrate_login_history(conn, os.path.join(d, "login_history.jsonl"))
        _migrate_view_history(conn, os.path.join(d, "view_history.jsonl"))
        _migrate_ask_usage(conn, os.path.join(d, "ask_usage.jsonl"))
        _migrate_dashboard_overrides(conn, DASHBOARDS_JSON)
        _migrate_single_config(conn, os.path.join(d, "mail_config.json"), "mail_config")
        _migrate_single_config(conn, os.path.join(d, "llm_config.json"), "llm_config")
    except Exception as exc:                          # noqa: BLE001
        # A migration problem must never stop the server from starting --
        # the originals are untouched either way, so nothing is lost; it
        # just means this run starts with an empty table for whichever
        # piece failed, same as a fresh install would.
        print("  ! appstore: legacy data import had a problem: %s" % exc)
    conn.execute("INSERT OR REPLACE INTO _migration (key, done_at) VALUES ('legacy_json', ?)",
                 (int(time.time()),))
    conn.commit()


def _migrate_auth(conn, path):
    if not os.path.exists(path):
        return
    try:
        with open(path, encoding="utf-8") as fh:
            auth = json.load(fh)
    except (OSError, ValueError):
        return
    accounts = auth.pop("accounts", None) or []
    if not accounts and auth.get("hash"):
        accounts = [{"login": auth.get("email", ""), "salt": auth.get("salt", ""),
                     "hash": auth.get("hash", ""), "iterations": auth.get("iterations", 250000),
                     "createdAt": auth.get("createdAt")}]
    for i, acc in enumerate(accounts):
        acc = dict(acc)
        login = acc.pop("login", None)
        if not login:
            continue
        conn.execute("INSERT OR REPLACE INTO accounts (login, ord, data) VALUES (?,?,?)",
                     (login, i, json.dumps(acc, ensure_ascii=False)))
    conn.execute("INSERT OR REPLACE INTO auth_meta (id, data) VALUES (1, ?)",
                 (json.dumps(auth, ensure_ascii=False),))


def _migrate_totp(conn, path):
    if not os.path.exists(path):
        return
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return
    if not isinstance(data, dict):
        return
    for login, val in data.items():
        conn.execute("INSERT OR REPLACE INTO totp (login, data) VALUES (?,?)",
                     (login, json.dumps(val, ensure_ascii=False)))


def _migrate_single_config(conn, path, table):
    """mail_config.json / llm_config.json -- each one plain object, one row."""
    if not os.path.exists(path):
        return
    try:
        with open(path, encoding="utf-8") as fh:
            cfg = json.load(fh)
    except (OSError, ValueError):
        return
    if not isinstance(cfg, dict):
        return
    conn.execute("INSERT OR REPLACE INTO %s (id, data) VALUES (1, ?)" % table,
                 (json.dumps(cfg, ensure_ascii=False),))


def _migrate_dashboard_overrides(conn, path):
    """One-time only: any dashboard the shipped dashboards.json currently
    marks adminOnly gets an explicit override row, so whatever an admin had
    already hidden stays hidden after this upgrade. dashboards.json itself
    is never written to again from this point on -- see the module-level
    comment above set_dashboard_admin_only()."""
    if not os.path.exists(path):
        return
    try:
        with open(path, encoding="utf-8") as fh:
            reg = json.load(fh)
    except (OSError, ValueError):
        return
    for dsh in reg.get("dashboards") or []:
        did = dsh.get("id")
        if did and dsh.get("adminOnly"):
            conn.execute(
                "INSERT OR REPLACE INTO dashboard_overrides (dashboard_id, data) VALUES (?,?)",
                (did, json.dumps({"adminOnly": True})))


def _migrate_list(conn, path, wrapper_key, table):
    if not os.path.exists(path):
        return
    try:
        with open(path, encoding="utf-8") as fh:
            items = json.load(fh).get(wrapper_key) or []
    except (OSError, ValueError):
        return
    for i, item in enumerate(items):
        item_id = item.get("id")
        if not item_id:
            continue
        conn.execute("INSERT OR REPLACE INTO %s (id, ord, data) VALUES (?,?,?)" % table,
                     (item_id, i, json.dumps(item, ensure_ascii=False)))


def _migrate_login_history(conn, path):
    if not os.path.exists(path):
        return
    try:
        with open(path, encoding="utf-8") as fh:
            lines = fh.readlines()
    except OSError:
        return
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            e = json.loads(line)
        except ValueError:
            continue
        if not e.get("login") or e.get("ts") is None:
            continue
        conn.execute("INSERT INTO login_history (ts, login, event, ip) VALUES (?,?,?,?)",
                     (e["ts"], e["login"], e.get("event"), e.get("ip")))


def _migrate_view_history(conn, path):
    if not os.path.exists(path):
        return
    try:
        with open(path, encoding="utf-8") as fh:
            lines = fh.readlines()
    except OSError:
        return
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            e = json.loads(line)
        except ValueError:
            continue
        if not e.get("login") or e.get("ts") is None:
            continue
        conn.execute("INSERT INTO view_history (ts, login, dashboard_id) VALUES (?,?,?)",
                     (e["ts"], e["login"], e.get("dashboardId")))


def _migrate_ask_usage(conn, path):
    if not os.path.exists(path):
        return
    try:
        with open(path, encoding="utf-8") as fh:
            lines = fh.readlines()
    except OSError:
        return
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            e = json.loads(line)
        except ValueError:
            continue
        if e.get("ts") is None:
            continue
        conn.execute(
            "INSERT INTO ask_usage (ts, model, input_tokens, output_tokens) VALUES (?,?,?,?)",
            (e["ts"], e.get("model"), e.get("inputTokens") or 0, e.get("outputTokens") or 0))
