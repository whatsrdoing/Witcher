#!/usr/bin/env python3
"""Start the Command Centre on a local-only web server.

    python3 serve.py            # http://127.0.0.1:8777
    python3 serve.py 9000       # pick a different port
    python3 serve.py --no-open  # don't launch a browser

It binds to 127.0.0.1 only, so nothing is reachable from the network. No
internet connection is used or required. Running this way (rather than
double-clicking index.html) is what enables LOCAL mode to keep attached files
across restarts, because browsers only allow IndexedDB on http:// origins.
"""
import functools
import http.server
import os
import socketserver
import sys
import threading
import webbrowser

ROOT = os.path.dirname(os.path.abspath(__file__))
DEFAULT_PORT = 8777


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # Local workspace: never let the browser serve a stale dashboard.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        if "GET / " in (fmt % args) or " 404 " in (fmt % args):
            sys.stderr.write("  %s\n" % (fmt % args))


def main(argv):
    port, auto_open = DEFAULT_PORT, True
    for a in argv:
        if a in ("--no-open", "-n"):
            auto_open = False
        elif a.isdigit():
            port = int(a)

    try:
        sys.path.insert(0, ROOT)
        import sync
        sync.main()
    except SystemExit as exc:
        print("sync warning: %s" % exc)
    except Exception as exc:                     # noqa: BLE001
        print("sync skipped: %s" % exc)

    socketserver.TCPServer.allow_reuse_address = True
    handler = functools.partial(Handler, directory=ROOT)
    try:
        httpd = socketserver.TCPServer(("127.0.0.1", port), handler)
    except OSError as exc:
        sys.exit("Could not bind port %d (%s). Try: python3 serve.py %d" % (port, exc, port + 1))

    url = "http://127.0.0.1:%d/" % port
    print("\n  PARAS HEALTH - SUPPLY CHAIN COMMAND CENTRE")
    print("  %s" % url)
    print("  Local only. Press Ctrl+C to stop.\n")
    if auto_open:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  Stopped.")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
