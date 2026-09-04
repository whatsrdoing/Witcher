#!/usr/bin/env python3
"""Regenerate dashboards.js from dashboards.json.

dashboards.json is the file you edit. dashboards.js is a generated mirror that
lets index.html work when it is opened by double-clicking it (file://), where
browsers refuse to read a .json file from disk.

    python3 sync.py

Run this after editing dashboards.json — or just use serve.py, which syncs
automatically on start.
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, "dashboards.json")
OUT = os.path.join(ROOT, "dashboards.js")
import paths
import appstore
# Accounts live in data/state.db (see appstore.py), outside the app folder,
# so they are not reset every time a new build is extracted. auth.js stays
# here: it is a generated mirror, rewritten from the real data on every run.
AUTH_OUT = os.path.join(ROOT, "auth.js")
BRIDGE_SRC = os.path.join(ROOT, "assets", "js", "dashboard-bridge.js")
BRIDGE_OPEN = "<!-- paras-command-centre-bridge -->"
BRIDGE_CLOSE = "<!-- /paras-command-centre-bridge -->"
GUARD_SRC = os.path.join(ROOT, "assets", "js", "dashboard-session-guard.js")
GUARD_OPEN = "<!-- paras-command-centre-session-guard -->"
GUARD_CLOSE = "<!-- /paras-command-centre-session-guard -->"
IDLE_SRC = os.path.join(ROOT, "assets", "js", "idle-timeout.js")
IDLE_OPEN = "<!-- paras-command-centre-idle-timeout -->"
IDLE_CLOSE = "<!-- /paras-command-centre-idle-timeout -->"

BANNER = (
    "/* GENERATED FILE — do not edit.\n"
    "   Source: dashboards.json   Regenerate: python3 sync.py\n"
    "   This mirror only exists so index.html also works from file://. */\n"
)


def check(reg):
    """Report registry problems without failing the sync."""
    problems = []
    seen = set()
    cats = {c.get("id") for c in reg.get("categories", [])}
    for i, dsh in enumerate(reg.get("dashboards", [])):
        label = dsh.get("name") or "entry #%d" % (i + 1)
        if not dsh.get("name"):
            problems.append('%s: missing "name"' % label)
        did = dsh.get("id") or ""
        if did and did in seen:
            problems.append('%s: duplicate id "%s"' % (label, did))
        seen.add(did)
        cat = dsh.get("category")
        if cat and cat not in cats:
            problems.append('%s: category "%s" is not declared in "categories"' % (label, cat))
        planned = dsh.get("status") in ("planned", "archived")
        path = dsh.get("file")
        if path and not planned and not os.path.exists(os.path.join(ROOT, path)):
            problems.append("%s: file not found -> %s" % (label, path))
        elif not path and not planned:
            problems.append('%s: no "file" and status is not "planned"' % label)
    return problems


def _place_before_body_end(html, block):
    i = html.rfind("</body>")
    if i < 0:
        i = html.rfind("</html>")
    if i < 0:
        return html + "\n" + block
    return html[:i] + block + html[i:]


def _place_after_head_open(html, block):
    m = re.search(r"<head[^>]*>", html, re.IGNORECASE)
    if not m:
        return None                            # no <head> -- caller decides what to do
    i = m.end()
    return html[:i] + block + html[i:]


def _apply_marked_block(reg, src_path, open_marker, close_marker, place, label):
    """Keep one marked, generated block in sync across every dashboard file.

    Idempotent: re-running leaves an up-to-date block untouched, and only
    rewrites a dashboard whose block is missing or stale. `place` decides
    where a fresh block goes; an existing block is always refreshed in place.
    """
    try:
        with open(src_path, encoding="utf-8") as fh:
            code = fh.read()
    except OSError:
        return
    block = "%s\n<script>\n%s</script>\n%s\n" % (open_marker, code, close_marker)

    touched, skipped = 0, []
    for dsh in reg.get("dashboards", []):
        rel = dsh.get("file")
        if not rel:
            continue
        path = os.path.join(ROOT, rel)
        if not os.path.exists(path):
            continue
        try:
            with open(path, encoding="utf-8", errors="surrogateescape") as fh:
                html = fh.read()
        except OSError:
            continue

        if open_marker in html:
            start = html.index(open_marker)
            end = html.find(close_marker)
            if end < 0:
                continue
            current = html[start:end + len(close_marker) + 1]
            if current.strip() == block.strip():
                continue                       # already current
            new_html = html[:start] + block + html[end + len(close_marker) + 1:]
        else:
            new_html = place(html, block)
            if new_html is None:
                skipped.append("%s (no <head>/<body> to anchor to)" % rel)
                continue

        try:
            with open(path, "w", encoding="utf-8", errors="surrogateescape") as fh:
                fh.write(new_html)
            touched += 1
        except OSError as exc:
            skipped.append("%s (%s)" % (rel, exc))

    if touched:
        print("%s added to %d dashboard%s" % (label, touched, "" if touched == 1 else "s"))
    for sk in skipped:
        print("  ! could not update " + sk)


def ensure_bridge(reg):
    """Make sure each dashboard can accept a file handed to it.

    Adds a small, invisible listener to the bottom of each dashboard. It does
    not touch the dashboard's markup, styling or behaviour -- it only lets the
    Command Centre put a file into an upload box the same way you would. This
    is what makes the one-click fill work when the app is opened straight from
    disk, where pages are otherwise sealed off from one another.

    Runs every sync, so a dashboard you add later is covered automatically.
    Delete the marked block to opt a dashboard out.
    """
    _apply_marked_block(reg, BRIDGE_SRC, BRIDGE_OPEN, BRIDGE_CLOSE, _place_before_body_end, "bridge")


def ensure_session_guard(reg):
    """Make Session mode start every dashboard fresh, same as the shell itself.

    A dashboard's own "remember my data" feature uses the browser's real
    localStorage, which the Command Centre's Session/Local switch otherwise
    has no say over. This adds a tiny script as the very first thing on the
    page -- before the dashboard's own code runs -- that swaps localStorage
    for an in-memory stand-in only while the Command Centre is in Session
    mode. Local mode is untouched: dashboards keep using real storage, so
    "remember my data" keeps working exactly as before.
    """
    _apply_marked_block(reg, GUARD_SRC, GUARD_OPEN, GUARD_CLOSE, _place_after_head_open, "session guard")


def ensure_idle_timeout(reg):
    """Make every dashboard relay its own activity up to the hub page.

    Dashboards load in an iframe inside the hub (see app.js's
    openDashboard), a separate browsing context of its own, so moving the
    mouse or typing inside one never reaches the hub's own idle-timeout
    listeners. This adds the same idle-timeout.js used by the hub itself to
    every dashboard too -- running inside an iframe it only relays "something
    happened" up to the parent (see the file's own top comment), it does not
    show a competing prompt of its own.

    Runs every sync, so a dashboard added later is covered automatically.
    """
    _apply_marked_block(reg, IDLE_SRC, IDLE_OPEN, IDLE_CLOSE, _place_after_head_open, "idle timeout")


def mirror_auth():
    """Mirror the accounts in data/state.db into auth.js so the sign-in gate
    also works on file://. Same unredacted-on-purpose mirror auth.json used
    to get dumped into verbatim -- see appstore.read_auth()'s docstring."""
    auth = appstore.read_auth()
    if not auth:
        return
    with open(AUTH_OUT, "w", encoding="utf-8") as fh:
        fh.write("/* GENERATED FILE - do not edit.\n"
                 "   Source: data/state.db   Reset the password: python3 set_password.py */\n"
                 "window.__PARAS_AUTH__ = " + json.dumps(auth, indent=2, ensure_ascii=False) + ";\n")
    print("auth.js updated - sign-in %s"
          % ("enabled for " + auth.get("email", "?") if auth.get("enabled", True) else "DISABLED"))


def main():
    if not os.path.exists(SRC):
        sys.exit("dashboards.json not found next to sync.py")
    try:
        with open(SRC, encoding="utf-8") as fh:
            reg = json.load(fh)
    except json.JSONDecodeError as exc:
        sys.exit("dashboards.json is not valid JSON: %s (line %d, column %d)"
                 % (exc.msg, exc.lineno, exc.colno))

    body = json.dumps(reg, indent=2, ensure_ascii=False)
    with open(OUT, "w", encoding="utf-8") as fh:
        fh.write(BANNER + "window.__PARAS_REGISTRY__ = " + body + ";\n")

    n = len(reg.get("dashboards", []))
    print("dashboards.js updated - %d dashboard%s" % (n, "" if n == 1 else "s"))
    for p in check(reg):
        print("  ! " + p)
    ensure_session_guard(reg)
    ensure_bridge(reg)
    ensure_idle_timeout(reg)
    mirror_auth()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
