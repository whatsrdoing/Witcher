#!/usr/bin/env python3
"""Start the Command Centre on a local-only web server.

    python3 serve.py                  http://parashealth.internal/supply-chain/command-centre/
    python3 serve.py --app            open in an app window with no address bar
    python3 serve.py --port 8777      use a different port
    python3 serve.py --plain          skip the friendly path, serve at the root
    python3 serve.py --no-open        do not launch a browser
    python3 serve.py --lan            also answer on this PC's network address,
                                       so other computers on the same office/WiFi
                                       network can reach it (see below)

By default the server binds to 127.0.0.1 only, so nothing is reachable from
the network, and no internet connection is used or required. --lan opts into
the opposite: it binds to every network interface on this machine, so any
other device on the same LAN can open it at this PC's local IP address (the
one printed on startup) -- no internet, no domain, no HTTPS involved, just
plain http:// over the office/home network. Windows will likely prompt to
allow Python through its firewall the first time this runs with --lan;
"Private networks" is enough, no need for "Public".

The friendly hostname is real, not cosmetic: setup_hostname.py points
parashealth.internal at 127.0.0.1 in this computer's hosts file, so the browser
genuinely resolves and connects to that name. Without that entry the same
server answers on http://127.0.0.1/... — no browser will display a domain that
is not actually serving the page, and none should.
"""
import base64
import binascii
import functools
import hashlib
import hmac
import html
import http.server
import json
import os
import posixpath
import re
import secrets
import socket
import shutil
import socketserver
import sqlite3
import struct
import subprocess
import sys
import threading
import time
import urllib.parse
import uuid
import webbrowser
import zipfile

ROOT = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.join(ROOT, "site.json")
DASHBOARDS_JSON = os.path.join(ROOT, "dashboards.json")

# Everything dropped into the Data Library (or pinned to a dashboard) lands
# here as real files -- not in the browser's IndexedDB -- so it shows up as
# ordinary files, survives a browser reset, and is easy to find and back up.
#
# paths.py puts that folder OUTSIDE the app folder, at a fixed place on this
# machine, so extracting a new build to a new folder does not leave the data
# behind. See paths.py for the resolution order (PARAS_DATA_DIR wins, which
# is also how selftest.py runs against a throwaway directory).
import paths
import appstore
import mail
import llm
import assistant

LIBRARY_DIR = paths.library_dir()
LIBRARY_BLOBS = paths.library_blobs()
SAFE_ID = re.compile(r"^[A-Za-z0-9_-]{1,80}$")
COPY_CHUNK = 1024 * 1024

# Past this, a claimed Content-Length is refused before a single byte is
# written to disk. Generous on purpose -- registers here run into the
# hundreds of megabytes -- but unbounded was a real hole: bound to
# 127.0.0.1 nobody could exploit it, but the moment this sits behind a
# reverse proxy for HTTPS access, an unbounded upload is a free way to fill
# the disk.
MAX_UPLOAD_BYTES = 300 * 1024 * 1024

DEFAULTS = {
    "hostname": "parashealth.internal",
    "port": 80,
    "path": "/supply-chain/command-centre/",
    "fallbackPort": 8777,
}


# ---------------------------------------------------------------------------
# Sessions
#
# The sign-in screen (gate.js) used to be the *only* gate: it checked the
# password in the browser and, on success, set a flag in this tab's
# sessionStorage. That is a fine "keep this workspace tidy on my own
# machine" lock, but it is not a security boundary -- nothing server-side
# ever learned whether sign-in succeeded, so every /__data and /__library
# endpoint below answered anyone who asked, gate or no gate. Harmless while
# the server only ever answers 127.0.0.1; a real hole the moment it sits
# behind a reverse proxy for outside access, which is exactly the plan.
#
# This is the fix: a real session, established by POST /__session (the
# browser sends the login and the PBKDF2 digest it already computed to
# verify the password locally; the server compares that digest against the
# stored hash itself and, only on a match, hands back a random token as an
# HttpOnly cookie). Every data-bearing endpoint below requires that cookie.
# Sessions live in memory only -- restarting the server signs everyone out,
# which is the right failure mode for a token that should not outlive a
# process restart anyway.
# ---------------------------------------------------------------------------
SESSION_COOKIE = "paras_session"
SESSION_TTL = 12 * 3600           # 12 hours
SESSIONS = {}                     # token -> {"login": str, "expires": float}
SESSION_LOCK = threading.Lock()


def new_session(login):
    token = secrets.token_hex(32)
    with SESSION_LOCK:
        SESSIONS[token] = {"login": login, "expires": time.time() + SESSION_TTL,
                           "startedAt": time.time(), "viewing": None}
    return token


def set_viewing(token, viewing):
    """Records which dashboard (or None for the hub itself) a session is
    currently looking at, self-reported by the browser -- see
    POST __session/viewing. Purely informational, for the admin panel's
    live-sessions view; never used for any access decision."""
    with SESSION_LOCK:
        rec = SESSIONS.get(token)
        if rec:
            rec["viewing"] = viewing


def active_sessions():
    """Every currently active session, for the admin panel."""
    now = time.time()
    with SESSION_LOCK:
        return [{"login": rec["login"], "viewing": rec.get("viewing"),
                  "startedAt": rec.get("startedAt")}
                for rec in SESSIONS.values() if rec["expires"] >= now]


def session_login(token):
    """The account a session token belongs to, or None if it is missing,
    unknown, or expired."""
    if not token:
        return None
    with SESSION_LOCK:
        rec = SESSIONS.get(token)
        if not rec:
            return None
        if rec["expires"] < time.time():
            del SESSIONS[token]
            return None
        return rec["login"]


def drop_session(token):
    with SESSION_LOCK:
        SESSIONS.pop(token, None)


# ---------------------------------------------------------------------------
# Hidden admin overlay -- typing the admin key into the search bar (see
# ask.js's sibling, the search-bar handler in app.js) grants whichever
# session is currently signed in on that browser -- any account, not just
# the primary admin's own -- temporary access to the /__admin/* routes,
# without changing who is actually signed in. Closing the overlay revokes
# it immediately (see POST /__session/admin-unlock/revoke); ADMIN_OVERLAY_TTL
# is only a safety ceiling for a tab that never gets the chance to send that
# (closed, crashed, network dropped), not the normal way this ends.
# ---------------------------------------------------------------------------
ADMIN_OVERLAY = {}                # session token -> expiry (epoch seconds)
ADMIN_OVERLAY_LOCK = threading.Lock()
ADMIN_OVERLAY_TTL = 20 * 60


def grant_admin_overlay(token):
    with ADMIN_OVERLAY_LOCK:
        ADMIN_OVERLAY[token] = time.time() + ADMIN_OVERLAY_TTL


def admin_overlay_active(token):
    if not token:
        return False
    with ADMIN_OVERLAY_LOCK:
        exp = ADMIN_OVERLAY.get(token)
        if exp and exp >= time.time():
            return True
        ADMIN_OVERLAY.pop(token, None)
        return False


def revoke_admin_overlay(token):
    with ADMIN_OVERLAY_LOCK:
        ADMIN_OVERLAY.pop(token, None)


def sessions_for(login):
    """Active (non-expired) session tokens currently open for this login."""
    now = time.time()
    with SESSION_LOCK:
        return [tok for tok, rec in SESSIONS.items()
                if rec["login"] == login and rec["expires"] >= now]


def drop_sessions_for(login):
    """End every active session open for this login. Used both by the
    single-active-session conflict resolver below and, later, by the admin
    panel's own force-logout."""
    with SESSION_LOCK:
        dead = [tok for tok, rec in SESSIONS.items() if rec["login"] == login]
        for tok in dead:
            del SESSIONS[tok]
        return len(dead)


# ---------------------------------------------------------------------------
# Single-active-session conflict handling.
#
# One account, one session, at a time. A second sign-in while the first is
# still active does not just silently open a second session (no telling who
# actually did what afterwards) -- it gets a conflict token instead of a
# cookie, and has to resolve it one of two ways: force the first session
# closed and take over now, or wait, polling quietly, until the first one
# ends on its own (a real logout, an idle timeout, expiry) and then continue
# automatically. Either way there is never more than one live session per
# account.
# ---------------------------------------------------------------------------
CONFLICT_TTL = 5 * 60
CONFLICTS = {}          # token -> {"login": str, "expires": float}
CONFLICT_LOCK = threading.Lock()


def new_conflict(login):
    token = secrets.token_hex(16)
    with CONFLICT_LOCK:
        CONFLICTS[token] = {"login": login, "expires": time.time() + CONFLICT_TTL}
    return token


def conflict_login(token):
    """The login a still-valid conflict token was issued for, or None."""
    with CONFLICT_LOCK:
        rec = CONFLICTS.get(token)
        if not rec or rec["expires"] < time.time():
            CONFLICTS.pop(token, None)
            return None
        return rec["login"]


def drop_conflict(token):
    with CONFLICT_LOCK:
        CONFLICTS.pop(token, None)


HISTORY_LOCK = threading.Lock()   # kept for API compatibility with older imports


def log_history(login, event, ip=None):
    """Append one entry to the persistent login/session history -- the
    admin panel's audit trail. Separate from SESSIONS (in-memory, forgets
    everything on restart, on purpose -- see the block above); this is
    meant to survive restarts and keep growing. Best-effort: a write
    failure here must never break the sign-in flow itself. Backed by
    appstore's login_history table (see appstore.py) -- was a
    replay-the-whole-file .jsonl log, now an indexed SQLite table.

    ip is recorded only for login_ok/login_fail -- the events where "which
    machine tried this" is actually useful for spotting misuse; the caller
    passes it in since only it has self.client_address."""
    try:
        appstore.log_history(login, event, ip)
    except sqlite3.Error:
        pass


def read_history(limit=200):
    """Most recent entries first."""
    return appstore.read_history(limit)


def history_stats():
    """Per-login total signed-in time (ms) and how many sessions that adds
    up over, best-effort: pairs each login_ok with the next logout or
    force_logout for that same login; one still open counts up to now."""
    return appstore.history_stats()


def log_view(login, dashboard_id):
    """Records every time a session's self-reported "what am I looking at"
    changes (see set_viewing / __session/viewing) -- unlike SESSIONS'
    in-memory "viewing" field, which only ever answers "right now", this is
    what usage_report() below replays to work out which dashboard a login
    actually spent time on, per day. Best-effort, same as log_history: a
    write failure here must never break navigation."""
    try:
        appstore.log_view(login, dashboard_id)
    except sqlite3.Error:
        pass


def usage_report():
    """Per-login, per-day: total signed-in time and time spent on each
    dashboard -- the admin panel's usage report. Built by replaying the
    login_history and view_history tables for session start/end times and
    which dashboard was open within those sessions, rather than kept live,
    since it is only ever asked for occasionally from the admin panel. A
    session (or the admin's own tab) left open counts up to right now."""
    return appstore.usage_report()


def log_ask_usage(model, input_tokens, output_tokens):
    """Records one answered Ask question -- best-effort, same shape as
    log_view: a write failure here must never break the Ask panel, it just
    means that question's tokens are missing from the running total the
    panel shows."""
    try:
        appstore.log_ask_usage(model, input_tokens, output_tokens)
    except sqlite3.Error:
        pass


def ask_usage_report():
    """Today's and this month's token/cost totals for the Ask panel's
    usage window. Cost is always assistant.estimate_cost's *estimate*
    from list pricing -- there is no API for a real account balance, so
    this never claims to be one; replayed from the ask_usage table the
    same way usage_report() replays the login/view history."""
    return appstore.ask_usage_report()


REQUESTS_LOCK = threading.Lock()


def read_requests():
    return appstore.read_requests()


def write_requests(requests):
    appstore.write_requests(requests)


FEEDBACK_LOCK = threading.Lock()


def read_feedback():
    return appstore.read_feedback()


def write_feedback(items):
    appstore.write_feedback(items)


def read_auth():
    """The exact dict shape auth.json used to be -- see appstore.read_auth().
    {} when no accounts are configured at all."""
    return appstore.read_auth()


def write_auth(auth):
    appstore.write_auth(auth)


# ---- sign-up email verification (OTP) ---------------------------------------
# In memory only, like SESSIONS -- a restart invalidating an in-flight code is
# a minor inconvenience (ask for a new one), not a reason to persist a value
# that is only ever useful for a few minutes. Two stages: a 6-digit code sent
# to the address the sign-up form has typed so far, then (once entered
# correctly) a longer-lived opaque token the sign-up request itself carries,
# so the code can't be replayed and the request doesn't need the code again.
OTP_LOCK = threading.Lock()
OTP_CODES = {}          # email -> {"code": str, "expires": float}
OTP_VERIFIED = {}       # token -> {"email": str, "expires": float}
OTP_CODE_TTL = 10 * 60
OTP_VERIFIED_TTL = 30 * 60


def otp_store(email, code):
    with OTP_LOCK:
        OTP_CODES[email] = {"code": code, "expires": time.time() + OTP_CODE_TTL}


def otp_check(email, code):
    """True and consumes the code on a match; False (code left in place, so
    a mistyped digit doesn't cost the whole attempt) otherwise."""
    with OTP_LOCK:
        rec = OTP_CODES.get(email)
        if not rec or rec["expires"] < time.time():
            OTP_CODES.pop(email, None)
            return False
        if not hmac.compare_digest(rec["code"], code):
            return False
        OTP_CODES.pop(email, None)
        return True


def otp_issue_token(email):
    token = secrets.token_hex(20)
    with OTP_LOCK:
        OTP_VERIFIED[token] = {"email": email, "expires": time.time() + OTP_VERIFIED_TTL}
    return token


def otp_token_email(token):
    """The verified email a still-valid token was issued for, or None."""
    with OTP_LOCK:
        rec = OTP_VERIFIED.get(token)
        if not rec or rec["expires"] < time.time():
            OTP_VERIFIED.pop(token, None)
            return None
        return rec["email"]


REQUEST_TYPE_LABEL = {"signup": "new account", "password_reset": "password reset",
                       "id_change": "sign-in name change"}

REQUEST_TYPE_EXPLAIN = {
    "signup": "%s has asked to create a new account on the Command Centre.",
    "password_reset": "%s has forgotten their password and asked to set a new one.",
    "id_change": "%s has asked to change the sign-in name they use.",
}


def esc_html(s):
    return html.escape(str(s or ""), quote=True)


def _email_shell(inner_html):
    """Wraps a system email's content in the same plain shell every one of
    these uses -- a small header, the content, a footer -- so the sign-up
    code and the admin notice look like they come from the same place
    rather than two unrelated scripts."""
    return (
        '<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;'
        'max-width:480px;margin:0 auto;padding:28px 24px;color:#1a2233;">'
        '<div style="text-align:center;margin-bottom:22px;">'
        '<div style="font-size:19px;font-weight:800;color:#2456c9;letter-spacing:-.01em;">Paras Health</div>'
        '<div style="font-size:11px;font-weight:700;letter-spacing:.09em;color:#7a8699;'
        'text-transform:uppercase;margin-top:2px;">SCM Command Centre</div>'
        '</div>'
        + inner_html +
        '<div style="margin-top:26px;padding-top:16px;border-top:1px solid #e6e9ef;'
        'font-size:11.5px;color:#98a2b3;text-align:center;">'
        'This is an automated message from Paras Health SCM Gen-Dash.'
        '</div></div>'
    )


