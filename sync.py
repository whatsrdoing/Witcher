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
    mirror_auth()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
