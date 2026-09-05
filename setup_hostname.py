#!/usr/bin/env python3
"""Point a friendly hostname at this computer, so the Command Centre's address
bar reads like an internal site instead of a Downloads path.

    python3 setup_hostname.py             add the mapping (needs Administrator)
    python3 setup_hostname.py --doctor    diagnose why the address is not working
    python3 setup_hostname.py --remove    undo it
    python3 setup_hostname.py scm.paras.internal    use a different name

What it does: adds one line to this computer's hosts file --

    127.0.0.1   parashealth.internal

That is the whole trick, and it is the real one. The name then genuinely
resolves to this machine, the browser really connects to it, and the address
bar shows it because it is true. Nothing is registered on the internet and no
traffic leaves the computer.

Windows      right-click Command Prompt -> Run as administrator
macOS/Linux  sudo python3 setup_hostname.py

A backup of the hosts file is written next to it before any change.

Note on ".local": Windows resolves .local names over mDNS, and when Bonjour is
installed (it ships with iTunes and iCloud for Windows) it answers for them
before the hosts file is consulted -- so a .local entry can sit in the hosts
file and still fail with DNS_PROBE_FINISHED_NXDOMAIN. ".internal" is reserved
for private use and goes through ordinary resolution, where the hosts file
wins. That is why it is the default.
"""
import ctypes
import datetime
import json
import os
import shutil
import socket
import subprocess
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.join(ROOT, "site.json")
MARKER = "# Paras Health Supply Chain Command Centre"
DEFAULT_HOST = "parashealth.internal"

if os.name == "nt":
    HOSTS = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"),
                         "System32", "drivers", "etc", "hosts")
else:
    HOSTS = "/etc/hosts"