def otp_email_bodies(code):
    """Plain-text + HTML bodies for the sign-up verification code -- the
    plain version has to stand on its own (some mail clients never render
    HTML at all), the HTML version is what makes the code actually look
    like a code instead of just another word in a sentence."""
    text = (
        "Hello,\n\n"
        "Thanks for requesting a Paras Health SCM Command Centre account.\n\n"
        "Your verification code is:\n\n"
        "    %s\n\n"
        "Enter this on the sign-up screen to confirm your email address. "
        "It expires in 10 minutes.\n\n"
        "If you didn't request this, you can safely ignore this email.\n\n"
        "-- Paras Health SCM Command Centre" % code
    )
    html = _email_shell(
        '<p style="font-size:15px;line-height:1.7;margin:0 0 14px;">Hello,</p>'
        '<p style="font-size:15px;line-height:1.7;margin:0 0 14px;">Thanks for requesting a Paras '
        'Health SCM Command Centre account. Use the code below to confirm your email address.</p>'
        '<div style="text-align:center;margin:26px 0;">'
        '<span style="display:inline-block;font-size:34px;font-weight:800;letter-spacing:.18em;'
        'color:#1a2233;background:#f1f5fb;padding:14px 22px;border-radius:12px;">' + esc_html(code) + '</span>'
        '</div>'
        '<p style="font-size:13.5px;line-height:1.6;color:#5b6472;margin:0 0 8px;">This code expires in '
        '10 minutes.</p>'
        '<p style="font-size:13.5px;line-height:1.6;color:#5b6472;margin:0;">If you didn\'t request this, '
        'you can safely ignore this email.</p>'
    )
    return text, html


def request_notify_bodies(rtype, login):
    """Plain-text + HTML bodies for the admin's new-request notice -- names
    the account, says in one sentence what they actually did, and is clear
    that nothing has happened yet without the admin's approval."""
    label = REQUEST_TYPE_LABEL.get(rtype, rtype)
    # Every template (including this fallback, with the label already
    # substituted in) takes exactly one %s -- login -- applied uniformly below.
    explain = (REQUEST_TYPE_EXPLAIN.get(rtype) or ("%%s has raised a %s request." % label)) % login
    text = (
        "Hello,\n\n"
        "A new request is waiting for your approval on the Paras Health SCM Command Centre.\n\n"
        "%s\n\n"
        "Nothing changes until you review it -- open the admin panel's Pending Requests to "
        "approve or reject it.\n\n"
        "-- Paras Health SCM Command Centre" % explain
    )
    html = _email_shell(
        '<p style="font-size:15px;line-height:1.7;margin:0 0 14px;">Hello,</p>'
        '<p style="font-size:15px;line-height:1.7;margin:0 0 14px;">A new '
        '<b>' + esc_html(label) + '</b> request is waiting for your approval on the Command Centre.</p>'
        '<p style="font-size:15px;line-height:1.7;margin:0 0 18px;background:#f1f5fb;'
        'padding:14px 16px;border-radius:10px;">' + esc_html(explain) + '</p>'
        '<p style="font-size:13.5px;line-height:1.6;color:#5b6472;margin:0;">Nothing changes until you '
        'review it -- open the admin panel\'s Pending Requests to approve or reject it.</p>'
    )
    return text, html


def notify_admin_of_request(rtype, login):
    """Emails the admin (auth.json's adminEmail, same address the sign-in
    screen's "Forgot password?" link already uses) that a request landed in
    the queue -- sent from a throwaway thread so a slow or unreachable mail
    server never delays the response to whoever just raised the request.
    Silently does nothing if mail isn't set up or no admin email is on
    file, exactly like every other best-effort mail send in this file."""
    if not mail.mail_enabled():
        return
    admin_email = (read_auth().get("adminEmail") or "").strip()
    if not admin_email:
        return
    label = REQUEST_TYPE_LABEL.get(rtype, rtype)
    text, html = request_notify_bodies(rtype, login)
    threading.Thread(target=mail.send_mail,
                      args=(admin_email, "Paras Health SCM: %s request" % label, text),
                      kwargs={"html": html},
                      daemon=True).start()


# ---- automated backups -----------------------------------------------------
# Everything this install has accumulated -- accounts, uploaded registers,
# the database -- lives only on this one machine (see paths.py). A zip of
# the whole data folder, taken automatically once a day and kept for the
# last couple of weeks, is the difference between a wiped disk being an
# afternoon's inconvenience and losing months of supply-chain data outright.
BACKUPS_DIR = os.path.join(paths.data_dir(), "backups")
BACKUP_INTERVAL_SECONDS = 24 * 3600
BACKUP_KEEP = 14
BACKUP_LOCK = threading.Lock()
BACKUP_NAME_RE = re.compile(r"^backup-\d{8}-\d{6}\.zip$")


def list_backups():
    """Newest first."""
    try:
        names = [f for f in os.listdir(BACKUPS_DIR) if BACKUP_NAME_RE.match(f)]
    except OSError:
        return []
    out = []
    for name in names:
        full = os.path.join(BACKUPS_DIR, name)
        try:
            st = os.stat(full)
        except OSError:
            continue
        out.append({"name": name, "size": st.st_size, "createdAt": int(st.st_mtime * 1000)})
    out.sort(key=lambda b: b["createdAt"], reverse=True)
    return out


def _prune_backups():
    for stale in list_backups()[BACKUP_KEEP:]:
        try:
            os.remove(os.path.join(BACKUPS_DIR, stale["name"]))
        except OSError:
            pass


def make_backup():
    """Zip everything under the data folder -- except backups/ itself, so a
    backup never nests inside another one -- into a new timestamped archive,
    then prune down to the newest BACKUP_KEEP. Best-effort: a failure here
    (disk full, permissions) must never take the server down; it is logged
    and surfaced to whoever asked for it, not raised."""
    root = paths.data_dir()
    os.makedirs(BACKUPS_DIR, exist_ok=True)
    name = "backup-%s.zip" % time.strftime("%Y%m%d-%H%M%S")
    tmp_path = os.path.join(BACKUPS_DIR, name + ".tmp")
    with BACKUP_LOCK:
        try:
            with zipfile.ZipFile(tmp_path, "w", zipfile.ZIP_DEFLATED) as zf:
                for dirpath, dirnames, filenames in os.walk(root):
                    dirnames[:] = [d for d in dirnames if os.path.join(dirpath, d) != BACKUPS_DIR]
                    for fn in filenames:
                        full = os.path.join(dirpath, fn)
                        zf.write(full, os.path.relpath(full, root))
            os.replace(tmp_path, os.path.join(BACKUPS_DIR, name))
        except OSError as exc:
            try:
                os.remove(tmp_path)
            except OSError:
                pass
            print("  Backup failed: %s" % exc)
            return None
        _prune_backups()
    print("  Backup created: %s" % name)
    return name


def backup_scheduler_loop():
    """Runs for the life of the process. Checks hourly, but only actually
    backs up once BACKUP_INTERVAL_SECONDS has passed since the newest one on
    disk -- so restarting the server throughout the day does not spam
    backups, and a machine left running for weeks still gets one roughly
    daily."""
    while True:
        try:
            backups = list_backups()
            last = backups[0]["createdAt"] / 1000.0 if backups else 0
            if time.time() - last >= BACKUP_INTERVAL_SECONDS:
                make_backup()
        except Exception as exc:                     # noqa: BLE001
            print("  Backup scheduler error: %s" % exc)
        time.sleep(3600)


def start_backup_scheduler():
    threading.Thread(target=backup_scheduler_loop, daemon=True).start()


# ---- TOTP two-factor authentication -----------------------------------------
# Deliberately its own file, never a field on the account entries in
# auth.json: mirror_auth() dumps auth.json verbatim into auth.js so file://
# mode's sign-in gate still works with no server to ask -- a real password
# hash sitting there already is an accepted, documented tradeoff of that
# fallback, but a TOTP secret sitting there too would hand out the ability to
# generate valid codes to anyone who can read a plain static file, defeating
# 2FA outright. Keeping it in a separate file under data_dir() (never inside
# ROOT, never mirrored, never served by any route) means it is simply never
# reachable the way auth.js is.
TOTP_LOCK = threading.Lock()
TOTP_ISSUER = "Paras Health SCM"


def read_totp():
    return appstore.read_totp()


def write_totp(data):
    appstore.write_totp(data)


def totp_new_secret():
    return base64.b32encode(secrets.token_bytes(20)).decode("ascii").rstrip("=")


