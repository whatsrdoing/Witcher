#!/usr/bin/env python3
"""Point a friendly hostname at this computer, so the Command Centre's address
bar reads like an internal site instead of a Downloads path.

    python3 setup_hostname.py              add the mapping (needs Administrator)
    python3 setup_hostname.py --remove     undo it
    python3 setup_hostname.py --check      show the current state, change nothing
    python3 setup_hostname.py scm.paras.internal      use a different name

What it does: adds one line to this computer's hosts file --

    127.0.0.1   parashealth.local

That is the whole trick, and it is the real one. The name then genuinely
resolves to this machine, the browser really connects to it, and the address
bar shows it because it is true. Nothing is registered on the internet and no
traffic leaves the computer.

Windows : right-click Command Prompt -> Run as administrator
macOS/Linux : sudo python3 setup_hostname.py

A backup of the hosts file is written next to it before any change.
"""
import ctypes
import datetime
import json
import os
import shutil
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.join(ROOT, "site.json")
MARKER = "# Paras Health Supply Chain Command Centre"

if os.name == "nt":
    HOSTS = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"),
                         "System32", "drivers", "etc", "hosts")
else:
    HOSTS = "/etc/hosts"


def configured_hostname():
    try:
        with open(SITE, encoding="utf-8") as fh:
            return json.load(fh).get("hostname") or "parashealth.local"
    except (OSError, ValueError):
        return "parashealth.local"


def is_admin():
    if os.name == "nt":
        try:
            return ctypes.windll.shell32.IsUserAnAdmin() != 0
        except Exception:                        # noqa: BLE001
            return False
    return os.geteuid() == 0


def read_hosts():
    for enc in ("utf-8", "utf-16", "latin-1"):
        try:
            with open(HOSTS, encoding=enc) as fh:
                return fh.read(), enc
        except UnicodeError:
            continue
        except OSError as exc:
            sys.exit("Cannot read %s (%s)" % (HOSTS, exc))
    sys.exit("Cannot decode %s" % HOSTS)


def mapped(text, host):
    for raw in text.splitlines():
        line = raw.split("#")[0].strip()
        if not line:
            continue
        parts = line.split()
        if len(parts) >= 2 and parts[0].startswith("127.") and host in parts[1:]:
            return True
    return False


def write_hosts(text, enc):
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    backup = "%s.paras-backup-%s" % (HOSTS, stamp)
    try:
        shutil.copy2(HOSTS, backup)
    except OSError as exc:
        sys.exit("Could not back up the hosts file (%s). Nothing was changed." % exc)
    try:
        with open(HOSTS, "w", encoding=enc) as fh:
            fh.write(text)
    except OSError as exc:
        shutil.copy2(backup, HOSTS)
        sys.exit("Could not write the hosts file (%s). It was restored from the backup." % exc)
    print("Backup written to %s" % backup)


def add(host):
    text, enc = read_hosts()
    if mapped(text, host):
        print("%s already points at this computer. Nothing to do." % host)
        return 0
    if not is_admin():
        return needs_admin()
    if text and not text.endswith("\n"):
        text += "\n"
    text += "\n%s\n127.0.0.1\t%s\n" % (MARKER, host)
    write_hosts(text, enc)
    print("\n  %s now points at this computer." % host)
    print("  Start the Command Centre with:  python3 serve.py")
    print("  Then open:  http://%s/supply-chain/command-centre/\n" % host)
    return 0


def remove(host):
    text, enc = read_hosts()
    if not mapped(text, host):
        print("%s is not mapped. Nothing to do." % host)
        return 0
    if not is_admin():
        return needs_admin()
    kept, dropped = [], 0
    for raw in text.splitlines():
        body = raw.split("#")[0].strip()
        parts = body.split()
        if len(parts) >= 2 and parts[0].startswith("127.") and host in parts[1:]:
            dropped += 1
            continue
        if raw.strip() == MARKER:
            continue
        kept.append(raw)
    write_hosts("\n".join(kept).rstrip("\n") + "\n", enc)
    print("Removed %d entry for %s." % (dropped, host))
    return 0


def needs_admin():
    print("\n  This needs administrator rights to edit:")
    print("    %s\n" % HOSTS)
    if os.name == "nt":
        print("  Press the Windows key, type: cmd")
        print("  Right-click Command Prompt -> Run as administrator, then:")
        print('    cd /d "%s"' % ROOT)
        print("    python setup_hostname.py\n")
    else:
        print("  Run:  sudo python3 %s\n" % os.path.abspath(__file__))
    return 1


def check(host):
    text, _ = read_hosts()
    ok = mapped(text, host)
    print("hosts file : %s" % HOSTS)
    print("hostname   : %s" % host)
    print("mapped     : %s" % ("yes" if ok else "no"))
    print("admin now  : %s" % ("yes" if is_admin() else "no"))
    if ok:
        print("\nOpen: http://%s/supply-chain/command-centre/" % host)
    else:
        print("\nNot mapped yet. Run this script with administrator rights to add it.")
    return 0


def main(argv):
    host = configured_hostname()
    action = add
    for a in argv:
        if a in ("--remove", "-r", "remove"):
            action = remove
        elif a in ("--check", "-c", "check"):
            action = check
        elif not a.startswith("-"):
            host = a.strip().lower()
    if not host or " " in host or "/" in host:
        sys.exit('Bad hostname %r. Use something like "parashealth.local".' % host)
    return action(host)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