def site():
    try:
        with open(SITE, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


def configured():
    cfg = site()
    return (cfg.get("hostname") or DEFAULT_HOST,
            "/" + str(cfg.get("path") or "/supply-chain/command-centre/").strip("/") + "/",
            int(cfg.get("port") or 80),
            int(cfg.get("fallbackPort") or 8777))


def save_hostname(host):
    cfg = site()
    if cfg.get("hostname") == host:
        return
    cfg["hostname"] = host
    try:
        with open(SITE, "w", encoding="utf-8") as fh:
            json.dump(cfg, fh, indent=2, ensure_ascii=False)
            fh.write("\n")
        print("site.json updated to %s" % host)
    except OSError as exc:
        print("Could not update site.json (%s) - edit the hostname there by hand." % exc)


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


def in_hosts(text, host):
    for raw in text.splitlines():
        line = raw.split("#")[0].strip()
        if not line:
            continue
        parts = line.split()
        if len(parts) >= 2 and parts[0].startswith("127.") and host in parts[1:]:
            return True
    return False


def resolves(host):
    try:
        return socket.gethostbyname(host)
    except OSError:
        return None


def flush_dns():
    if os.name != "nt":
        return
    try:
        subprocess.run(["ipconfig", "/flushdns"], check=False,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        print("Flushed the Windows DNS cache.")
    except OSError:
        pass


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


def warn_local(host):
    if host.endswith(".local") and os.name == "nt":
        print("\n  WARNING: .local names are resolved over mDNS on Windows.")
        print("  If Bonjour is installed (it comes with iTunes and iCloud for Windows)")
        print("  it answers first and the hosts file is ignored, which shows up as")
        print("  DNS_PROBE_FINISHED_NXDOMAIN. Prefer a .internal name:")
        print("    python setup_hostname.py parashealth.internal\n")


def add(host):
    text, enc = read_hosts()
    warn_local(host)
    if in_hosts(text, host):
        print("%s is already in the hosts file." % host)
    else:
        if not is_admin():
            return needs_admin()
        if text and not text.endswith("\n"):
            text += "\n"
        text += "\n%s\n127.0.0.1\t%s\n" % (MARKER, host)
        write_hosts(text, enc)

    flush_dns()
    save_hostname(host)

    ip = resolves(host)
    _, path, port, fallback = configured()
    if ip and ip.startswith("127."):
        print("\n  %s -> %s   OK" % (host, ip))
        print("  Start the Command Centre:  python serve.py")
        print("  Then open:  http://%s%s\n" % (host, path))
        return 0

    print("\n  The line is in the hosts file, but %s still does not resolve." % host)
    warn_local(host)
    if not host.endswith(".local"):
        print("  Try: close every browser window and open it again, or reboot.")
    print("  Meanwhile the Command Centre always works at:")
    print("    http://127.0.0.1:%d%s\n" % (fallback if port == 80 else port, path))
    return 1


def remove(host):
    text, enc = read_hosts()
    if not in_hosts(text, host):
        print("%s is not in the hosts file. Nothing to do." % host)
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
    flush_dns()
    print("Removed %d entry for %s." % (dropped, host))
    return 0


def needs_admin():
    print("\n  This needs administrator rights to edit:")
    print("    %s\n" % HOSTS)
    if os.name == "nt":
        print("  Right-click setup_friendly_url.bat -> Run as administrator")
        print("  (or open Command Prompt as administrator, then:)")
        print('    cd /d "%s"' % ROOT)
        print("    python setup_hostname.py\n")
    else:
        print("  Run:  sudo python3 %s\n" % os.path.abspath(__file__))
    return 1


def port_open(port):
    s = socket.socket()
    s.settimeout(0.4)
    try:
        s.connect(("127.0.0.1", port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def doctor(host):
    _, path, port, fallback = configured()
    text, _ = read_hosts()
    entry = in_hosts(text, host)
    ip = resolves(host)
    good_ip = bool(ip and ip.startswith("127."))
    running = port_open(port)
    running_alt = port_open(fallback)

    def mark(ok):
        return "OK  " if ok else "FAIL"

    print("\n  PARAS HEALTH COMMAND CENTRE - address check\n")
    print("  hostname wanted        %s" % host)
    print("  hosts file             %s" % HOSTS)
    print("  %s line in hosts file" % mark(entry))
    print("  %s %s resolves        %s" % (mark(good_ip), host, ip or "not found"))
    print("  %s server on port %-4d" % (mark(running), port))
    if not running and running_alt:
        print("  OK   server on port %d (fallback)" % fallback)
    print("  running as admin       %s" % ("yes" if is_admin() else "no"))

    print("\n  What to do next:")
    if not entry:
        print("  * The hosts line is missing. Right-click setup_friendly_url.bat")
        print("    and choose 'Run as administrator'.")
    elif not good_ip:
        print("  * The line is there but the name does not resolve.")
        warn_local(host)
        if host.endswith(".local"):
            print("    Run:  python setup_hostname.py parashealth.internal")
        else:
            print("  * Close all browser windows and reopen, or reboot.")
    elif not (running or running_alt):
        print("  * The address is fine - the server just is not running.")
        print("    Double-click start.bat (or run: python serve.py)")
    else:
        url_port = "" if (running and port == 80) else ":%d" % (port if running else fallback)
        print("  * Everything checks out. Open:")
        print("      http://%s%s%s" % (host, url_port, path))
    print("")
    print("  The Command Centre always works at http://127.0.0.1:%d%s"
          % (fallback if not running else port, path))
    print("  and by double-clicking index.html, whatever the hostname does.\n")
    return 0


def main(argv):
    host, _, _, _ = configured()
    action = add
    for a in argv:
        if a in ("--remove", "-r", "remove"):
            action = remove
        elif a in ("--doctor", "--check", "-c", "doctor", "check"):
            action = doctor
        elif not a.startswith("-"):
            host = a.strip().lower()
    if not host or " " in host or "/" in host:
        sys.exit('Bad hostname %r. Use something like "parashealth.internal".' % host)
    return action(host)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