def totp_code(secret, for_time, period=30, digits=6):
    """RFC 6238, SHA-1/HMAC -- the same algorithm every authenticator app
    (Google Authenticator, Authy, 1Password, ...) implements, so any of them
    can scan or manually enter the secret from setup."""
    padded = secret + "=" * (-len(secret) % 8)
    key = base64.b32decode(padded, casefold=True)
    counter = int(for_time // period)
    msg = struct.pack(">Q", counter)
    digest = hmac.new(key, msg, hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    chunk = struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF
    return str(chunk % (10 ** digits)).zfill(digits)


def totp_verify(secret, code, window=2, period=30):
    """window=2 accepts the current step plus two either side (a couple of
    minutes either way), tolerating the clock drift a real phone or laptop
    accumulates in practice -- window=1 (30s either way) turned out too
    tight and was the single most common "2FA isn't working" complaint,
    for an accepted-codes cost that stays negligible next to the rate
    limit already in place on both the setup-confirm and sign-in steps."""
    code = re.sub(r"\s+", "", str(code or ""))
    if not code.isdigit() or not secret:
        return False
    now = time.time()
    for delta in range(-window, window + 1):
        try:
            if hmac.compare_digest(totp_code(secret, now + delta * period, period), code):
                return True
        except (ValueError, binascii.Error):
            return False
    return False


def totp_new_backup_codes(n=8):
    """Plaintext codes are returned to the caller exactly once (right after
    generation) and never stored -- only their hashes are, same principle as
    a password."""
    codes = ["-".join([secrets.token_hex(2), secrets.token_hex(2)]).upper() for _ in range(n)]
    # Hash the normalized form (no hyphen) -- the hyphen is only cosmetic for
    # display, and consumption normalizes its input the same way, so the two
    # sides must agree on what actually gets hashed.
    hashes = [hashlib.sha256(c.replace("-", "").encode()).hexdigest() for c in codes]
    return codes, hashes


def totp_consume_backup_code(entry, code):
    norm = re.sub(r"[^0-9A-Za-z]", "", str(code or "")).upper()
    if not norm:
        return False
    h = hashlib.sha256(norm.encode()).hexdigest()
    codes = entry.get("backupCodes") or []
    if h in codes:
        codes.remove(h)
        entry["backupCodes"] = codes
        return True
    return False


TOTP_PENDING_TTL = 120
TOTP_PENDING = {}
TOTP_PENDING_LOCK = threading.Lock()


def new_totp_pending(login):
    token = secrets.token_urlsafe(24)
    with TOTP_PENDING_LOCK:
        TOTP_PENDING[token] = {"login": login, "expires": time.time() + TOTP_PENDING_TTL}
    return token


def totp_pending_login(token):
    with TOTP_PENDING_LOCK:
        entry = TOTP_PENDING.get(token)
        if not entry or entry["expires"] < time.time():
            TOTP_PENDING.pop(token, None)
            return None
        return entry["login"]


def drop_totp_pending(token):
    with TOTP_PENDING_LOCK:
        TOTP_PENDING.pop(token, None)


def clean_login(raw):
    """Every path that accepts a sign-in name as input (signup, an
    id-change request, an admin rename) runs it through this rather than a
    bare str().strip() -- a login is never shown back to anyone unescaped
    server-side, but it does get written into auth.json, into every audit
    log line for that account, and rendered client-side (already escaped
    there); a control character or an unbounded length here is not
    exploitable on its own, just needless mess. Empty string means
    "rejected", same as the falsy check every caller already did."""
    s = str(raw or "").strip()
    s = "".join(c for c in s if ord(c) >= 0x20 and ord(c) != 0x7f)
    return s[:64]


COMMON_PASSWORDS = {
    "password", "password1", "password123", "12345678", "123456789", "1234567890",
    "qwerty123", "qwertyuiop", "letmein123", "welcome123", "admin1234", "iloveyou1",
}


# Two letters, a dash, three letters, a dash, five digits -- e.g. GG-COR-07365.
# Same pattern gate.js enforces client-side at signup; kept here too for the
# admin panel's "Edit profile" action, which writes straight to auth.json
# with nothing else standing between it and a malformed value.
PARAS_ID_RE = re.compile(r"^[A-Z]{2}-[A-Z]{3}-[0-9]{5}$")


def password_policy_problem(pw, login):
    """Same policy gate.js enforces client-side for signup/reset (where the
    server never sees the plaintext, only its hash) -- applied here too for
    the one path that does see a plaintext password: the admin panel's
    direct "reset this account's password" action, which sends it over an
    already-authenticated admin session rather than hashing it client-side
    first."""
    if len(pw) < 10:
        return "use at least 10 characters"
    if login and pw.lower() == login.lower():
        return "don't use the sign-in name as the password"
    if pw.lower() in COMMON_PASSWORDS:
        return "that password is too easy to guess"
    return None


def admin_login():
    """The primary account's login, or None if auth.json has none yet.

    set_password.py always keeps the account it was last run against as
    accounts[0] (a fresh signup from the in-app screen is appended, never
    inserted first -- see build() there), and mirrors that same login into
    the top-level "email" field for older builds. Either one reliably names
    the one account this app treats as admin; there is no separate "is
    admin" flag anywhere in the data, this ordering is it."""
    auth = read_auth()
    if not auth:
        return None
    accounts = auth.get("accounts")
    if accounts:
        return accounts[0].get("login")
    return auth.get("email") or None


def auth_configured():
    """False when there is no auth.json yet, or it explicitly says
    enabled: false -- gate.js opens straight in for either, so the API
    matches it rather than locking the owner out of a workspace that has
    never had a password set."""
    cfg = read_auth()
    if not cfg:
        return False
    if cfg.get("enabled") is False:
        return False
    return bool(cfg.get("accounts") or cfg.get("hash"))


# ---------------------------------------------------------------------------
# A small, in-memory rate limiter shared by sign-in and the admin key.
#
# gate.js already locks the sign-in form out client-side after too many
# wrong passwords, but that state lives in sessionStorage -- meaningless to
# anyone calling the API directly instead of clicking through the form.
# This is the version that actually stops an offline script from just
# trying passwords as fast as the network allows.
# ---------------------------------------------------------------------------
RATE_MAX = 5           # failures allowed...
RATE_WINDOW = 60        # ...within this many seconds...
RATE_LOCKOUT = 60       # ...before the key is locked out for this many more
RATE_LOCK = threading.Lock()
RATE_BUCKETS = {}       # key -> {"n": int, "first": float, "until": float}


def rate_locked(key):
    with RATE_LOCK:
        b = RATE_BUCKETS.get(key)
        return bool(b and b.get("until", 0) > time.time())


def rate_fail(key):
    with RATE_LOCK:
        now = time.time()
        b = RATE_BUCKETS.setdefault(key, {"n": 0, "first": now, "until": 0})
        if now - b["first"] > RATE_WINDOW:
            b["n"], b["first"] = 0, now
        b["n"] += 1
        if b["n"] >= RATE_MAX:
            b["until"] = now + RATE_LOCKOUT
            b["n"] = 0


def rate_clear(key):
    with RATE_LOCK:
        RATE_BUCKETS.pop(key, None)


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


# Every read-modify-write of index.json runs under this. The server is
# threaded (so one large upload cannot freeze the whole UI), which means two
# requests really can land on the index at the same time -- without the lock
# the slower one would overwrite the faster one's entry and that file would
# silently disappear from the library.
LIBRARY_LOCK = threading.Lock()


def library_read_index():
    return appstore.library_read_index()


def library_write_index(files):
    """Replace the Data Library's index in one SQLite transaction -- same
    "rewrite the whole list" semantics the old atomic temp-file-then-
    os.replace() index.json had, just backed by appstore now."""
    appstore.library_write_index(files)


DB_PATH = paths.db_path()
_store = None
_store_lock = threading.Lock()


def store():
    """The month-on-month database, opened on first use.

    Kept behind a lock because the server is threaded: SQLite handles
    concurrent readers fine, but two threads importing at once would fight
    over the same write transaction.
    """
    global _store
    with _store_lock:
        if _store is None:
            import datastore
            _store = datastore.DataStore(DB_PATH)
        return _store


def _dataset_key(dataset):
    """The one key a register is known by, whatever spelling asked for it.

    datastore.slug() is what turns a dataset name into its table name, and
    SQLite identifiers are case-insensitive on top of that -- so every
    spelling that can reach the same table has to collapse to the same key
    here, or a permission check on the name is not a check on the data.

    Called with the same fallback datastore._table() itself uses ("dataset",
    not slug()'s own default "col") -- otherwise a dataset whose slug comes
    out empty gets table ds_dataset but permission key "col", two identities
    for one register, which is precisely the class of bug this function
    exists to close."""
    try:
        import datastore
        return datastore.slug(str(dataset or ""), "dataset").lower()
    except Exception:                                     # noqa: BLE001
        # Never fail open: with no way to normalise, fall back to a mirror
        # of datastore.slug() precise enough that it cannot itself become a
        # bypass -- the difference between this and datastore.slug() is the
        # only gap this whole function exists to close, so an inexact
        # fallback would just move the bug rather than remove it. Mirrors
        # every rule: non-alphanumeric runs to "_", trimmed, "c_" prefixed
        # when the result would not start with a letter, the same "dataset"
        # fallback datastore._table() uses when it is empty, cut to 63
        # characters -- then lowercased on top, the one step slug() itself
        # does not do, because SQLite's own case-insensitivity is what makes
        # that step necessary here.
        s = re.sub(r"[^A-Za-z0-9]+", "_", str(dataset or "")).strip("_")
        if not s:
            s = "dataset"
        if not s[0].isalpha():
            s = "c_" + s
        return s[:63].lower()


def _normalized_path(path_only):
    """Percent-decoded, backslash-folded, dot-segment-resolved, per-segment
    trailing dots/spaces stripped (Windows resolves "X." and "X " to "X"),
    and lowercased.

    This is the normalisation _is_admin_only_file already applied to its
    own comparison, generalised: every exact-name route match in this file
    (auth.json, dashboards.json, __where, and the rest) has to compare
    against what a request actually resolves to, not its raw, possibly
    percent-encoded spelling, or a request for "/%61uth.json" walks past
    the special-cased handling here and falls through unnormalised to the
    static file handler underneath it -- which is exactly the bug that let
    a percent-encoded auth.json reach the real (unredacted) file on disk
    instead of the redacted /auth.json route.
    """
    asked = urllib.parse.unquote(path_only).replace("\\", "/")
    asked = posixpath.normpath(asked).lstrip("/")
    asked = "/".join(seg.rstrip(". ") for seg in asked.split("/"))
    return asked.lower()


def _route_name(path_only):
    """The final segment of the normalised path -- what a route match
    against an exact filename or route name should compare against,
    instead of the raw tail of the (possibly percent-encoded) request."""
    return _normalized_path(path_only).rsplit("/", 1)[-1]


# Filenames that must never reach the static file handler, however the
# request spells the path -- both carry live credential hashes. auth.js is
# the file://-mode mirror sync.mirror_auth() regenerates on every start;
# auth.json at the app root is a legacy file nothing reads any more. The
# sign-in flow over HTTP gets its data from _send_auth()'s redacted
# /auth.json route instead, so neither file needs to be reachable at all.
_NEVER_SERVE_STATIC = ("auth.js", "auth.json")


def seg_route(path, name):
    """Whatever follows /<name>/ in the path, or None if this is not one.
    self.path arrives percent-encoded and never decoded upstream, so each
    segment is unquoted here -- after splitting, not before, so an
    encodeURIComponent'd "/" inside one segment (a login like "admin/ritik",
    say) stays that one segment rather than getting split again."""
    segs = [s for s in path.split("/") if s]
    if name not in segs:
        return None
    return [urllib.parse.unquote(s) for s in segs[segs.index(name) + 1:]]


def library_route(path):
    """Splits a request path into whatever comes after '__library', or None
    if this request is not a library one. Matches on the segment itself so
    it works no matter what friendly prefix site.json is configured with."""
    segs = [s for s in path.split("/") if s]
    if "__library" not in segs:
        return None
    i = segs.index("__library")
    return [urllib.parse.unquote(s) for s in segs[i + 1:]]


def make_handler(prefix):
    class Handler(http.server.SimpleHTTPRequestHandler):
        """Serves the folder under a friendly path so the address bar reads like
        an internal site rather than a Downloads folder."""

        # Python's stock error page is a black screen reading "Nothing matches
        # the given URI", which tells someone who mistyped an address nothing
        # about what to do next. This one names the address that does work and
        # links to it, so a wrong turn is a dead end you can walk back from.
        error_message_format = (
            '<!doctype html><html lang="en"><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width,initial-scale=1">'
            '<title>Not this address</title><style>'
            'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;'
            'background:radial-gradient(120%% 90%% at 50%% -10%%,#24365C,#182541 42%%,#121C31);'
            'color:#EFF4FA;font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;'
            'text-align:center;padding:28px}'
            '.card{max-width:520px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.13);'
            'border-radius:22px;padding:34px 30px;box-shadow:0 28px 80px rgba(3,8,20,.7)}'
            'h1{margin:0 0 10px;font-size:20px;font-weight:800;letter-spacing:-.01em}'
            'p{margin:0 0 8px;color:#AEBCCE;font-size:13.5px}'
            'code{background:rgba(255,255,255,.09);padding:2px 7px;border-radius:6px;font-size:12.5px;'
            'word-break:break-all}'
            'a.go{display:inline-block;margin-top:20px;padding:12px 20px;border-radius:11px;color:#fff;'
            'font-weight:700;font-size:14px;text-decoration:none;'
            'background:linear-gradient(135deg,#4E86E0,#2F5CA2);box-shadow:0 6px 20px rgba(47,92,162,.45)}'
            '</style></head><body><div class="card">'
            '<h1>There is nothing at this address</h1>'
            '<p>The Command Centre is running, but <code>%(explain)s</code> is not part of it.</p>'
            '<p>This usually means a typed or bookmarked address that has changed.</p>'
            '<a class="go" href="' + prefix + '">Open the Command Centre</a>'
            '</div></body></html>'
        )
        error_content_type = "text/html;charset=utf-8"

        def send_error(self, code, message=None, explain=None):
            # The stock explain text is boilerplate about URIs; the address
            # actually asked for is the useful thing to show.
            if explain is None:
                explain = self.path
            return http.server.SimpleHTTPRequestHandler.send_error(self, code, message, explain)

        def do_GET(self):
            path_only = self.path.split("?")[0]
            tail = library_route(path_only)
            if tail is not None:
                if self._require_session():
                    self._library_get(tail)
                return
            dtail = seg_route(path_only, "__data")
            if dtail is not None:
                if self._require_session():
                    self._data_get(dtail, urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query))
                return
            ctail = seg_route(path_only, "__cache")
            if ctail is not None:
                if self._require_session():
                    self._cache_get(ctail)
                return
            # auth.json lives with the data now, not in the app folder, so the
            # static handler would 404 it. The sign-in gate fetches it by that
            # exact name, so it is served here under the name it asks for.
            # Reachable without a session on purpose -- it is what the sign-in
            # screen itself loads before there is one to have.
            if _route_name(path_only) == "auth.json":
                self._send_auth()
                return
            # dashboards.json itself still ships as a plain file (new
            # dashboards arrive with every app update, same as index.html
            # does) -- but an admin's own choice to hide one lives in
            # appstore's dashboard_overrides table now, not in that file, so
            # it survives the next update instead of being overwritten by
            # it. Served here, merged, under the same name the registry
            # already fetches -- registry.js does not need to know this
            # changed. No session required, same reasoning as dashboards.js:
            # the hub needs the list before anyone has signed in.
            if _route_name(path_only) == "dashboards.json":
                reg = appstore.read_dashboards_registry()
                if not reg:
                    self.send_error(404)
                    return
                self._json(200, reg)
                return
            # Where is my data? Answerable from inside the app rather than
            # only from this terminal window.
            if _route_name(path_only) == "__where":
                self._json(200, {"dataDir": paths.data_dir(),
                                 "library": LIBRARY_DIR,
                                 "database": DB_PATH,
                                 "inAppFolder": paths.fell_back()})
                return
            # A cheap way for the gate to check "is sessionStorage's unlock
            # flag backed by a real session, or just left over from before
            # sessions existed / since expired / since a server restart
            # cleared them" without pulling an actual page of data to find
            # out. No session required to ask -- the answer itself is the
            # point, not something that needs to already be signed in.
            if _route_name(path_only) == "__session":
                login = session_login(self._session_token())
                if login:
                    totp_enabled = bool((read_totp().get(login) or {}).get("enabled"))
                    self._json(200, {"login": login, "isAdmin": login == admin_login(), "totpEnabled": totp_enabled})
                else:
                    self._json(401, {"error": "no session"})
                return
            # Whether the sign-up form should ask for (and require) an email
            # code before letting a request through -- no session needed to
            # ask, since it has to be answerable before anyone signs in.
            if seg_route(path_only, "__mail") == ["status"]:
                self._json(200, {"enabled": mail.mail_enabled()})
                return
            atail = seg_route(path_only, "__admin")
            if atail is not None:
                if self._require_admin():
                    self._admin_get(atail, urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query))
                return
            # A signed-in account's own view of what it has raised -- not the
            # admin-only full list (that is __admin/feedback), just enough
            # for the "Raise a request" window to show "here's where yours
            # stand" without needing email notifications.
            if _route_name(path_only) == "__feedback":
                login = session_login(self._session_token())
                if not login:
                    self._json(401, {"error": "sign in required"})
                    return
                mine = [f for f in read_feedback() if f.get("login") == login]
                mine.sort(key=lambda f: f.get("createdAt") or 0, reverse=True)
                self._json(200, {"items": mine[:20]})
                return
            if self._redirect():
                return
            # An admin-only dashboard is hidden from the hub's grid by app.js,
            # but that is a decision made in the browser: the file itself was
            # still served to anyone signed in who typed its address, and it
            # would then load its own registers and render in full. Hiding it
            # has to mean the page cannot be fetched at all, not merely that
            # it is not linked.
            if self._is_admin_only_file(path_only):
                self.send_error(404)
                return
            # Everything above this line either already answered the
            # request or is a dynamic route with its own dataset/session
            # gating -- what's left falls through to the plain static file
            # handler below, so this is where a path that must never reach
            # it (auth.js, the legacy auth.json, the data folder if it
            # ever ends up inside the app folder) gets refused, unrelated
            # to whether the caller is an admin.
            if self._is_blocked_static_path(path_only):
                self.send_error(404)
                return
            super().do_GET()

        def _is_admin_only_file(self, path_only):
            """Whether this path is a dashboard currently marked admin-only,
            being requested by a session that is not an admin.

            The previous version of this check normalised the path before
            comparing it, but bailed out before that -- on an ".html"/".htm"
            suffix test run against the *raw* path -- as a cheap early exit.
            "/X.html/.", "/X.html/x/..", "//X.html" and "/X.html/%2e" all
            fail that raw suffix test (they end in ".", "..", "X.html" after
            a blank segment, or "%2e"), so the function returned False and
            the request fell through to the static file handler, which
            normalises the path itself and serves the file anyway. The
            normalisation this function did was never wrong; it just never
            ran. There is no cheap pre-check here now -- everything is
            normalised first, unconditionally, and only then compared.
            """
            if self._is_admin():
                return False
            _ids, files = self._admin_only_dashboards()
            if not files:
                return False
            # 404 rather than 403 throughout, on purpose: an account that
            # may not open a dashboard has no business learning it exists.
            asked = _normalized_path(path_only)
            return any(asked == f.lower() or asked.endswith("/" + f.lower()) for f in files)

        def _is_blocked_static_path(self, path_only):
            """Files and folders that must never reach the static file
            handler, however the request spells the path -- checked before
            do_GET/do_HEAD fall through to it, and unconditionally: this is
            not an admin-only gate like the one above, since the whole
            point is that these are never meant to be reachable over HTTP
            at all, admin session or not.

            auth.js/auth.json: see _NEVER_SERVE_STATIC's comment.

            The data directory: paths.py normally keeps it outside the app
            folder, but falls back to "<app folder>/data" when the real
            per-machine location cannot be created. When that happens, the
            static handler would otherwise serve every account, register
            and cache file under it -- state.db, library.db, every blob in
            library/ -- to anyone who can reach this port, gating or no
            gating, since none of that ever goes through _require_session.

            The app is not necessarily served from "/" -- site.json can
            give it a friendly path prefix like "/supply-chain/command-
            centre", and translate_path() strips exactly that prefix
            before mapping the rest onto the filesystem. A check here
            against the *un*stripped path would never match "data" as the
            first segment once a prefix is configured, so this strips the
            same prefix translate_path does before asking the same
            question it will.
            """
            p = path_only
            if prefix != "/" and p.startswith(prefix):
                p = "/" + p[len(prefix):]
            asked = _normalized_path(p)
            name = asked.rsplit("/", 1)[-1]
            if name in _NEVER_SERVE_STATIC:
                return True
            return asked == "data" or asked.startswith("data/")

        def _session_token(self):
            cookie = self.headers.get("Cookie") or ""
            for part in cookie.split(";"):
                part = part.strip()
                if part.startswith(SESSION_COOKIE + "="):
                    return part[len(SESSION_COOKIE) + 1:]
            return None

        def _require_session(self):
            """True (and the caller may proceed) when either no sign-in is
            configured at all -- matches gate.js opening straight in for that
            case, rather than locking the owner out of a workspace that has
            never had a password set -- or a valid session cookie came with
            the request. Otherwise this answers 401 itself and returns False.

            This is the actual security boundary: the sign-in screen is only
            a door in front of it. Every /__data and /__library handler below
            is reached through do_GET/do_POST/do_DELETE, which all call this
            first, so none of them can be reached by skipping the browser and
            calling the API directly -- which is exactly how they were
            reachable before this existed, the server bound to 127.0.0.1 or
            not."""
            if not auth_configured():
                return True
            if session_login(self._session_token()):
                return True
            self._json(401, {"error": "sign in required"})
            return False

        def _require_admin(self):
            """Same shape as _require_session above, but for the handful of
            actions that change the shared source data everyone else's
            dashboards read from: uploading, renaming, or deleting a Data
            Library file. A signed-in regular account still reads that data
            fine (dashboards keep working for everyone) -- this only gates
            changing it. Not yet applied to downloading the raw file itself:
            today that is also how a dashboard loads library data to begin
            with, so locking it down here would break dashboards for every
            non-admin account; it becomes safe to add once dashboards read a
            precomputed result instead of the raw upload directly.

            Also true for any session -- admin or not -- holding a live
            admin-overlay grant (see grant_admin_overlay): the hidden
            search-bar unlock proves knowledge of the admin key, not that
            this particular account is the primary admin, so this
            deliberately does not check login == admin_login() for that
            case."""
            if not auth_configured():
                return True
            token = self._session_token()
            login = session_login(token)
            if login and login == admin_login():
                return True
            if login and admin_overlay_active(token):
                return True
            if not login:
                self._json(401, {"error": "sign in required"})
            else:
                self._json(403, {"error": "admin only"})
            return False

        def _is_admin(self):
            """Whether this request is an admin one, without answering it.

            _require_admin() above both decides and sends the refusal, which
            is right for a route that is simply admin-only. The checks below
            need the answer first so they can decide what to refuse and with
            which message."""
            if not auth_configured():
                return True
            token = self._session_token()
            login = session_login(token)
            if not login:
                return False
            return login == admin_login() or admin_overlay_active(token)

        def _admin_only_dashboards(self):
            """Ids and files of the dashboards currently marked admin-only.

            Read through appstore so an admin who hides a dashboard from the
            panel takes effect here immediately, rather than only in the
            shipped dashboards.json."""
            try:
                reg = appstore.read_dashboards_registry()
            except Exception:                             # noqa: BLE001
                return set(), set()
            ids, files = set(), set()
            for d in reg.get("dashboards", []):
                if d.get("adminOnly"):
                    ids.add(d.get("id"))
                    if d.get("file"):
                        files.add(str(d["file"]).replace("\\", "/").lstrip("./"))
            return ids, files

        def _restricted_datasets(self):
            """Datasets no non-admin dashboard reads.

            A register is only withheld when *every* dashboard that declares
            it is admin-only -- withholding one that a visible dashboard
            needs would just break that dashboard for everyone who is not an
            admin, which is exactly the trap _require_admin's docstring warns
            about. So this is deliberately narrow: hiding a dashboard hides
            its data too, but only data nothing else legitimately shows.
            """
            try:
                reg = appstore.read_dashboards_registry()
            except Exception:                             # noqa: BLE001
                return set()
            restricted, open_to_all = set(), set()
            for d in reg.get("dashboards", []):
                bucket = restricted if d.get("adminOnly") else open_to_all
                for i in (d.get("inputs") or []):
                    if i.get("dataset"):
                        bucket.add(_dataset_key(i["dataset"]))
            return restricted - open_to_all

        def _dataset_allowed(self, dataset):
            """True if this request may read `dataset`; sends the refusal and
            returns False if not.

            Compared on the same key datastore stores the register under, not
            on the text as typed. A dataset name reaches a table through
            slug(), and SQLite identifiers are case-insensitive, so
            "Formulary", "FORMULARY" and "formulary." all read the one table
            that "formulary" names -- matching raw strings let any of those
            spellings walk straight past this check."""
            if self._is_admin():
                return True
            if _dataset_key(dataset) in self._restricted_datasets():
                self._json(403, {"error": "admin only"})
                return False
            return True

        def _send_auth(self):
            """auth.json, read from the data folder -- with the password
            hashes themselves removed. Salt and iteration count are not
            secret (they are meaningless without the hash), and the browser
            needs them to derive its own digest before sign-in; the hash
            those get compared against now stays server-side, checked at
            POST /__session, exactly like the admin key already was. Serving
            it unauthenticated used to mean anyone who could reach this port
            could download every account's hash and brute-force it offline,
            with no rate limit at all -- worse than the sign-in form itself,
            which at least locks out after a few tries."""
            auth = read_auth()
            if not auth:
                # No accounts configured at all is a real state, not an
                # error: the gate treats a missing config as "no sign-in
                # configured".
                self.send_error(404)
                return
            safe = dict(auth)
            safe.pop("hash", None)
            safe.pop("adminKeyHash", None)
            if isinstance(safe.get("accounts"), list):
                totp_map = read_totp()
                # Whether 2FA is on is not secret the way the hash is --
                # the gate needs it before sign-in to decide whether to
                # show the password field at all or go straight to a code
                # (see POST /__session/totp/start).
                safe["accounts"] = [
                    dict(a, hash="", totpEnabled=bool((totp_map.get(a.get("login")) or {}).get("enabled")))
                    for a in safe["accounts"]
                ]
            self._json(200, safe)

        def do_HEAD(self):
            if self._redirect():
                return
            path_only = self.path.split("?")[0]
            if self._is_blocked_static_path(path_only):
                self.send_error(404)
                return
            # Same rule as do_GET, for the same reason: a HEAD carries no
            # body, but its status code and Content-Length alone tell a
            # non-admin whether a hidden dashboard exists and how large it
            # is -- an oracle this route must refuse exactly like GET does.
            if self._is_admin_only_file(path_only):
                self.send_error(404)
                return
            super().do_HEAD()

        def do_DELETE(self):
            if not self._require_admin():
                return
            path_only = self.path.split("?")[0]
            dtail = seg_route(path_only, "__data")
            if dtail:
                self._data_delete(dtail)
                return
            tail = library_route(path_only)
            if tail is None or len(tail) != 1:
                self.send_error(404)
                return
            self._library_delete(tail[0])

        def _library_dataset_of(self, rec):
            """The dataset id a library file was uploaded into, if it was
            uploaded into one, from the same 'ds:<id>' convention the Data
            Library page itself writes and reads (see its sectionScope()).
            None for a file with no such scope -- an ad-hoc upload nothing
            declares a canonical dataset for stays out of this check
            entirely, same as it always has."""
            did = str(rec.get("dashboardId") or "")
            if did[:3].lower() != "ds:":
                return None
            return urllib.parse.unquote(did[3:]).strip()

        def _library_get(self, tail):
            """A dataset-scoped upload is the same register /__data/<ds>
            reads, filed a second way -- gating one route and not the other
            would just move where a restricted register can still be read
            from, which is exactly what happened before this existed."""
            files = library_read_index()
            if not tail:
                if not self._is_admin():
                    restricted = self._restricted_datasets()
                    files = [f for f in files
                            if _dataset_key(self._library_dataset_of(f) or "") not in restricted]
                self._json(200, {"files": files})
                return
            if len(tail) != 1 or not SAFE_ID.match(tail[0]):
                self.send_error(404)
                return
            rec = next((f for f in files if f.get("id") == tail[0]), None)
            blob_path = os.path.join(LIBRARY_BLOBS, tail[0])
            if not rec or not os.path.exists(blob_path):
                self.send_error(404)
                return
            ds = self._library_dataset_of(rec)
            if ds and not self._dataset_allowed(ds):
                return
            size = os.path.getsize(blob_path)
            self.send_response(200)
            self.send_header("Content-Type", rec.get("type") or "application/octet-stream")
            self.send_header("Content-Length", str(size))
            self.end_headers()
            with open(blob_path, "rb") as fh:
                shutil.copyfileobj(fh, self.wfile, COPY_CHUNK)

        # ---- the month-on-month database ---------------------------------
        def _data_get(self, tail, qs):
            """GET __data            -> what is stored, by section and month
               GET __data/<ds>/columns -> that section's column names
               GET __data/<ds>/export  -> matching rows as CSV"""
            try:
                if not tail:
                    sets = store().datasets()
                    if not self._is_admin():
                        blocked = self._restricted_datasets()
                        # _restricted_datasets() holds normalised keys (see
                        # _dataset_key) precisely because two different
                        # spellings can name the same table; comparing a
                        # stored dataset's raw name against that set missed
                        # every restricted register whose name needed
                        # normalising to match its own key, and left it in a
                        # non-admin's listing -- rows still 403'd, but the
                        # listing named the register, its months and its row
                        # counts regardless.
                        sets = [d for d in sets if _dataset_key(d.get("dataset")) not in blocked]
                    self._json(200, {"datasets": sets})
                    return
                dataset = tail[0]
                if not self._dataset_allowed(dataset):
                    return
                what = tail[1] if len(tail) > 1 else ""
                if what == "columns":
                    self._json(200, {"columns": store().columns(dataset)})
                    return
                if what == "export":
                    periods = [p for p in (qs.get("periods") or [""])[0].split(",") if p]
                    filters = {}
                    for k, v in qs.items():
                        if k.startswith("f_") and v and v[0] != "":
                            filters[k[2:]] = v[0]
                    limit = int((qs.get("limit") or ["0"])[0]) or None
                    # headings=original gives the register's own column wording
                    # back instead of the SQL identifiers, and meta=0 leaves out
                    # this store's own _period/_source/_rowno/_part bookkeeping
                    # columns -- together, an export a dashboard can read with
                    # no translation step of its own. Both default to the old
                    # behaviour so existing callers are unaffected.
                    original = (qs.get("headings") or [""])[0] == "original"
                    include_meta = (qs.get("meta") or ["1"])[0] != "0"
                    name = "%s%s.csv" % (dataset, ("-" + "-".join(periods)) if periods else "")
                    self.send_response(200)
                    self.send_header("Content-Type", "text/csv; charset=utf-8")
                    self.send_header("Content-Disposition", 'attachment; filename="%s"' % name)
                    self.send_header("Transfer-Encoding", "chunked")
                    self.end_headers()
                    self._write_csv_chunked(dataset, periods, filters, limit,
                                            original_headers=original, include_meta=include_meta)
                    return
                self.send_error(404)
            except Exception as exc:                      # noqa: BLE001
                self._json(400, {"error": str(exc)})

        def _write_csv_chunked(self, dataset, periods, filters, limit,
                               original_headers=False, include_meta=True):
            """Streamed, because an export can be millions of rows and the
            row count is not known before the query runs."""
            import csv as _csv
            import io as _io
            buf = _io.StringIO()
            w = _csv.writer(buf)
            try:
                for row in store().rows(dataset, periods, filters, limit,
                                        original_headers=original_headers,
                                        include_meta=include_meta):
                    w.writerow(row)
                    if buf.tell() > 256 * 1024:
                        self._chunk(buf.getvalue().encode("utf-8"))
                        buf.seek(0), buf.truncate(0)
                if buf.tell():
                    self._chunk(buf.getvalue().encode("utf-8"))
            finally:
                try:
                    self.wfile.write(b"0\r\n\r\n")
                except OSError:
                    pass

        def _chunk(self, data):
            self.wfile.write(("%X\r\n" % len(data)).encode("ascii") + data + b"\r\n")

        def _data_import(self, qs):
            """Files a register into its section.

            Two ways in. Normally the file is already in the library and only
            its id is sent. A spreadsheet cannot be parsed here -- the reader
            for that lives in the browser, where SheetJS already is -- so for
            those the converted CSV arrives in the request body instead, and
            is streamed to a temp file rather than held in memory: these are
            tens of megabytes.
            """
            file_id = (qs.get("fileId") or [""])[0]
            dataset = (qs.get("dataset") or [""])[0]
            period = (qs.get("period") or [""])[0]
            # A register split across several files for one month names which
            # piece this is, so the others are not replaced by it.
            part = (qs.get("part") or [""])[0][:60]

            if file_id:
                if not SAFE_ID.match(file_id):
                    self._json(400, {"error": "bad file id"})
                    return
                blob = os.path.join(LIBRARY_BLOBS, file_id)
                if not os.path.exists(blob):
                    self._json(404, {"error": "that file is no longer in the library"})
                    return
                rec = next((f for f in library_read_index() if f.get("id") == file_id), None)
                source = (rec or {}).get("name") or file_id
                self._import_from(blob, dataset, period, source, part)
                return

            # Body upload: CSV converted from a spreadsheet by the browser.
            source = (qs.get("source") or ["spreadsheet"])[0][:200]
            try:
                n = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                n = 0
            if n <= 0:
                self._json(400, {"error": "no file id and no body to import"})
                return
            if n > MAX_UPLOAD_BYTES:
                self._json(413, {"error": "that file is larger than the %d MB limit"
                                          % (MAX_UPLOAD_BYTES // (1024 * 1024))})
                return
            tmp = os.path.join(LIBRARY_DIR, "import-%s.csv.part" % uuid.uuid4().hex)
            written = 0
            try:
                os.makedirs(LIBRARY_DIR, exist_ok=True)
                with open(tmp, "wb") as out:
                    left = n
                    while left > 0:
                        chunk = self.rfile.read(min(COPY_CHUNK, left))
                        if not chunk:
                            break
                        out.write(chunk)
                        written += len(chunk)
                        left -= len(chunk)
                if written != n:
                    # A short read means the upload was cut off. Importing it
                    # would quietly file half a month.
                    self._json(400, {"error": "upload was cut short (%d of %d bytes)" % (written, n)})
                    return
                self._import_from(tmp, dataset, period, source, part)
            finally:
                if os.path.exists(tmp):
                    try:
                        os.remove(tmp)
                    except OSError:
                        pass

        def _import_from(self, path, dataset, period, source, part=""):
            try:
                out = store().import_csv(path, dataset, period, source=source, part=part)
                print("  imported %s %s%s: %s rows from %s"
                      % (dataset, period, (" [" + part + "]") if part else "", out["rows"], source))
                self._json(200, out)
            except Exception as exc:                      # noqa: BLE001
                self._json(400, {"error": str(exc)})

        # ---- a dashboard's own cached view of one dataset -----------------
        CACHE_KINDS = ("rows", "default_view")

        def _cache_get(self, tail):
            """GET __cache/<dashboardId>/<dataset>/<kind> -> the cached
            payload, if appstore still considers it current for that
            dataset right now (see appstore.read_dashboard_cache). A miss --
            never cached, or the dataset has moved on since -- answers
            {"hit": false} rather than 404/204, so a dashboard's fetch
            handler has exactly one shape to branch on either way."""
            if len(tail) != 3:
                self.send_error(404)
                return
            dashboard_id, dataset, kind = tail
            if kind not in self.CACHE_KINDS or len(dashboard_id) > 100 or len(dataset) > 100:
                self.send_error(404)
                return
            # The cache holds the register's own rows, so reading it is
            # reading the register: same bar as /__data, or hiding a dataset
            # there would just move where it can be read from.
            if not self._dataset_allowed(dataset):
                return
            try:
                payload = appstore.read_dashboard_cache(dashboard_id, dataset, kind)
            except Exception as exc:                      # noqa: BLE001
                # A cache read must never be the reason a dashboard fails to
                # load -- worst case here is the same as a plain miss: the
                # caller reparses from scratch.
                print("  ! cache read failed: %s" % exc)
                payload = None
            if payload is None:
                self._json(200, {"hit": False})
                return
            self._json(200, {"hit": True, "payload": payload})

        def _cache_post(self, tail, body):
            """POST __cache/<dashboardId>/<dataset>/<kind> {"payload": ...}
            -> stores payload, stamped with a fingerprint this handler
            computes itself, right now, from datastore's own record of what
            is imported for that dataset -- never a version the caller
            sends (see appstore.py's dashboard_cache section for exactly
            why that ordering is what keeps a write always honest).

            Admin only, and that is a correctness rule rather than a privacy
            one. This cache is shared: whatever lands here is what every
            other account's dashboard draws, admins included, and nothing
            here can tell rows computed from the register apart from rows
            someone typed -- the fingerprint proves *when* a payload was
            written, never *what* it was derived from. Leaving the write open
            to any signed-in account meant any signed-in account could put
            invented figures in front of everyone. Reads stay open to anyone
            allowed the underlying dataset, so a cache warmed once still
            spares everybody the reparse."""
            if len(tail) != 3:
                self.send_error(404)
                return
            dashboard_id, dataset, kind = tail
            if kind not in self.CACHE_KINDS or len(dashboard_id) > 100 or len(dataset) > 100:
                self.send_error(404)
                return
            if not self._require_admin():
                return
            if not isinstance(body, dict) or "payload" not in body:
                self._json(400, {"error": "missing payload"})
                return
            try:
                version = appstore.dataset_fingerprint(dataset)
                appstore.write_dashboard_cache(dashboard_id, dataset, kind, version, body["payload"])
            except Exception as exc:                      # noqa: BLE001
                self._json(400, {"error": str(exc)})
                return
            self._json(200, {"ok": True, "sourceVersion": version})

        # ---- aggregate one dataset inside SQLite ---------------------------
        def _agg_post(self, tail, body):
            """POST __agg/<dataset> {measures, groupBy, periods, filters,
            dateCol, dateFrom, dateTo, orderBy, descending, limit}
            -> {"columns": [...], "rows": [[...]]}

            The whole point of this route is that the rows never leave the
            database: a month of 20,000 transfers answers as a few hundred
            bytes of totals, instead of a 20MB export the browser then has to
            parse and hold. datastore.aggregate() checks every column name
            against the table's real columns and binds every value, so a
            dashboard cannot reach past its own dataset from here.

            Read-only, and gated at the same bar as /__data: anything a
            caller could total up here it could already export in full."""
            if len(tail) != 1:
                self.send_error(404)
                return
            dataset = tail[0]
            if not self._dataset_allowed(dataset):
                return
            if not isinstance(body, dict):
                self._json(400, {"error": "bad request body"})
                return
            # Imported here rather than at module scope for the same reason
            # store() does it: this module stays importable (and the server
            # startable) even if the database layer is unavailable.
            import datastore
            try:
                out = store().aggregate(
                    dataset,
                    body.get("measures"),
                    group_by=body.get("groupBy"),
                    periods=body.get("periods"),
                    filters=body.get("filters"),
                    date_col=body.get("dateCol"),
                    date_from=body.get("dateFrom"),
                    date_to=body.get("dateTo"),
                    order_by=body.get("orderBy"),
                    descending=bool(body.get("descending", True)),
                    limit=body.get("limit"),
                )
            except datastore.DataStoreError as exc:
                self._json(400, {"error": str(exc)})
                return
            except Exception as exc:                      # noqa: BLE001
                print("  ! aggregate failed: %s" % exc)
                self._json(400, {"error": "could not aggregate that"})
                return
            self._json(200, out)

        def _data_delete(self, tail):
            try:
                dataset = tail[0]
                period = tail[1] if len(tail) > 1 else None
                part = tail[2] if len(tail) > 2 else None
                store().drop(dataset, period, part)
                self._json(200, {"ok": True})
            except Exception as exc:                      # noqa: BLE001
                self._json(400, {"error": str(exc)})

        def _library_delete(self, file_id):
            if not SAFE_ID.match(file_id):
                self.send_error(400)
                return
            with LIBRARY_LOCK:
                files = library_read_index()
                kept = [f for f in files if f.get("id") != file_id]
                if len(kept) != len(files):
                    library_write_index(kept)
            self._discard(os.path.join(LIBRARY_BLOBS, file_id))
            self._json(200, {"ok": True})

        def _library_put(self, file_id, qs):
            if not SAFE_ID.match(file_id):
                self._json(400, {"error": "bad id"})
                return
            try:
                n = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                n = 0
            if n < 0:
                self._json(400, {"error": "bad length"})
                return
            if n > MAX_UPLOAD_BYTES:
                self._json(413, {"error": "that file is larger than the %d MB limit"
                                          % (MAX_UPLOAD_BYTES // (1024 * 1024))})
                return

            os.makedirs(LIBRARY_BLOBS, exist_ok=True)
            blob_path = os.path.join(LIBRARY_BLOBS, file_id)
            # Written beside the real name and only moved into place once every
            # declared byte has arrived. A dropped connection half way through a
            # 300MB register must not leave a truncated file indexed as whole --
            # a dashboard would read it without complaint and quietly report
            # totals that are short by however much never arrived.
            #
            # The scratch name is unique per request, not just per id: a retried
            # upload of the same file (a reloaded migration, say) can be in
            # flight twice at once, and two writers sharing one scratch file
            # would interleave their bytes into something neither sent.
            part_path = "%s.%s.part" % (blob_path, uuid.uuid4().hex)
            written = 0
            try:
                with open(part_path, "wb") as out:
                    remaining = n
                    while remaining > 0:
                        chunk = self.rfile.read(min(COPY_CHUNK, remaining))
                        if not chunk:
                            break
                        out.write(chunk)
                        written += len(chunk)
                        remaining -= len(chunk)
            except OSError as exc:
                self._discard(part_path)
                self._json(500, {"error": str(exc)})
                return

            if written != n:
                self._discard(part_path)
                self._json(400, {"error": "upload truncated: got %d of %d bytes" % (written, n)})
                return

            headers_raw = (qs.get("headers") or [""])[0]
            try:
                headers = json.loads(headers_raw) if headers_raw else []
                if not isinstance(headers, list):
                    headers = []
            except ValueError:
                headers = []

            now = int(time.time() * 1000)
            rec = {
                "id": file_id,
                "dashboardId": (qs.get("dashboardId") or [""])[0][:100],
                "name": (qs.get("name") or ["untitled"])[0][:300],
                "size": written,
                "type": (qs.get("type") or [""])[0][:100],
                "addedAt": now,
                "updatedAt": now,
                "headers": headers[:200],
                "uploadedBy": session_login(self._session_token()) or "",
            }
            try:
                os.replace(part_path, blob_path)
            except OSError as exc:
                self._discard(part_path)
                self._json(500, {"error": str(exc)})
                return
            with LIBRARY_LOCK:
                files = [f for f in library_read_index() if f.get("id") != file_id]
                files.append(rec)
                library_write_index(files)
            self._json(200, rec)

        @staticmethod
        def _discard(path):
            try:
                os.remove(path)
            except OSError:
                pass

        def _library_rename(self, file_id, qs):
            name = (qs.get("name") or [""])[0].strip()[:300]
            if not name:
                self._json(400, {"error": "a name is required"})
                return
            with LIBRARY_LOCK:
                files = library_read_index()
                rec = next((f for f in files if f.get("id") == file_id), None)
                if not rec:
                    self._json(404, {"error": "no such file"})
                    return
                rec["name"] = name
                rec["updatedAt"] = int(time.time() * 1000)
                library_write_index(files)
            self._json(200, rec)

        def _session_login_post(self):
            """POST /__session {login, digest} -- the actual sign-in check.

            The browser already derived `digest` the same way it always has
            (PBKDF2 over the password, using the salt and iteration count
            auth.json handed it) to compare locally; now it hands that digest
            here instead, and this is the copy of the comparison that
            actually matters, because only a match here hands back a session
            cookie the rest of the API will accept. A wrong login or a login
            this server has never heard of (a sign-up that only ever made it
            into this browser's own storage, on a machine with nowhere to
            write) answers 404 rather than 401, so the browser knows to fall
            back to checking it locally instead of just failing outright."""
            try:
                n = int(self.headers.get("Content-Length") or 0)
                if n <= 0 or n > 4096:
                    raise ValueError("bad length")
                req = json.loads(self.rfile.read(n).decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                self._json(400, {"error": "bad request"})
                return

            login = clean_login(req.get("login"))
            digest = str(req.get("digest") or "")
            if not login or not digest:
                self._json(400, {"error": "bad request"})
                return

            rate_key = "login:" + login
            if rate_locked(rate_key):
                self._json(429, {"error": "too many attempts -- try again shortly"})
                return

            auth = read_auth()
            if not auth:
                self._json(404, {"error": "no such account"})
                return
            accounts = auth.get("accounts")
            if not accounts and auth.get("hash"):
                accounts = [{"login": auth.get("email", ""), "hash": auth.get("hash", "")}]
            acc = next((a for a in (accounts or []) if a.get("login") == login), None)
            if not acc:
                self._json(404, {"error": "no such account"})
                return
            if acc.get("disabled"):
                self._json(403, {"error": "this account has been disabled"})
                return

            if not hmac.compare_digest(digest, str(acc.get("hash") or "")):
                rate_fail(rate_key)
                log_history(login, "login_fail", self.client_address[0])
                self._json(401, {"error": "wrong password"})
                return
            rate_clear(rate_key)

            # Password is right -- if this account has 2FA on, that is not
            # enough on its own. Hand back a short-lived pending token tied
            # to this login (not the digest, which never leaves this
            # request) rather than starting the session yet; POST
            # /__session/totp below finishes the job once the code checks
            # out. This intentionally runs before the single-session
            # conflict check: proving identity fully comes first, then the
            # takeover decision.
            totp_entry = read_totp().get(login) or {}
            if totp_entry.get("enabled"):
                token = new_totp_pending(login)
                self._json(401, {"error": "2FA code required", "totpRequired": True, "totpToken": token})
                return

            # One account, one active session -- see the CONFLICTS block
            # above. The password is already proven correct at this point,
            # so a conflict token issued from here can be trusted as "this
            # caller genuinely knows this account's password", without
            # asking for it again on the resolve step below.
            if sessions_for(login):
                token = new_conflict(login)
                self._json(409, {"error": "already signed in elsewhere", "conflictToken": token})
                return

            self._start_session(login)

        def _session_totp_start_post(self):
            """POST /__session/totp/start {login} -- begins sign-in for an
            account with 2FA on WITHOUT a password: the whole point of this
            route is that owning the authenticator app is treated as
            sufficient on its own to start a sign-in, the same way knowing
            the password is for an account without 2FA. It proves nothing
            by itself -- the pending token this hands back leads nowhere
            until the correct code follows at POST /__session/totp, same
            as the password-first path above. Rate-limited the same way a
            password attempt is (per login, not per code) so this cannot
            be used to spam pending tokens or as a cheap way to discover
            which accounts exist beyond what the sign-in screen already
            reveals at the username step."""
            try:
                n = int(self.headers.get("Content-Length") or 0)
                if n <= 0 or n > 1024:
                    raise ValueError("bad length")
                req = json.loads(self.rfile.read(n).decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                self._json(400, {"error": "bad request"})
                return

            login = clean_login(req.get("login"))
            if not login:
                self._json(400, {"error": "bad request"})
                return

            rate_key = "login:" + login
            if rate_locked(rate_key):
                self._json(429, {"error": "too many attempts -- try again shortly"})
                return

            auth = read_auth()
            if not auth:
                self._json(404, {"error": "no such account"})
                return
            accounts = auth.get("accounts") or []
            acc = next((a for a in accounts if a.get("login") == login), None)
            if not acc:
                self._json(404, {"error": "no such account"})
                return
            if acc.get("disabled"):
                self._json(403, {"error": "this account has been disabled"})
                return

            totp_entry = read_totp().get(login) or {}
            if not totp_entry.get("enabled"):
                # Not actually a 2FA account -- the client should not have
                # offered this path, but fall back cleanly rather than
                # dead-ending the sign-in if it did (2FA toggled off
                # between page load and now, a stale mirror, etc).
                self._json(400, {"error": "this account signs in with a password"})
                return

            token = new_totp_pending(login)
            self._json(200, {"totpToken": token})

        def _session_totp_post(self):
            """POST /__session/totp {totpToken, code} -- the second step of
            signing in to an account with 2FA on. code may be a live TOTP
            code or a one-time backup code; either finishes the sign-in the
            same way (session cookie, conflict check) as a plain password
            match would have."""
            try:
                n = int(self.headers.get("Content-Length") or 0)
                if n <= 0 or n > 2048:
                    raise ValueError("bad length")
                req = json.loads(self.rfile.read(n).decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                self._json(400, {"error": "bad request"})
                return

            pending_token = str(req.get("totpToken") or "")
            login = totp_pending_login(pending_token)
            if not login:
                self._json(404, {"error": "that sign-in attempt has expired -- start again"})
                return

            # Only 10^6 possible codes -- this is the one place in the app
            # where a tight, code-specific rate limit matters more than the
            # ordinary per-login one above.
            rate_key = "totp:" + login
            if rate_locked(rate_key):
                self._json(429, {"error": "too many attempts -- try again shortly"})
                return

            code = req.get("code")
            with TOTP_LOCK:
                totp = read_totp()
                entry = totp.get(login) or {}
                if not entry.get("enabled"):
                    # 2FA got turned off between the password step and now --
                    # treat it as already satisfied rather than erroring.
                    ok = True
                elif totp_verify(entry.get("secret", ""), code):
                    ok = True
                elif totp_consume_backup_code(entry, code):
                    ok = True
                    totp[login] = entry
                    write_totp(totp)
                else:
                    ok = False

            if not ok:
                rate_fail(rate_key)
                self._json(401, {"error": "wrong code -- check the time on your phone and try again"})
                return
            rate_clear(rate_key)
            drop_totp_pending(pending_token)

            if sessions_for(login):
                token = new_conflict(login)
                self._json(409, {"error": "already signed in elsewhere", "conflictToken": token})
                return
            self._start_session(login)

        def _start_session(self, login):
            log_history(login, "login_ok", self.client_address[0])
            token = new_session(login)
            secure = (self.headers.get("X-Forwarded-Proto", "") == "https")
            cookie = "%s=%s; Path=/; HttpOnly; SameSite=Lax; Max-Age=%d" % (
                SESSION_COOKIE, token, SESSION_TTL)
            if secure:
                cookie += "; Secure"
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            body = json.dumps({"ok": True}).encode("utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Set-Cookie", cookie)
            self.end_headers()
            self.wfile.write(body)

        def _session_admin_unlock_post(self):
            """POST /__session/admin-unlock {digest} -- the hidden trigger
            behind the search bar's admin-key gesture. Works for ANY signed-in
            session, not just the primary admin's own -- a correct digest
            proves whoever is typing knows the shared admin key, which is
            exactly the "walk up to any already-open session and reveal
            admin controls" behaviour that was asked for. `digest` is a
            PBKDF2 digest the browser derived the same way it already does
            for a password (over adminKeySalt/iterations from auth.js);
            comparing it here, never client-side, is the same reasoning as
            the main sign-in check above -- the real adminKeyHash never
            leaves the server (see _send_auth's redaction)."""
            if not self._require_session():
                return
            token = self._session_token()
            login = session_login(token)

            rate_key = "adminunlock:" + (login or self.client_address[0])
            if rate_locked(rate_key):
                self._json(429, {"error": "too many attempts -- try again shortly"})
                return

            try:
                n = int(self.headers.get("Content-Length") or 0)
                if n <= 0 or n > 2048:
                    raise ValueError("bad length")
                req = json.loads(self.rfile.read(n).decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                self._json(400, {"error": "bad request"})
                return

            digest = str(req.get("digest") or "")
            auth = read_auth()
            key_hash = str(auth.get("adminKeyHash") or "")

            if not key_hash or not digest or not hmac.compare_digest(digest, key_hash):
                rate_fail(rate_key)
                self._json(401, {"ok": False})
                return
            rate_clear(rate_key)
            grant_admin_overlay(token)
            self._json(200, {"ok": True})

        def _session_admin_unlock_revoke_post(self):
            """POST /__session/admin-unlock/revoke -- the overlay's close
            button calls this before tearing itself down client-side, so
            "nothing stays until I type the key again" is actually true
            server-side too, not just a hidden div. Always succeeds (even
            if nothing was granted) -- closing an overlay that never
            finished opening is not an error."""
            if not self._require_session():
                return
            revoke_admin_overlay(self._session_token())
            self._json(200, {"ok": True})

        def _session_resolve_post(self):
            """POST /__session/resolve {conflictToken, force} -- the second
            step after a 409 from /__session above. force:true kills the
            other session and takes over immediately; force:false (or
            omitted) only completes the sign-in once the other session has
            ended on its own, otherwise it reports back that it's still
            active so the caller can poll again shortly."""
            try:
                n = int(self.headers.get("Content-Length") or 0)
                if n <= 0 or n > 4096:
                    raise ValueError("bad length")
                req = json.loads(self.rfile.read(n).decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                self._json(400, {"error": "bad request"})
                return

            token = str(req.get("conflictToken") or "")
            login = conflict_login(token)
            if not login:
                self._json(410, {"error": "that sign-in attempt has expired -- start again"})
                return

            if req.get("force"):
                drop_sessions_for(login)
                log_history(login, "force_logout")
            elif sessions_for(login):
                self._json(200, {"ok": False, "stillActive": True})
                return

            drop_conflict(token)
            self._start_session(login)

        def _session_viewing_post(self):
            """POST /__session/viewing {dashboardId} -- self-reported by the
            hub on every navigation (see app.js), so the admin panel's live
            sessions list can show what each person actually has open right
            now. Any signed-in session may report its own view; there is
            nothing here to gate beyond just having a valid session, since
            this never affects what anyone can read or change."""
            if not self._require_session():
                return
            try:
                n = int(self.headers.get("Content-Length") or 0)
                req = json.loads(self.rfile.read(n).decode("utf-8")) if n else {}
            except (ValueError, UnicodeDecodeError):
                req = {}
            viewing = req.get("dashboardId")
            viewing = str(viewing) if viewing else None
            set_viewing(self._session_token(), viewing)
            log_view(session_login(self._session_token()), viewing)
            self._json(200, {"ok": True})

        def _totp_post(self, tail):
            """POST /__totp/setup | confirm | disable | regenerate-codes --
            self-service 2FA management for the signed-in account. Already
            passed _require_session() by the caller; nothing here is
            admin-only, since every account manages its own 2FA the same
            way (see _admin_account_action for the admin's rescue path when
            someone locks themselves out)."""
            login = session_login(self._session_token())
            try:
                n = int(self.headers.get("Content-Length") or 0)
                if n > 2048:
                    raise ValueError("bad length")
                body = json.loads(self.rfile.read(n).decode("utf-8")) if n else {}
            except (ValueError, UnicodeDecodeError):
                body = {}

            # disable/regenerate-codes both guess against an *existing*
            # secret -- the same brute-force risk (and the same "totp:"
            # bucket) as the sign-in step, worth guarding even though this
            # route needs a valid session first: a hijacked session cookie
            # alone should not be enough to grind through codes.
            if tail in (["disable"], ["regenerate-codes"]):
                rate_key = "totp:" + login
                if rate_locked(rate_key):
                    self._json(429, {"error": "too many attempts -- try again shortly"})
                    return

            with TOTP_LOCK:
                totp = read_totp()
                entry = totp.get(login) or {}

                if tail == ["setup"]:
                    if entry.get("enabled"):
                        self._json(409, {"error": "2FA is already on for this account"})
                        return
                    secret = totp_new_secret()
                    entry["pendingSecret"] = secret
                    totp[login] = entry
                    write_totp(totp)
                    label = urllib.parse.quote(TOTP_ISSUER + ":" + login)
                    otpauth = ("otpauth://totp/%s?secret=%s&issuer=%s&digits=6&period=30"
                               % (label, secret, urllib.parse.quote(TOTP_ISSUER)))
                    self._json(200, {"secret": secret, "otpauthUrl": otpauth})
                    return

                if tail == ["confirm"]:
                    pending = entry.get("pendingSecret")
                    if not pending:
                        self._json(400, {"error": "start setup again"})
                        return
                    if not totp_verify(pending, body.get("code")):
                        self._json(401, {"error": "wrong code -- check the time on your phone and try again"})
                        return
                    codes, hashes = totp_new_backup_codes()
                    entry["secret"] = pending
                    entry["enabled"] = True
                    entry.pop("pendingSecret", None)
                    entry["backupCodes"] = hashes
                    totp[login] = entry
                    write_totp(totp)
                    log_history(login, "totp_enabled", self.client_address[0])
                    self._json(200, {"ok": True, "backupCodes": codes})
                    return

                if tail == ["disable"]:
                    if not entry.get("enabled"):
                        self._json(200, {"ok": True})
                        return
                    if not (totp_verify(entry.get("secret", ""), body.get("code"))
                            or totp_consume_backup_code(entry, body.get("code"))):
                        rate_fail("totp:" + login)
                        self._json(401, {"error": "wrong code"})
                        return
                    rate_clear("totp:" + login)
                    totp.pop(login, None)
                    write_totp(totp)
                    log_history(login, "totp_disabled", self.client_address[0])
                    self._json(200, {"ok": True})
                    return

                if tail == ["regenerate-codes"]:
                    if not entry.get("enabled"):
                        self._json(400, {"error": "2FA is not on for this account"})
                        return
                    if not (totp_verify(entry.get("secret", ""), body.get("code"))
                            or totp_consume_backup_code(entry, body.get("code"))):
                        rate_fail("totp:" + login)
                        self._json(401, {"error": "wrong code"})
                        return
                    rate_clear("totp:" + login)
                    codes, hashes = totp_new_backup_codes()
                    entry["backupCodes"] = hashes
                    totp[login] = entry
                    write_totp(totp)
                    self._json(200, {"ok": True, "backupCodes": codes})
                    return

            self.send_error(404)

        # -------------------------------------------------------------
        # Admin panel. Every route here already passed _require_admin()
        # in do_GET/do_POST above -- nothing below re-checks that.
        # -------------------------------------------------------------
        def _admin_get(self, tail, qs):
            if tail == ["sessions"]:
                self._json(200, {"sessions": active_sessions()})
                return
            if tail == ["history"]:
                try:
                    limit = min(int((qs.get("limit") or ["200"])[0]), 5000)
                except ValueError:
                    limit = 200
                login = (qs.get("login") or [""])[0]
                rows = read_history(limit if not login else 5000)
                if login:
                    rows = [r for r in rows if r.get("login") == login][:limit]
                self._json(200, {"history": rows})
                return
            if tail == ["usage"]:
                self._json(200, {"usage": usage_report()})
                return
            if tail == ["accounts"]:
                self._json(200, {"accounts": self._admin_account_list()})
                return
            if tail == ["storage"]:
                files = library_read_index()
                self._json(200, {"files": files, "totalBytes": sum(f.get("size", 0) for f in files)})
                return
            if tail == ["requests"]:
                self._json(200, {"requests": read_requests()})
                return
            if tail == ["feedback"]:
                self._json(200, {"items": read_feedback()})
                return
            if tail == ["backups"]:
                self._json(200, {"backups": list_backups(), "dir": BACKUPS_DIR})
                return
            if tail == ["ask", "status"]:
                self._json(200, {"enabled": llm.llm_enabled(), "models": list(assistant.ALLOWED_MODELS)})
                return
            if tail == ["ask", "usage"]:
                self._json(200, ask_usage_report())
                return
            if len(tail) == 2 and tail[0] == "backups":
                self._admin_backup_download(tail[1])
                return
            if tail == ["dashboards"]:
                reg = appstore.read_dashboards_registry()
                out = [{"id": d.get("id"), "name": d.get("name"), "status": d.get("status"),
                        "adminOnly": bool(d.get("adminOnly"))}
                       for d in reg.get("dashboards", []) if d.get("id")]
                self._json(200, {"dashboards": out})
                return
            self.send_error(404)

        def _admin_account_list(self):
            auth = read_auth()
            if not auth:
                return []
            accounts = auth.get("accounts") or []
            primary = admin_login()
            stats = history_stats()
            totp = read_totp()
            out = []
            for a in accounts:
                s = stats.get(a.get("login"), {"totalMs": 0, "sessions": 0})
                out.append({
                    "login": a.get("login"), "name": a.get("name") or "",
                    "designation": a.get("designation") or "", "department": a.get("department") or "",
                    "category": a.get("category") or "", "phone": a.get("phone") or "",
                    "email": a.get("email") or "", "parasId": a.get("parasId") or "",
                    "createdAt": a.get("createdAt"), "disabled": bool(a.get("disabled")),
                    "isAdmin": a.get("login") == primary,
                    "totalTimeMs": s["totalMs"], "sessionCount": s["sessions"],
                    "totpEnabled": bool((totp.get(a.get("login")) or {}).get("enabled")),
                })
            return out

        def _require_step_up(self, body):
            """Gate for the handful of admin actions that write to the
            accounts file itself (auth.json/totp.json) -- reset/rename/
            disable/delete/update-profile/disable-2fa, and approving a
            pending request. Already inside _require_admin (this is only
            ever reached by the signed-in admin), so this is not "prove
            who you are" again -- it is "an unattended, unlocked admin
            session should not be enough on its own to change someone's
            credentials", which the standing session cookie alone cannot
            rule out. Only bites when the admin's own account has 2FA on;
            an admin without 2FA has only the one factor to begin with, and
            the session already covers it -- nothing more to ask for."""
            login = session_login(self._session_token())
            totp_entry = read_totp().get(login) or {}
            if not totp_entry.get("enabled"):
                return True

            rate_key = "stepup:" + login
            if rate_locked(rate_key):
                self._json(429, {"error": "too many attempts -- try again shortly"})
                return False

            auth = read_auth()
            acc = next((a for a in (auth.get("accounts") or []) if a.get("login") == login), None)

            digest = str(body.get("stepUpDigest") or "")
            code = str(body.get("stepUpCode") or "")
            pass_ok = bool(acc) and bool(digest) and hmac.compare_digest(digest, str(acc.get("hash") or ""))
            code_ok = pass_ok and totp_verify(totp_entry.get("secret", ""), code)
            if pass_ok and code_ok:
                rate_clear(rate_key)
                return True

            rate_fail(rate_key)
            self._json(401, {"error": "step-up verification required", "stepUpRequired": True,
                              "reason": "password" if not pass_ok else "code"})
            return False

        def _admin_post(self, tail, body):
            if tail == ["sessions", "logout"]:
                login = str(body.get("login") or "")
                if not login:
                    self._json(400, {"error": "bad request"})
                    return
                n = drop_sessions_for(login)
                if n:
                    log_history(login, "force_logout")
                self._json(200, {"ok": True, "ended": n})
                return
            if len(tail) == 3 and tail[0] == "accounts" and tail[2] in ("reset-password", "rename", "disable", "delete", "update-profile"):
                if not self._require_step_up(body):
                    return
                self._admin_account_action(tail[1], tail[2], body)
                return
            if len(tail) == 3 and tail[0] == "accounts" and tail[2] == "disable-2fa":
                if not self._require_step_up(body):
                    return
                with TOTP_LOCK:
                    totp = read_totp()
                    had_it = bool((totp.get(tail[1]) or {}).get("enabled"))
                    totp.pop(tail[1], None)
                    write_totp(totp)
                if had_it:
                    log_history(tail[1], "totp_disabled", self.client_address[0])
                self._json(200, {"ok": True})
                return
            if len(tail) == 3 and tail[0] == "dashboards" and tail[2] == "visibility":
                self._admin_dashboard_visibility(tail[1], body)
                return
            if len(tail) == 3 and tail[0] == "requests" and tail[2] == "resolve":
                self._admin_requests_resolve(tail[1], body)
                return
            if len(tail) == 3 and tail[0] == "feedback" and tail[2] == "resolve":
                self._admin_feedback_resolve(tail[1], body)
                return
            if tail == ["backups"]:
                name = make_backup()
                if name:
                    self._json(200, {"ok": True, "name": name})
                else:
                    self._json(500, {"error": "backup failed -- see the server console"})
                return
            if tail == ["broadcast"]:
                self._admin_broadcast_post(body)
                return
            if tail == ["ask"]:
                self._admin_ask_post(body)
                return
            self.send_error(404)

        def _admin_ask_post(self, body):
            """POST /__admin/ask {question} -- the admin-only data assistant.
            Rate-limited per admin login, same shape as every other
            sensitive action here: each question is a real, billed call to
            Anthropic's API (see llm.py), so a stuck retry loop in the
            browser or a double-click should not be able to fire it
            unboundedly."""
            login = session_login(self._session_token())
            rate_key = "ask:" + (login or "")
            if rate_locked(rate_key):
                self._json(429, {"error": "too many questions -- try again shortly"})
                return
            question = str(body.get("question") or "")[:2000]
            model = body.get("model") if isinstance(body.get("model"), str) else None
            answer, err, usage = assistant.ask(question, library_read_index(), LIBRARY_BLOBS, model=model)
            if usage.get("inputTokens") or usage.get("outputTokens"):
                log_ask_usage(usage.get("model"), usage.get("inputTokens", 0), usage.get("outputTokens", 0))
            if err:
                rate_fail(rate_key)
                self._json(200, {"ok": False, "error": err, "usage": usage})
                return
            rate_clear(rate_key)
            self._json(200, {"ok": True, "answer": answer, "usage": usage})

        def _admin_broadcast_post(self, body):
            """POST /__admin/broadcast {subject, message, logins} -- emails
            every account that has an address on file (or just the ones
            named in `logins`, if given), and waits for every send to
            actually finish before answering, so the admin panel can show
            what really happened (sent to N, failed for these M) rather
            than just "queued" -- unlike notify_admin_of_request (fired for
            every sign-up regardless of anyone watching), this is a single
            deliberate button press an admin is looking at, so it is worth
            the wait to report the real outcome instead of a guess."""
            if not mail.mail_enabled():
                self._json(503, {"error": "email is not set up on this server -- run set_mail.py first"})
                return
            subject = str(body.get("subject") or "").strip()[:200]
            message = str(body.get("message") or "").strip()[:5000]
            if not subject or not message:
                self._json(400, {"error": "a subject and a message are required"})
                return
            logins = body.get("logins")
            wanted = set(logins) if isinstance(logins, list) and logins else None

            accounts = read_auth().get("accounts") or []
            recipients = [a.get("email") for a in accounts
                          if a.get("email") and (wanted is None or a.get("login") in wanted)]
            if not recipients:
                self._json(400, {"error": "none of the selected accounts have an email address on file"})
                return

            failed = [addr for addr in recipients if not mail.send_mail(addr, subject, message)]
            self._json(200, {"ok": True, "sent": len(recipients) - len(failed), "failed": failed})

        def _admin_backup_download(self, name):
            # name is only ever compared against our own generated pattern --
            # never trusted as a path, so a caller cannot walk this outside
            # BACKUPS_DIR no matter what it sends.
            if not BACKUP_NAME_RE.match(name):
                self.send_error(404)
                return
            full = os.path.join(BACKUPS_DIR, name)
            if not os.path.isfile(full):
                self.send_error(404)
                return
            try:
                with open(full, "rb") as fh:
                    data = fh.read()
            except OSError:
                self.send_error(500)
                return
            self.send_response(200)
            self.send_header("Content-Type", "application/zip")
            self.send_header("Content-Disposition", 'attachment; filename="%s"' % name)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _admin_feedback_resolve(self, item_id, body):
            """POST /__admin/feedback/<id>/resolve {done, remark} -- unlike
            the account-request queue there is nothing to apply here beyond
            the status itself: this is a suggestion/issue note, not a
            mutation to auth.json, so marking it done (or reopening it) and
            optionally leaving a remark is the whole action."""
            with FEEDBACK_LOCK:
                items = read_feedback()
                entry = next((f for f in items if f.get("id") == item_id), None)
                if entry is None:
                    self._json(404, {"error": "no such item"})
                    return
                entry["status"] = "done" if body.get("done") else "open"
                entry["remark"] = str(body.get("remark") or "")[:500]
                entry["resolvedAt"] = int(time.time() * 1000) if entry["status"] == "done" else None
                write_feedback(items)
            self._json(200, {"ok": True})

        def _admin_requests_resolve(self, request_id, body):
            """POST /__admin/requests/<id>/resolve {action, remark} -- the
            only place a pending signup/password-reset/id-change request
            actually applies to auth.json. action "approve" applies the
            change (creating the account, updating the password hash, or
            renaming the login) exactly as the old admin-key-gated /__auth
            used to, just gated on an admin session now instead of a shared
            secret; "reject" only records the remark, no account changes."""
            action = body.get("action")
            if action not in ("approve", "reject"):
                self._json(400, {"error": "bad request"})
                return

            with REQUESTS_LOCK:
                requests_ = read_requests()
                entry = next((r for r in requests_ if r.get("id") == request_id), None)
                if entry is None:
                    self._json(404, {"error": "no such request"})
                    return
                if entry.get("status") != "pending":
                    self._json(409, {"error": "already resolved"})
                    return

                if action == "reject":
                    entry["status"] = "rejected"
                    entry["resolvedAt"] = int(time.time() * 1000)
                    entry["remark"] = str(body.get("remark") or "")[:500]
                    write_requests(requests_)
                    self._json(200, {"ok": True})
                    return

            # "approve" is the one path here that writes to auth.json (see
            # the docstring above) -- step-up gated the same as every other
            # change to the accounts file, outside the REQUESTS_LOCK since
            # it only ever reads auth.json/totp.json, never requests.json.
            if not self._require_step_up(body):
                return

            with REQUESTS_LOCK:
                requests_ = read_requests()
                entry = next((r for r in requests_ if r.get("id") == request_id), None)
                if entry is None or entry.get("status") != "pending":
                    self._json(409, {"error": "already resolved"})
                    return

                auth = read_auth()
                if not auth:
                    self._json(500, {"error": "no accounts configured"})
                    return
                accounts = auth.get("accounts") or []
                payload = entry.get("payload") or {}
                login = entry.get("login")

                if entry["type"] == "signup":
                    if any(a.get("login") == login for a in accounts):
                        self._json(409, {"error": "that username was taken in the meantime"})
                        return
                    new_acc = {"login": login, "salt": payload.get("salt"), "hash": payload.get("hash"),
                              "iterations": payload.get("iterations", 250000),
                              "createdAt": int(time.time() * 1000)}
                    new_acc.update(payload.get("profile") or {})
                    accounts.append(new_acc)
                    logmsg = "Signup approved: %s" % login
                elif entry["type"] == "password_reset":
                    idx = next((i for i, a in enumerate(accounts) if a.get("login") == login), None)
                    if idx is None:
                        self._json(404, {"error": "that account no longer exists"})
                        return
                    accounts[idx]["salt"] = payload.get("salt")
                    accounts[idx]["hash"] = payload.get("hash")
                    accounts[idx]["iterations"] = payload.get("iterations", 250000)
                    log_history(login, "password_reset_by_admin")
                    logmsg = "Password-reset approved: %s" % login
                else:  # id_change
                    idx = next((i for i, a in enumerate(accounts) if a.get("login") == login), None)
                    new_login = payload.get("newLogin")
                    if idx is None:
                        self._json(404, {"error": "that account no longer exists"})
                        return
                    if any(a.get("login") == new_login for a in accounts):
                        self._json(409, {"error": "that sign-in name was taken in the meantime"})
                        return
                    accounts[idx]["login"] = new_login
                    if auth.get("email") == login:
                        auth["email"] = new_login
                    drop_sessions_for(login)
                    log_history(login, "force_logout")
                    logmsg = "ID change approved: %s -> %s" % (login, new_login)

                auth["accounts"] = accounts
                if accounts and auth.get("email") == accounts[0].get("login"):
                    auth["salt"], auth["hash"], auth["iterations"] = (
                        accounts[0]["salt"], accounts[0]["hash"], accounts[0]["iterations"])
                try:
                    write_auth(auth)
                    import sync
                    sync.mirror_auth()
                except (sqlite3.Error, ImportError) as exc:
                    self._json(500, {"error": str(exc)})
                    return

                entry["status"] = "approved"
                entry["resolvedAt"] = int(time.time() * 1000)
                entry["remark"] = str(body.get("remark") or "")[:500]
                write_requests(requests_)
            print("  " + logmsg)
            self._json(200, {"ok": True})

        def _admin_dashboard_visibility(self, dashboard_id, body):
            """POST /__admin/dashboards/<id>/visibility {adminOnly} -- the
            choice itself lives in appstore's dashboard_overrides table (see
            its docstring), not in dashboards.json, so it survives the next
            time a new build gets unzipped over this one."""
            try:
                with open(DASHBOARDS_JSON, encoding="utf-8") as fh:
                    reg = json.load(fh)
            except (OSError, ValueError) as exc:
                self._json(500, {"error": str(exc)})
                return
            if not any(d.get("id") == dashboard_id for d in reg.get("dashboards") or []):
                self._json(404, {"error": "no such dashboard"})
                return
            try:
                appstore.set_dashboard_admin_only(dashboard_id, bool(body.get("adminOnly")))
                # Regenerates dashboards.js (the file:// mirror every dashboard
                # page's own bridge/session-guard/idle-timeout blocks also come
                # from) so the change is picked up immediately, not just on the
                # next server restart.
                sys.path.insert(0, ROOT)
                import sync
                sync.main()
            except (sqlite3.Error, ImportError) as exc:
                self._json(500, {"error": str(exc)})
                return
            self._json(200, {"ok": True})

        def _admin_account_action(self, login, action, body):
            auth = read_auth()
            if not auth:
                self._json(404, {"error": "no accounts configured"})
                return
            accounts = auth.get("accounts") or []
            idx = next((i for i, a in enumerate(accounts) if a.get("login") == login), None)
            if idx is None:
                self._json(404, {"error": "no such account"})
                return

            if action == "reset-password":
                new_password = str(body.get("newPassword") or "")
                problem = password_policy_problem(new_password, login)
                if problem:
                    self._json(400, {"error": problem})
                    return
                salt = secrets.token_hex(16)
                iters = accounts[idx].get("iterations") or 250000
                accounts[idx]["salt"] = salt
                accounts[idx]["hash"] = hashlib.pbkdf2_hmac(
                    "sha256", new_password.encode("utf-8"), bytes.fromhex(salt), iters, 32).hex()
                accounts[idx]["iterations"] = iters
                log_history(login, "password_reset_by_admin")

            elif action == "rename":
                new_login = clean_login(body.get("newLogin"))
                if not new_login:
                    self._json(400, {"error": "a new sign-in name is required"})
                    return
                if any(a.get("login") == new_login for a in accounts):
                    self._json(409, {"error": "that sign-in name is already taken"})
                    return
                old_login = accounts[idx]["login"]
                accounts[idx]["login"] = new_login
                if auth.get("email") == old_login:
                    auth["email"] = new_login
                # A renamed login's 2FA secret used to stay keyed under the
                # old (now nonexistent) name, silently orphaning it -- carry
                # it across in the same step instead.
                with TOTP_LOCK:
                    totp = read_totp()
                    if old_login in totp:
                        totp[new_login] = totp.pop(old_login)
                        write_totp(totp)
                drop_sessions_for(old_login)
                log_history(old_login, "force_logout")

            elif action == "disable":
                disabled = bool(body.get("disabled", True))
                accounts[idx]["disabled"] = disabled
                if disabled:
                    n = drop_sessions_for(login)
                    if n:
                        log_history(login, "force_logout")

            elif action == "delete":
                # Permanent, unlike "disable" -- the account and its 2FA
                # secret are gone, not just locked out. Two guards: never
                # leave zero accounts behind (that's an unrecoverable
                # install, not just a mistake), and never let the admin
                # delete the very session doing the deleting -- everything
                # from this point in the request would still be running as
                # a login that no longer exists.
                if len(accounts) <= 1:
                    self._json(400, {"error": "can't delete the only remaining account"})
                    return
                if login == session_login(self._session_token()):
                    self._json(400, {"error": "can't delete the account you're currently signed in as"})
                    return
                accounts.pop(idx)
                n = drop_sessions_for(login)
                if n:
                    log_history(login, "force_logout")
                with TOTP_LOCK:
                    totp = read_totp()
                    if totp.pop(login, None) is not None:
                        write_totp(totp)
                # Same re-sync set_password.py's own --remove does unconditionally:
                # the top-level auth fields always mirror whichever account is
                # accounts[0] now, since that is what file:// mode's fallback reads.
                auth["email"] = accounts[0]["login"]
                auth["salt"], auth["hash"], auth["iterations"] = (
                    accounts[0]["salt"], accounts[0]["hash"], accounts[0].get("iterations", 250000))

            elif action == "update-profile":
                # Free-text profile fields an admin can correct on someone's
                # behalf (a typo at signup, a promotion, a transfer) -- unlike
                # the sign-up form itself these are not constrained to a fixed
                # dropdown list, since the admin is trusted to enter something
                # sensible and a hard-coded option list here would just be one
                # more place to keep in sync with index.html's. The employee
                # ID is the one exception: it is a structured identifier, not
                # free text, so the same format signup enforces applies here.
                if "parasId" in body:
                    paras_id = str(body.get("parasId") or "").strip().upper()
                    if paras_id and not PARAS_ID_RE.match(paras_id):
                        self._json(400, {"error": "employee ID must look like AA-BBB-12345"})
                        return
                    body = dict(body, parasId=paras_id)
                for field in ("name", "designation", "department", "category", "phone", "email", "parasId"):
                    if field in body:
                        accounts[idx][field] = str(body.get(field) or "").strip()[:200]

            auth["accounts"] = accounts
            if accounts and auth.get("email") == accounts[0].get("login"):
                auth["salt"], auth["hash"], auth["iterations"] = (
                    accounts[0]["salt"], accounts[0]["hash"], accounts[0]["iterations"])
            try:
                write_auth(auth)
                import sync
                sync.mirror_auth()
            except (sqlite3.Error, ImportError) as exc:
                self._json(500, {"error": str(exc)})
                return
            self._json(200, {"ok": True})

        def do_POST(self):
            """Handles writes from the browser: files dropped into the Data
            Library (this machine's copy, under data/library/), a session
            being established or ended, and password-reset / sign-up /
            id-change requests from the sign-in screen -- queued for admin
            approval (see _request_post), not applied here."""
            path_only = self.path.split("?")[0]
            qs = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)

            # __data and __library routes are matched on a whole path segment
            # (seg_route/library_route), same as every GET/DELETE above, and
            # checked first -- so a library file whose id happens to be the
            # literal text "__session" (a client-generated id never actually
            # produces that, but nothing stops it in principle) still reaches
            # _library_put rather than being mistaken for a sign-in request.
            dtail = seg_route(path_only, "__data")
            if dtail is not None and dtail and dtail[0] == "import":
                if self._require_admin():
                    self._data_import(qs)
                return
            ctail = seg_route(path_only, "__cache")
            if ctail is not None:
                if self._require_session():
                    try:
                        n = int(self.headers.get("Content-Length") or 0)
                    except ValueError:
                        n = 0
                    if n <= 0 or n > MAX_UPLOAD_BYTES:
                        self._json(400, {"error": "bad request body"})
                        return
                    try:
                        body = json.loads(self.rfile.read(n).decode("utf-8"))
                    except (ValueError, UnicodeDecodeError):
                        self._json(400, {"error": "bad JSON body"})
                        return
                    self._cache_post(ctail, body)
                return
            atail = seg_route(path_only, "__agg")
            if atail is not None:
                if self._require_session():
                    try:
                        n = int(self.headers.get("Content-Length") or 0)
                    except ValueError:
                        n = 0
                    if n <= 0 or n > MAX_UPLOAD_BYTES:
                        self._json(400, {"error": "bad request body"})
                        return
                    try:
                        body = json.loads(self.rfile.read(n).decode("utf-8"))
                    except (ValueError, UnicodeDecodeError):
                        self._json(400, {"error": "bad JSON body"})
                        return
                    self._agg_post(atail, body)
                return
            tail = library_route(path_only)
            if tail is not None:
                if not self._require_admin():
                    return
                if len(tail) == 1:
                    self._library_put(tail[0], qs)
                elif len(tail) == 2 and tail[1] == "rename":
                    self._library_rename(tail[0], qs)
                else:
                    self.send_error(404)
                return

            stail = seg_route(path_only, "__session")
            if stail == []:
                self._session_login_post()
                return
            if stail == ["resolve"]:
                self._session_resolve_post()
                return
            if stail == ["viewing"]:
                self._session_viewing_post()
                return
            if stail == ["totp"]:
                self._session_totp_post()
                return
            if stail == ["totp", "start"]:
                self._session_totp_start_post()
                return
            if stail == ["admin-unlock"]:
                self._session_admin_unlock_post()
                return
            if stail == ["admin-unlock", "revoke"]:
                self._session_admin_unlock_revoke_post()
                return

            ttail = seg_route(path_only, "__totp")
            if ttail is not None:
                if self._require_session():
                    self._totp_post(ttail)
                return

            otail = seg_route(path_only, "__otp")
            if otail == ["send"]:
                self._otp_send_post()
                return
            if otail == ["verify"]:
                self._otp_verify_post()
                return

            atail = seg_route(path_only, "__admin")
            if atail is not None:
                if self._require_admin():
                    try:
                        n = int(self.headers.get("Content-Length") or 0)
                        body = json.loads(self.rfile.read(n).decode("utf-8")) if n else {}
                    except (ValueError, UnicodeDecodeError):
                        body = {}
                    self._admin_post(atail, body)
                return

            last_seg = _route_name(path_only)
            if last_seg == "__logout":
                token = self._session_token()
                logout_login = session_login(token)
                drop_session(token)
                if logout_login:
                    log_history(logout_login, "logout")
                self._json(200, {"ok": True})
                return

            if last_seg == "__feedback":
                self._feedback_post()
                return

            if last_seg != "__request":
                self.send_error(404)
                return
            self._request_post()

        def _request_post(self):
            """POST /__request -- signup, password-reset, or id-change,
            submitted by anyone, admin key or no. This used to be the
            admin-key-gated POST /__auth: creating an account or resetting a
            password used to take effect immediately once that one shared
            secret was typed correctly. It now takes effect only once the
            admin approves it from the Pending Requests queue (see
            _admin_requests_resolve below) -- this endpoint only ever queues
            the request, never touches auth.json itself."""
            try:
                n = int(self.headers.get("Content-Length") or 0)
                if n <= 0 or n > 8192:
                    raise ValueError("bad length")
                req = json.loads(self.rfile.read(n).decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                self._json(400, {"error": "bad request"})
                return

            rtype = req.get("type")
            if rtype not in ("signup", "password_reset", "id_change"):
                self._json(400, {"error": "bad request"})
                return

            # Submitting a request is rate-limited the same way sign-in is --
            # nothing here can change an account on its own, but it should
            # still not be a free way to flood the admin's queue.
            rate_key = "request:" + self.client_address[0]
            if rate_locked(rate_key):
                self._json(429, {"error": "too many attempts -- try again shortly"})
                return

            auth = read_auth()
            accounts = auth.get("accounts") or []
            login = clean_login(req.get("login"))
            if not login:
                self._json(400, {"error": "a username is required"})
                return

            entry = {"id": secrets.token_hex(12), "type": rtype, "login": login,
                     "status": "pending", "createdAt": int(time.time() * 1000),
                     "resolvedAt": None, "remark": ""}

            if rtype == "signup":
                if any(a.get("login") == login for a in accounts):
                    rate_fail(rate_key)
                    self._json(409, {"error": "that username is already taken"})
                    return
                salt, hash_ = str(req.get("salt") or ""), str(req.get("hash") or "")
                if len(salt) != 32 or len(hash_) != 64:
                    self._json(400, {"error": "bad payload"})
                    return
                profile = {}
                for field in ("name", "designation", "department", "category", "phone", "email", "parasId"):
                    val = str((req.get("profile") or {}).get(field) or "").strip()[:200]
                    if val:
                        profile[field] = val
                # Once email is set up, a sign-up can't go through without
                # first proving the address actually belongs to whoever is
                # typing -- see __otp/send and __otp/verify. Skipped entirely
                # while mail is not configured, same as before this existed.
                if mail.mail_enabled():
                    email = (profile.get("email") or "").strip().lower()
                    verified = otp_token_email(str(req.get("otpToken") or ""))
                    if not email or not verified or verified != email:
                        rate_fail(rate_key)
                        self._json(400, {"error": "verify the email address first"})
                        return
                entry["payload"] = {"salt": salt, "hash": hash_,
                                    "iterations": int(req.get("iterations") or 250000), "profile": profile}
            elif rtype == "password_reset":
                if not any(a.get("login") == login for a in accounts):
                    rate_fail(rate_key)
                    self._json(404, {"error": "no such account"})
                    return
                salt, hash_ = str(req.get("salt") or ""), str(req.get("hash") or "")
                if len(salt) != 32 or len(hash_) != 64:
                    self._json(400, {"error": "bad payload"})
                    return
                entry["payload"] = {"salt": salt, "hash": hash_, "iterations": int(req.get("iterations") or 250000)}
            else:  # id_change
                if not any(a.get("login") == login for a in accounts):
                    rate_fail(rate_key)
                    self._json(404, {"error": "no such account"})
                    return
                new_login = clean_login(req.get("newLogin"))
                if not new_login:
                    self._json(400, {"error": "a new sign-in name is required"})
                    return
                if any(a.get("login") == new_login for a in accounts):
                    self._json(409, {"error": "that sign-in name is already taken"})
                    return
                entry["payload"] = {"newLogin": new_login}

            rate_clear(rate_key)
            with REQUESTS_LOCK:
                requests_ = read_requests()
                requests_.append(entry)
                write_requests(requests_)
            print("  New %s request: %s" % (rtype, login))
            notify_admin_of_request(rtype, login)
            self._json(200, {"ok": True, "id": entry["id"]})

        def _feedback_post(self):
            """POST /__feedback -- a signed-in account's own suggestion, bug
            report, or question about the Command Centre. Unlike __request
            this never mutates auth.json or anything else -- it is purely a
            note that lands in the admin panel's "Suggestions & issues" list
            for the admin to read and, optionally, mark done."""
            login = session_login(self._session_token())
            if not login:
                self._json(401, {"error": "sign in required"})
                return

            rate_key = "feedback:" + self.client_address[0]
            if rate_locked(rate_key):
                self._json(429, {"error": "too many attempts -- try again shortly"})
                return

            try:
                n = int(self.headers.get("Content-Length") or 0)
                if n <= 0 or n > 4096:
                    raise ValueError("bad length")
                req = json.loads(self.rfile.read(n).decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                rate_fail(rate_key)
                self._json(400, {"error": "bad request"})
                return

            category = req.get("category")
            if category not in ("feature", "requirement", "bug", "data", "other"):
                category = "other"
            subject = str(req.get("subject") or "").strip()[:120]
            message = str(req.get("message") or "").strip()[:2000]
            if not subject or not message:
                rate_fail(rate_key)
                self._json(400, {"error": "a subject and some details are required"})
                return

            rate_clear(rate_key)
            entry = {"id": secrets.token_hex(12), "login": login, "category": category,
                     "subject": subject, "message": message, "status": "open",
                     "createdAt": int(time.time() * 1000), "resolvedAt": None, "remark": ""}
            with FEEDBACK_LOCK:
                items = read_feedback()
                items.append(entry)
                write_feedback(items)
            print("  New %s request from %s: %s" % (category, login, subject))
            self._json(200, {"ok": True, "id": entry["id"]})

        def _otp_send_post(self):
            """POST /__otp/send {email} -- emails a 6-digit code to whatever
            address the sign-up form has typed so far, no session required
            (there is no account yet). Rate-limited per IP the same way
            sign-in attempts are, so this can't be used to spam an inbox or
            probe which addresses exist -- the response is identical either
            way, since a mail server's own bounce (if any) is the only place
            that distinction would ever surface."""
            rate_key = "otp-send:" + self.client_address[0]
            if rate_locked(rate_key):
                self._json(429, {"error": "too many attempts -- try again shortly"})
                return
            try:
                n = int(self.headers.get("Content-Length") or 0)
                if n <= 0 or n > 1024:
                    raise ValueError("bad length")
                req = json.loads(self.rfile.read(n).decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                rate_fail(rate_key)
                self._json(400, {"error": "bad request"})
                return
            email = str(req.get("email") or "").strip().lower()
            if "@" not in email or len(email) > 200:
                rate_fail(rate_key)
                self._json(400, {"error": "enter a valid email address"})
                return
            if not mail.mail_enabled():
                self._json(503, {"error": "email is not set up on this server"})
                return
            rate_fail(rate_key)   # counts toward the limit even on success -- a fixed budget of codes per IP
            code = "%06d" % secrets.randbelow(1000000)
            otp_store(email, code)
            text, html_body = otp_email_bodies(code)
            mail.send_mail(email, "Paras Health SCM: verification code", text, html=html_body)
            self._json(200, {"ok": True})

        def _otp_verify_post(self):
            """POST /__otp/verify {email, code} -- on a match, returns a
            token the sign-up request carries instead of the code itself, so
            the request can be finished (filling in the rest of the form)
            without asking for the code a second time, and the code itself
            is single-use."""
            rate_key = "otp-verify:" + self.client_address[0]
            if rate_locked(rate_key):
                self._json(429, {"error": "too many attempts -- try again shortly"})
                return
            try:
                n = int(self.headers.get("Content-Length") or 0)
                if n <= 0 or n > 1024:
                    raise ValueError("bad length")
                req = json.loads(self.rfile.read(n).decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                rate_fail(rate_key)
                self._json(400, {"error": "bad request"})
                return
            email = str(req.get("email") or "").strip().lower()
            code = re.sub(r"\s+", "", str(req.get("code") or ""))
            if not otp_check(email, code):
                rate_fail(rate_key)
                self._json(400, {"error": "wrong or expired code"})
                return
            rate_clear(rate_key)
            self._json(200, {"ok": True, "token": otp_issue_token(email)})

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
            if _route_name(self.path.split("?")[0]) == "__auth":
                return False
            # Anything outside the friendly path goes to it, so the browser
            # never settles on a URL that is not the real one.
            if self.path.rstrip("/") == prefix.rstrip("/") and not self.path.endswith("/"):
                self._send_redirect(301)
                return True
            if not self.path.startswith(prefix):
                self._send_redirect(302)
                return True
            return False

        def _send_redirect(self, code):
            # Content-Length matters here: under HTTP/1.1 the connection is
            # reused, so a bodyless response that does not say "zero bytes"
            # leaves the browser waiting for a body that never comes.
            self.send_response(code)
            self.send_header("Location", prefix)
            self.send_header("Content-Length", "0")
            self.end_headers()

        def translate_path(self, path):
            if prefix != "/" and path.startswith(prefix):
                path = "/" + path[len(prefix):]
            return super().translate_path(path)

        def end_headers(self):
            # Local workspace: never let the browser serve a stale dashboard.
            self.send_header("Cache-Control", "no-store")
            super().end_headers()

        # Keep-alive: the app pulls a dozen small assets on load and a dashboard
        # pulls more, and HTTP/1.0 tears down the connection after each one.
        # Every response this handler produces sets Content-Length (including
        # the redirects above and send_error), which is what makes this safe.
        protocol_version = "HTTP/1.1"

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


class LocalServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    """Threaded on purpose.

    Single-threaded, one slow request froze everything else: uploading or
    reading back a large register held the only worker for the whole transfer,
    so the page it was uploaded from could not even fetch its own icons until
    the transfer finished (measured: an ordinary request went from ~7ms to
    ~240ms behind a single 60MB upload, and a 300MB one is several seconds).
    Writes to the library index are serialised by LIBRARY_LOCK instead, which
    is the only shared state here.
    """
    allow_reuse_address = True
    daemon_threads = True                  # never keep the process alive on Ctrl+C


def bind(port, prefix, lan=False):
    handler = functools.partial(make_handler(prefix), directory=ROOT)
    return LocalServer(("0.0.0.0" if lan else "127.0.0.1", port), handler)


def lan_ip():
    """This machine's address on the local network, for the --lan banner.
    Opens no connection -- UDP sockets pick a route without sending a packet --
    so it works offline too, falling back to loopback if even that fails."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def main(argv):
    cfg = settings()
    port, auto_open, prefix, app_mode, lan = int(cfg["port"]), True, cfg["path"], False, False

    i = 0
    while i < len(argv):
        a = argv[i]
        if a in ("--no-open", "-n"):
            auto_open = False
        elif a in ("--app", "-a"):
            app_mode = True
        elif a == "--plain":
            prefix = "/"
        elif a == "--lan":
            lan = True
        elif a == "--port" and i + 1 < len(argv):
            i += 1
            port = int(argv[i])
        elif a.isdigit():
            port = int(a)
        i += 1

    os.makedirs(LIBRARY_BLOBS, exist_ok=True)

    # Bring an older install's data across, if this is the first run since it
    # moved out of the app folder. Has to happen before sync, which reads
    # auth.json from the new location.
    paths.migrate()

    try:
        sys.path.insert(0, ROOT)
        import sync
        sync.main()
    except SystemExit as exc:
        print("sync warning: %s" % exc)
    except Exception as exc:                     # noqa: BLE001
        print("sync skipped: %s" % exc)

    try:
        httpd = bind(port, prefix, lan)
    except OSError as exc:
        alt = int(cfg["fallbackPort"])
        if port == alt:
            sys.exit("Could not bind port %d (%s)." % (port, exc))
        print("Port %d is not available (%s) - using %d instead." % (port, exc, alt))
        try:
            httpd = bind(alt, prefix, lan)
        except OSError as exc2:
            sys.exit("Could not bind port %d either (%s)." % (alt, exc2))
        port = alt

    # An empty "hostname" in site.json means "just use 127.0.0.1" -- a
    # deliberate choice, not a missing step, so no setup is suggested below.
    want_host = cfg["hostname"]
    host = want_host if (want_host and hostname_is_mapped(want_host)) else "127.0.0.1"
    netloc = host if port == 80 else "%s:%d" % (host, port)
    url = "http://%s%s" % (netloc, prefix)

    print("\n  PARAS HEALTH - SUPPLY CHAIN COMMAND CENTRE")
    print("  %s" % url)
    if host == "127.0.0.1" and cfg["hostname"]:
        print("  (run setup_hostname.py as Administrator to use %s instead)" % cfg["hostname"])
    if lan:
        lan_netloc = lan_ip() if port == 80 else "%s:%d" % (lan_ip(), port)
        print("  From other computers on this network: http://%s%s" % (lan_netloc, prefix))
        print("  (the friendly name above only resolves on this PC -- other computers must use that address)")
    print("  Local only. Press Ctrl+C to stop." if not lan else "  Reachable from this network. Press Ctrl+C to stop.")
    # Printed every run, not just the first: "where is my data" should never
    # need a search.
    print("  Data: %s" % paths.data_dir())
    if paths.fell_back():
        print("  ^ inside the app folder - a new build extracted elsewhere will NOT see it.")
    print("")

    if auto_open:
        threading.Timer(0.6, lambda: open_window(url, app_mode)).start()
    start_backup_scheduler()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  Stopped.")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
