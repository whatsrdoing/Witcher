#!/usr/bin/env python3
"""Set up outgoing email for the Command Centre -- admin notifications on new
requests, sign-up email verification, and the admin broadcast tool.

    python3 set_mail.py                                            # prompts for everything
    python3 set_mail.py --host smtp.company.com --port 587 \
      --username notices@parashealth.com --password 'app-password' \
      --from "Paras Health SCM <notices@parashealth.com>"
    python3 set_mail.py --ssl --port 465 ...                        # implicit TLS instead of STARTTLS
    python3 set_mail.py --test you@parashealth.com                  # send a test email with the saved config
    python3 set_mail.py --remove                                    # turn email features off again

Writes to appstore's mail_config table (see appstore.py) -- never inside
the app folder, never mirrored anywhere the browser can read it, same
reasoning as auth.json's password hashes. Run this on the machine that
holds the data folder, not through the app itself: the password this asks
for is a real SMTP credential (an "app password" for Gmail/Office 365, or
whatever your mail server issues), and it has no reason to ever pass
through a browser or get typed into any web form.
"""
import getpass
import sys

import mail


def main(argv):
    if "--remove" in argv:
        if mail.read_mail_config() is None:
            print("Nothing to remove.")
        else:
            mail.write_mail_config(None)
            print("Email is now off -- notifications, sign-up codes, and broadcasts are skipped silently.")
        return 0

    test_to = None
    if "--test" in argv:
        i = argv.index("--test")
        if i + 1 >= len(argv):
            sys.exit("--test needs an email address to send to.")
        test_to = argv[i + 1]
        del argv[i:i + 2]
        if not argv:
            # Just re-sending the test with whatever is already saved.
            cfg = mail.read_mail_config()
            if not cfg:
                sys.exit("No email configuration saved yet -- run set_mail.py without --test first.")
            ok = mail.send_mail(test_to, "Paras Health SCM -- test email",
                                 "This is a test message from set_mail.py. If you can read this, "
                                 "outgoing email is working.")
            print("Sent." if ok else "Could not send it -- check the server console output above for why.")
            return 0 if ok else 1

    use_ssl = "--ssl" in argv
    if use_ssl:
        argv.remove("--ssl")

    values = {}
    for flag, key in (("--host", "host"), ("--port", "port"), ("--username", "username"),
                       ("--password", "password"), ("--from", "from")):
        if flag in argv:
            i = argv.index(flag)
            if i + 1 >= len(argv):
                sys.exit("%s needs a value." % flag)
            values[key] = argv[i + 1]
            del argv[i:i + 2]

    prev = mail.read_mail_config() or {}
    if not values:
        # Fully interactive -- nothing passed on the command line at all.
        values["host"] = input("SMTP server host [%s]: " % prev.get("host", "")).strip() or prev.get("host", "")
        values["port"] = input("SMTP port (587 for STARTTLS, 465 for SSL) [%s]: "
                                % prev.get("port", 587)).strip() or prev.get("port", 587)
        values["username"] = input("SMTP username [%s]: " % prev.get("username", "")).strip() or prev.get("username", "")
        pw = getpass.getpass("SMTP password (not shown): ")
        values["password"] = pw or prev.get("password", "")
        values["from"] = input('From address, e.g. "Paras Health SCM <notices@parashealth.com>" [%s]: '
                                % prev.get("from", "")).strip() or prev.get("from", "")
        use_ssl = (input("Use implicit SSL instead of STARTTLS? [y/N]: ").strip().lower() == "y") \
            if not prev.get("ssl") else True

    cfg = dict(prev)
    cfg.update({k: v for k, v in values.items() if v})
    cfg["ssl"] = use_ssl or bool(prev.get("ssl"))
    try:
        cfg["port"] = int(cfg.get("port") or (465 if cfg["ssl"] else 587))
    except (TypeError, ValueError):
        sys.exit("Port must be a number.")

    if not cfg.get("host") or not cfg.get("username") or not cfg.get("password") or not cfg.get("from"):
        sys.exit("host, username, password, and from are all required. Nothing was saved.")

    mail.write_mail_config(cfg)
    print("Saved.")
    print("Admin notifications, sign-up codes, and the broadcast tool will now send for real.")

    if test_to:
        ok = mail.send_mail(test_to, "Paras Health SCM -- test email",
                             "This is a test message from set_mail.py. If you can read this, "
                             "outgoing email is working.")
        print("Test email sent." if ok else "Test email failed -- check the server console output above for why.")
        return 0 if ok else 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
