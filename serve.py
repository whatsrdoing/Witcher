#!/usr/bin/env python3
"""Start the Command Centre on a local-only web server.

    python3 serve.py                  http://parashealth.local/supply-chain/command-centre/
    python3 serve.py --app            open in an app window with no address bar
    python3 serve.py --port 8777      use a different port
    python3 serve.py --plain          skip the friendly path, serve at the root
    python3 serve.py --no-open        do not launch a browser

The server binds to 127.0.0.1 only, so nothing is reachable from the network,
and no internet connection is used or required.

The friendly hostname is real, not cosmetic: setup_hostname.py points
parashealth.local at 127.0.0.1 in this computer's hosts file, so the browser
genuinely resolves and connects to that name. Without that entry the same
server answers on http://127.0.0.1/... — no browser will display a domain that
is not actually serving the page, and none should.
"""
import functools
import http.server
import json
import os
import socket
import shutil
import socketserver
import subprocess
import sys
import threading
import webbrowser

ROOT = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.join(ROOT, "site.json")

DEFAULTS = {
    "hostname": "parashealth.local",
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

        def _redirect(self):
            if prefix == "/":
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
