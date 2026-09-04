#!/usr/bin/env python3
"""Checks the SQLite store behind accounts/logs/requests/feedback/library
index (appstore.py) round-trips exactly and imports legacy JSON/JSONL once.

    python3 test_appstore.py

Uses a temporary data directory (PARAS_DATA_DIR) for every phase, never the
real data folder. Exit code 0 = all good.
"""
import json
import os
import shutil
import sys
import tempfile
import time

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


def fresh_appstore(data_dir):
    """A brand-new appstore module bound to a fresh data directory -- needed
    because appstore caches one open connection per process, and each phase
    below needs its own throwaway database."""
    os.environ["PARAS_DATA_DIR"] = data_dir
    for mod in ("appstore", "paths"):
        sys.modules.pop(mod, None)
    import paths as p
    p._resolved = None
    import appstore as a
    return a


def test_accounts_round_trip():
    tmp = tempfile.mkdtemp(prefix="paras-appstore-")
    a = fresh_appstore(tmp)
    try:
        check("no accounts yet", a.read_auth() == {})

        auth = {
            "enabled": True, "hint": "h", "admin": "Ritik Nagar",
            "adminEmail": "a@b.com", "adminKeySalt": "s", "adminKeyHash": "h",
            "email": "admin", "logins": ["admin"], "salt": "s1",
            "hash": "digest1", "iterations": 250000,
            "accounts": [
                {"login": "admin", "salt": "s1", "hash": "digest1", "iterations": 250000,
                 "createdAt": 1, "name": "Ritik"},
                {"login": "second", "salt": "s2", "hash": "digest2", "iterations": 250000,
                 "createdAt": 2, "disabled": True},
            ],
        }
        a.write_auth(auth)
        back = a.read_auth()
        check("account order preserved", [x["login"] for x in back["accounts"]] == ["admin", "second"])
        check("account fields round-trip", back["accounts"][1]["disabled"] is True
              and back["accounts"][1]["hash"] == "digest2")
        check("top-level meta fields round-trip", back["hint"] == "h" and back["adminEmail"] == "a@b.com")

        # overwrite -- old accounts must not linger
        a.write_auth({"enabled": True, "accounts": [{"login": "onlyone", "hash": "x"}]})
        back2 = a.read_auth()
        check("write_auth replaces the whole set", [x["login"] for x in back2["accounts"]] == ["onlyone"])
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_totp_round_trip():
    tmp = tempfile.mkdtemp(prefix="paras-appstore-")
    a = fresh_appstore(tmp)
    try:
        check("no totp yet", a.read_totp() == {})
        a.write_totp({"alice": {"secret": "ABC", "enabled": True}})
        check("totp round-trips", a.read_totp() == {"alice": {"secret": "ABC", "enabled": True}})
        a.write_totp({})
        check("totp write replaces (empty clears)", a.read_totp() == {})
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_lists_round_trip():
    tmp = tempfile.mkdtemp(prefix="paras-appstore-")
    a = fresh_appstore(tmp)
    try:
        reqs = [{"id": "r1", "type": "signup", "login": "x", "status": "pending"},
                {"id": "r2", "type": "id_change", "login": "y", "status": "pending"}]
        a.write_requests(reqs)
        check("requests round-trip, order kept", a.read_requests() == reqs)

        fb = [{"id": "f1", "login": "x", "message": "hello"}]
        a.write_feedback(fb)
        check("feedback round-trips", a.read_feedback() == fb)

        lib = [{"id": "l1", "dashboardId": "d", "name": "n.csv", "size": 5}]
        a.library_write_index(lib)
        check("library index round-trips", a.library_read_index() == lib)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_logs_and_reports():
    tmp = tempfile.mkdtemp(prefix="paras-appstore-")
    a = fresh_appstore(tmp)
    try:
        a.log_history("admin", "login_ok", ip="1.2.3.4")
        a.log_view("admin", "procurement")
        time.sleep(0.01)   # usage_report only credits time when logout ts > login ts
        a.log_history("admin", "logout")

        hist = a.read_history(limit=10)
        check("history most-recent-first", hist[0]["event"] == "logout" and hist[-1]["event"] == "login_ok")
        check("ip recorded only where given", hist[-1].get("ip") == "1.2.3.4" and "ip" not in hist[0])

        stats = a.history_stats()
        check("history_stats counts one session", stats.get("admin", {}).get("sessions") == 1)

        usage = a.usage_report()
        check("usage_report has an entry for admin", "admin" in usage)

        a.log_ask_usage("test-model", 100, 50)
        rep = a.ask_usage_report()
        check("ask usage today has tokens", rep["today"]["tokens"] >= 150)

        limited = a.read_history(limit=1)
        check("history respects limit", len(limited) == 1)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_mail_llm_config():
    tmp = tempfile.mkdtemp(prefix="paras-appstore-")
    a = fresh_appstore(tmp)
    try:
        check("no mail config yet", a.read_mail_config() is None)
        check("no llm config yet", a.read_llm_config() is None)

        a.write_mail_config({"host": "smtp.example.com", "port": 587, "username": "u",
                              "password": "p", "from": "Paras <n@example.com>", "ssl": False})
        cfg = a.read_mail_config()
        check("mail config round-trips", cfg is not None and cfg["host"] == "smtp.example.com")

        a.write_llm_config({"apiKey": "sk-ant-xyz", "model": "claude-opus-5"})
        lcfg = a.read_llm_config()
        check("llm config round-trips", lcfg is not None and lcfg["apiKey"] == "sk-ant-xyz")

        a.write_mail_config(None)
        check("mail config cleared by writing None", a.read_mail_config() is None)
        check("llm config untouched by clearing mail config",
              a.read_llm_config() is not None and a.read_llm_config()["apiKey"] == "sk-ant-xyz")

        a.write_llm_config(None)
        check("llm config cleared by writing None", a.read_llm_config() is None)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_migration_from_legacy_json():
    tmp = tempfile.mkdtemp(prefix="paras-appstore-")
    try:
        auth = {
            "enabled": True, "hint": "legacy hint", "admin": "Ritik",
            "adminEmail": "admin@x.com", "adminKeySalt": "ks", "adminKeyHash": "kh",
            "email": "admin", "logins": ["admin"], "salt": "s1", "hash": "d1", "iterations": 250000,
            "accounts": [{"login": "admin", "salt": "s1", "hash": "d1", "iterations": 250000, "createdAt": 1}],
        }
        with open(os.path.join(tmp, "auth.json"), "w", encoding="utf-8") as fh:
            json.dump(auth, fh)
        with open(os.path.join(tmp, "totp.json"), "w", encoding="utf-8") as fh:
            json.dump({"admin": {"secret": "SECRET", "enabled": True}}, fh)
        with open(os.path.join(tmp, "pending_requests.json"), "w", encoding="utf-8") as fh:
            json.dump({"requests": [{"id": "r1", "status": "pending"}]}, fh)
        with open(os.path.join(tmp, "feedback.json"), "w", encoding="utf-8") as fh:
            json.dump({"items": [{"id": "f1", "message": "m"}]}, fh)
        lib_dir = os.path.join(tmp, "library")
        os.makedirs(lib_dir, exist_ok=True)
        with open(os.path.join(lib_dir, "index.json"), "w", encoding="utf-8") as fh:
            json.dump({"files": [{"id": "l1", "name": "n.csv"}]}, fh)
        with open(os.path.join(tmp, "login_history.jsonl"), "w", encoding="utf-8") as fh:
            fh.write(json.dumps({"ts": 1, "login": "admin", "event": "login_ok"}) + "\n")
            fh.write("not json at all\n")   # must be skipped, not fatal
            fh.write(json.dumps({"ts": 2, "login": "admin", "event": "logout"}) + "\n")
        with open(os.path.join(tmp, "view_history.jsonl"), "w", encoding="utf-8") as fh:
            fh.write(json.dumps({"ts": 1, "login": "admin", "dashboardId": "d"}) + "\n")
        with open(os.path.join(tmp, "ask_usage.jsonl"), "w", encoding="utf-8") as fh:
            fh.write(json.dumps({"ts": int(time.time() * 1000), "model": "m",
                                  "inputTokens": 10, "outputTokens": 5}) + "\n")
        with open(os.path.join(tmp, "mail_config.json"), "w", encoding="utf-8") as fh:
            json.dump({"host": "smtp.legacy.com", "username": "u", "password": "p", "from": "a@b.com"}, fh)
        with open(os.path.join(tmp, "llm_config.json"), "w", encoding="utf-8") as fh:
            json.dump({"apiKey": "sk-legacy"}, fh)

        a = fresh_appstore(tmp)
        back = a.read_auth()
        check("migrated accounts", [x["login"] for x in back["accounts"]] == ["admin"])
        check("migrated top-level meta", back["hint"] == "legacy hint")
        check("migrated totp", a.read_totp().get("admin", {}).get("secret") == "SECRET")
        check("migrated pending request", a.read_requests()[0]["id"] == "r1")
        check("migrated feedback", a.read_feedback()[0]["id"] == "f1")
        check("migrated library index", a.library_read_index()[0]["id"] == "l1")
        check("migrated login_history skipped the bad line",
              len(a.read_history(limit=10)) == 2)
        check("migrated view_history", a.usage_report().get("admin") is not None)
        check("migrated mail config", a.read_mail_config()["host"] == "smtp.legacy.com")
        check("migrated llm config", a.read_llm_config()["apiKey"] == "sk-legacy")

        with open(os.path.join(tmp, "auth.json"), encoding="utf-8") as fh:
            check("original auth.json left untouched", json.load(fh) == auth)

        # re-opening must not duplicate rows
        a2 = fresh_appstore(tmp)
        check("migration does not re-run / does not duplicate",
              len(a2.read_auth()["accounts"]) == 1 and len(a2.read_history(limit=10)) == 2)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_dashboard_overrides():
    tmp = tempfile.mkdtemp(prefix="paras-appstore-")
    a = fresh_appstore(tmp)
    try:
        # Not necessarily empty: the one-time migration (see _connect() ->
        # _migrate_from_json()) reads the real repo's dashboards.json, and
        # any dashboard already shipped with adminOnly:true there (Data
        # Library, Data Health Check) gets an explicit override row so an
        # upgrade never un-hides them -- that's real, intended behaviour,
        # not something this test's own tmp dir controls.
        before = a.read_dashboard_overrides()
        check("no override for a dashboard this test itself did not touch",
              "procurement" not in before)
        a.set_dashboard_admin_only("procurement", True)
        check("override set", a.read_dashboard_overrides()["procurement"]["adminOnly"] is True)
        a.set_dashboard_admin_only("procurement", False)
        check("override flips to an explicit False, not deleted",
              a.read_dashboard_overrides()["procurement"]["adminOnly"] is False)

        # read_dashboards_registry() merges the override onto whatever
        # dashboards.json (next to appstore.py in the real repo) ships --
        # just check it does not blow up and returns a dashboards list.
        reg = a.read_dashboards_registry()
        check("merged registry has a dashboards list", isinstance(reg.get("dashboards"), list))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main():
    test_accounts_round_trip()
    test_totp_round_trip()
    test_lists_round_trip()
    test_logs_and_reports()
    test_dashboard_overrides()
    test_mail_llm_config()
    test_migration_from_legacy_json()
    print("\n%d passed, %d failed" % (passed, failed))
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
