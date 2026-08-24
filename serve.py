#!/usr/bin/env python3
"""Start the Command Centre on a local-only web server.

    python3 serve.py                  http://parashealth.internal/supply-chain/command-centre/
    python3 serve.py --app            open in an app window with no address bar
    python3 serve.py --port 8777      use a different port
    python3 serve.py --plain          skip the friendly path, serve at the root
    python3 serve.py --no-open        do not launch a browser

The server binds to 127.0.0.1 only, so nothing is reachable from the network,
and no internet connection is used or required.

The friendly hostname is real, not cosmetic: setup_hostname.py points
parashealth.internal at 127.0.0.1 in this computer's hosts file, so the browser
genuinely resolves and connects to that name. Without that entry the same
server answers on http://127.0.0.1/... — no browser will display a domain that
is not actually serving the page, and none should.
"""
import functools
import hashlib
import hmac
import http.server
import json
import os
import socket
import shutil
import socketserver
import subprocess
import sys
import threading
import time
import webbrowser

ROOT = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.join(ROOT, "site.json")

DEFAULTS = {
    "hostname": "parashealth.internal",
    "port": 80,
    "path": "/supply-chain/command-centre/",
    "fallbackPort": 8777,
}


def settings():
    cfg = dict(DEFAULTS)
    if os.path.exists(SITE):
        try:
            with open(SITE, encoding="utf-8") as fh:
                cfg.update({k: v for k, v in json.load(fh).items() if k in DEFAULTS})
        except (OSError, ValueError) as exc:
            print("site.json ignored (%s)" % exc)
    p = "/" + str(cfg["path"]).strip("/")
    cfg["path"] = "/" if p == "/" else p + "/"
    return cfg


