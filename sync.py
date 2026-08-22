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
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, "dashboards.json")
OUT = os.path.join(ROOT, "dashboards.js")
AUTH_SRC = os.path.join(ROOT, "auth.json")
AUTH_OUT = os.path.join(ROOT, "auth.js")
BRIDGE_SRC = os.path.join(ROOT, "assets", "js", "dashboard-bridge.js")
BRIDGE_OPEN = "<!-- paras-command-centre-bridge -->"
BRIDGE_CLOSE = "<!-- /paras-command-centre-bridge -->"

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
    try:
        with open(BRIDGE_SRC, encoding="utf-8") as fh:
            code = fh.read()
    except OSError:
        return
    block = "%s\n<script>\n%s</script>\n%s\n" % (BRIDGE_OPEN, code, BRIDGE_CLOSE)

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

        if BRIDGE_OPEN in html:
            start = html.index(BRIDGE_OPEN)
            end = html.find(BRIDGE_CLOSE)
            if end < 0:
                continue
            current = html[start:end + len(BRIDGE_CLOSE) + 1]
            if current.strip() == block.strip():
                continue                       # already current
            html = html[:start] + block + html[end + len(BRIDGE_CLOSE) + 1:]
        else:
            i = html.rfind("</body>")
            if i < 0:
                i = html.rfind("</html>")
            if i < 0:
                html = html + "\n" + block
            else:
                html = html[:i] + block + html[i:]

        try:
            with open(path, "w", encoding="utf-8", errors="surrogateescape") as fh:
                fh.write(html)
            touched += 1
        except OSError as exc:
            skipped.append("%s (%s)" % (rel, exc))

    if touched:
        print("bridge added to %d dashboard%s" % (touched, "" if touched == 1 else "s"))
    for sk in skipped:
        print("  ! could not update " + sk)


def mirror_auth():
    """Mirror auth.json into auth.js so the sign-in gate also works on file://."""
    if not os.path.exists(AUTH_SRC):
        return
    try:
        with open(AUTH_SRC, encoding="utf-8") as fh:
            auth = json.load(fh)
    except json.JSONDecodeError as exc:
        print("  ! auth.json is not valid JSON: %s (line %d)" % (exc.msg, exc.lineno))
        return
    with open(AUTH_OUT, "w", encoding="utf-8") as fh:
        fh.write("/* GENERATED FILE - do not edit.\n"
                 "   Source: auth.json   Reset the password: python3 set_password.py */\n"
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
    ensure_bridge(reg)
    mirror_auth()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
