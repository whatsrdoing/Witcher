"""Outgoing email for the Command Centre -- admin notifications, sign-up OTP
codes, and the admin broadcast tool.

Deliberately plain smtplib, no third-party dependency: this app installs
nothing beyond the Python standard library, and that shouldn't change just
because a mail server entered the picture. Credentials live in their own
file under the data folder (see paths.data_dir()) -- set with `set_mail.py`,
run locally on the machine that holds the folder, never typed into the app
itself or committed to the app's own files.

Every send in here is best-effort: a mail server being down, misconfigured,
or simply not set up yet must never break the sign-up/request/broadcast
flow that triggered the send. Callers get a bool back and, on failure, a
line on the server console -- nothing more.
"""
import json
import os
import smtplib
import ssl
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import parseaddr

import paths

MAIL_CONFIG_PATH = os.path.join(paths.data_dir(), "mail_config.json")


def read_mail_config():
    try:
        with open(MAIL_CONFIG_PATH, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def write_mail_config(cfg):
    os.makedirs(os.path.dirname(MAIL_CONFIG_PATH), exist_ok=True)
    tmp = MAIL_CONFIG_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(cfg, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
    os.replace(tmp, MAIL_CONFIG_PATH)


def mail_enabled():
    cfg = read_mail_config()
    return bool(cfg and cfg.get("host") and cfg.get("username") and cfg.get("password") and cfg.get("from"))


def send_mail(to_addr, subject, body, html=None):
    """Send one email -- plain text only, or (when `html` is given) plain
    text plus an HTML alternative, for the couple of system messages (the
    sign-up verification code, the admin's new-request notice) worth a
    proper greeting and a code that actually looks like a code. Mail
    clients that can't render HTML fall back to `body`, so `body` should
    always stand on its own, not just say "see the HTML version". Returns
    True on success, False on any failure (bad config, unreachable server,
    rejected recipient, ...) -- the reason goes to the server console via
    print, same as make_backup's failure handling, never raised back to
    the caller."""
    cfg = read_mail_config()
    if not cfg or not mail_enabled():
        return False
    to_addr = (to_addr or "").strip()
    if not to_addr or "@" not in parseaddr(to_addr)[1]:
        return False

    if html:
        msg = MIMEMultipart("alternative")
        msg.attach(MIMEText(body, "plain", "utf-8"))
        msg.attach(MIMEText(html, "html", "utf-8"))
    else:
        msg = MIMEText(body, "plain", "utf-8")
    msg["Subject"] = subject
    msg["From"] = cfg["from"]
    msg["To"] = to_addr

    host = cfg["host"]
    port = int(cfg.get("port") or (465 if cfg.get("ssl") else 587))
    timeout = 10
    try:
        if cfg.get("ssl"):
            server = smtplib.SMTP_SSL(host, port, timeout=timeout, context=ssl.create_default_context())
        else:
            server = smtplib.SMTP(host, port, timeout=timeout)
        with server:
            if not cfg.get("ssl"):
                server.starttls(context=ssl.create_default_context())
            server.login(cfg["username"], cfg["password"])
            server.sendmail(parseaddr(cfg["from"])[1], [parseaddr(to_addr)[1]], msg.as_string())
        return True
    except (OSError, smtplib.SMTPException) as exc:
        print("  Mail to %s failed: %s" % (to_addr, exc))
        return False