def make_handler(prefix):
    class Handler(http.server.SimpleHTTPRequestHandler):
        """Serves the folder under a friendly path so the address bar reads like
        an internal site rather than a Downloads folder."""

        def do_GET(self):
            if self._redirect():
                return
            super().do_GET()

        def do_HEAD(self):
            if self._redirect():
                return
            super().do_HEAD()

        def do_POST(self):
            """Password reset and sign-up from the sign-in screen. Only ever
            writes auth.json, only from this machine (the server binds
            127.0.0.1), and only once the admin key checks out."""
            if self.path.rstrip("/").rsplit("/", 1)[-1] != "__auth":
                self.send_error(404)
                return
            try:
                n = int(self.headers.get("Content-Length") or 0)
                if n <= 0 or n > 8192:
                    raise ValueError("bad length")
                req = json.loads(self.rfile.read(n).decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                self._json(400, {"error": "bad request"})
                return

            path = os.path.join(ROOT, "auth.json")
            try:
                with open(path, encoding="utf-8") as fh:
                    auth = json.load(fh)
            except (OSError, ValueError):
                self._json(500, {"error": "auth.json unreadable"})
                return

            key = str(req.get("adminKey") or "")
            salt, want = auth.get("adminKeySalt"), auth.get("adminKeyHash")
            if not (salt and want):
                self._json(403, {"error": "no admin key configured"})
                return
            got = hashlib.pbkdf2_hmac("sha256", key.encode("utf-8"),
                                      bytes.fromhex(salt),
                                      int(auth.get("iterations") or 250000), 32).hex()
            if not hmac.compare_digest(got, str(want)):
                self._json(403, {"error": "bad admin key"})
                return

            new_salt, new_hash = str(req.get("salt") or ""), str(req.get("hash") or "")
            if len(new_salt) != 32 or len(new_hash) != 64:
                self._json(400, {"error": "bad payload"})
                return
            try:
                bytes.fromhex(new_salt); bytes.fromhex(new_hash)
            except ValueError:
                self._json(400, {"error": "bad payload"})
                return
            iterations = int(req.get("iterations") or auth.get("iterations") or 250000)

            action = req.get("action") or "reset"
            accounts = auth.get("accounts")
            if accounts is None:
                # Pre-multi-account file: treat the single legacy credential
                # as the one existing account, so both actions below have a
                # real accounts list to work against from here on.
                accounts = [{"login": auth.get("email", ""), "salt": auth.get("salt", ""),
                            "hash": auth.get("hash", ""), "iterations": auth.get("iterations", 250000)}]

            if action == "register":
                login = str(req.get("login") or "").strip()
                if not login:
                    self._json(400, {"error": "a username is required"})
                    return
                if any(a.get("login") == login for a in accounts):
                    self._json(409, {"error": "that username is already taken"})
                    return
                accounts.append({"login": login, "salt": new_salt, "hash": new_hash,
                                 "iterations": iterations, "createdAt": int(time.time() * 1000)})
                auth["accounts"] = accounts
                logmsg = "New account registered from the sign-in screen: %s" % login
            else:
                # "reset": update one existing account (named by "login"), or
                # the first/primary one when none is named.
                login = req.get("login")
                idx = 0
                if login:
                    for i, a in enumerate(accounts):
                        if a.get("login") == login:
                            idx = i
                            break
                    else:
                        self._json(404, {"error": "no such account"})
                        return
                accounts[idx]["salt"] = new_salt
                accounts[idx]["hash"] = new_hash
                accounts[idx]["iterations"] = iterations
                auth["accounts"] = accounts
                logmsg = "Password changed from the sign-in screen: %s" % accounts[idx].get("login", "?")

            # Legacy top-level fields mirror the primary account, for any code
            # still reading them directly.
            if accounts:
                auth["email"] = accounts[0].get("login", "")
                auth["logins"] = [accounts[0].get("login", "")]
                auth["salt"] = accounts[0].get("salt", "")
                auth["hash"] = accounts[0].get("hash", "")
                auth["iterations"] = accounts[0].get("iterations", iterations)

            try:
                with open(path, "w", encoding="utf-8") as fh:
                    json.dump(auth, fh, indent=2, ensure_ascii=False)
                    fh.write("\n")
                import sync
                sync.mirror_auth()
            except (OSError, ImportError) as exc:
                self._json(500, {"error": str(exc)})
                return
            print("  " + logmsg)
            self._json(200, {"ok": True})

        def _json(self, code, payload):
            body = json.dumps(payload).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _redirect(self):
            if prefix == "/":
                return False
            if self.path.rstrip("/").rsplit("/", 1)[-1] == "__auth":
                return False
            # Anything outside the friendly path goes to it, so the browser
            # never settles on a URL that is not the real one.
            if self.path.rstrip("/") == prefix.rstrip("/") and not self.path.endswith("/"):
                self.send_response(301)
                self.send_header("Location", prefix)
                self.end_headers()
                return True
            if not self.path.startswith(prefix):
                self.send_response(302)
                self.send_header("Location", prefix)
                self.end_headers()
                return True
            return False

        def translate_path(self, path):
            if prefix != "/" and path.startswith(prefix):
                path = "/" + path[len(prefix):]
            return super().translate_path(path)

        def end_headers(self):
            # Local workspace: never let the browser serve a stale dashboard.
            self.send_header("Cache-Control", "no-store")
            super().end_headers()

        def log_message(self, fmt, *args):
            line = fmt % args
            if " 404 " in line or " 500 " in line:
                sys.stderr.write("  %s\n" % line)

    return Handler


CHROMIUM_CANDIDATES = [
    r"%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe",
    r"%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe",
    r"%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe",
    r"%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe",
    r"%LocalAppData%\\Google\\Chrome\\Application\\chrome.exe",
]
MAC_APPS = ["/Applications/Google Chrome.app", "/Applications/Microsoft Edge.app"]
NIX_BINARIES = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"]


def find_app_browser():
    """A Chromium-family browser, which is what supports --app windows."""
    if os.name == "nt":
        for raw in CHROMIUM_CANDIDATES:
            path = os.path.expandvars(raw)
            if "%" not in path and os.path.exists(path):
                return [path]
        return None
    if sys.platform == "darwin":
        for app in MAC_APPS:
            if os.path.exists(app):
                return ["open", "-na", app, "--args"]
        return None
    for exe in NIX_BINARIES:
        found = shutil.which(exe)
        if found:
            return [found]
    return None


def open_window(url, app_mode):
    """Open the Command Centre, in a chrome-less app window when asked for."""
    if app_mode:
        browser = find_app_browser()
        if browser:
            try:
                subprocess.Popen(browser + ["--app=" + url],
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                return
            except OSError:
                pass
        print("  (no Chrome or Edge found for an app window - using the default browser)")
    webbrowser.open(url)


def hostname_is_mapped(host):
    try:
        return socket.gethostbyname(host).startswith("127.")
    except OSError:
        return False


def bind(port, prefix):
    socketserver.TCPServer.allow_reuse_address = True
    handler = functools.partial(make_handler(prefix), directory=ROOT)
    return socketserver.TCPServer(("127.0.0.1", port), handler)


def main(argv):
    cfg = settings()
    port, auto_open, prefix, app_mode = int(cfg["port"]), True, cfg["path"], False

    i = 0
    while i < len(argv):
        a = argv[i]
        if a in ("--no-open", "-n"):
            auto_open = False
        elif a in ("--app", "-a"):
            app_mode = True
        elif a == "--plain":
            prefix = "/"
        elif a == "--port" and i + 1 < len(argv):
            i += 1
            port = int(argv[i])
        elif a.isdigit():
            port = int(a)
        i += 1

    try:
        sys.path.insert(0, ROOT)
        import sync
        sync.main()
    except SystemExit as exc:
        print("sync warning: %s" % exc)
    except Exception as exc:                     # noqa: BLE001
        print("sync skipped: %s" % exc)

    try:
        httpd = bind(port, prefix)
    except OSError as exc:
        alt = int(cfg["fallbackPort"])
        if port == alt:
            sys.exit("Could not bind port %d (%s)." % (port, exc))
        print("Port %d is not available (%s) - using %d instead." % (port, exc, alt))
        try:
            httpd = bind(alt, prefix)
        except OSError as exc2:
            sys.exit("Could not bind port %d either (%s)." % (alt, exc2))
        port = alt

    host = cfg["hostname"] if hostname_is_mapped(cfg["hostname"]) else "127.0.0.1"
    netloc = host if port == 80 else "%s:%d" % (host, port)
    url = "http://%s%s" % (netloc, prefix)

    print("\n  PARAS HEALTH - SUPPLY CHAIN COMMAND CENTRE")
    print("  %s" % url)
    if host == "127.0.0.1" and cfg["hostname"]:
        print("  (run setup_hostname.py as Administrator to use %s instead)" % cfg["hostname"])
    print("  Local only. Press Ctrl+C to stop.\n")

    if auto_open:
        threading.Timer(0.6, lambda: open_window(url, app_mode)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  Stopped.")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
