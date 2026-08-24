#!/usr/bin/env python3
"""Set the Command Centre's sign-in name and password.

    python3 set_password.py                          # prompts for both
    python3 set_password.py admin/ritik 'Secret1'     # exact, case-sensitive
    python3 set_password.py --admin-key NEWKEY ...   # change the reset key
    python3 set_password.py --remove someuser        # revoke an account

Writes auth.json with a fresh random salt and a PBKDF2-HMAC-SHA256 hash, then
refreshes the auth.js mirror. The password itself is never stored anywhere.

There is deliberately no "change password" screen inside the app — resetting
is done here, on the machine that holds the folder. Accounts created from the
in-app Sign up screen (which needs the admin key) are listed the same way and
can be revoked with --remove; there is no in-app way to remove one, on
purpose — that decision stays with whoever holds this folder.
"""
import getpass
import hashlib
import json
import os
import secrets
import sys
import time

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, "auth.json")
ITERATIONS = 250_000
DEFAULT_ADMIN_KEY = "U118540720248"


def kdf(secret, salt_hex):
    return hashlib.pbkdf2_hmac(
        "sha256", secret.encode("utf-8"), bytes.fromhex(salt_hex), ITERATIONS, 32
    ).hex()


def build(login, password, hint="", admin="Ritik Nagar", admin_key=DEFAULT_ADMIN_KEY,
          key_salt=None, key_hash=None, prev_accounts=None):
    salt = secrets.token_hex(16)
    digest = kdf(password, salt)
    if key_hash is None:
        key_salt = secrets.token_hex(16)
        key_hash = kdf(admin_key, key_salt)

    # Accounts registered later through the app's own sign-up screen (or a
    # previous run of this script) live in "accounts" and are preserved --
    # this only ever replaces the one entry matching `login`, or adds it as
    # the new first (primary) account. Never wipes the others.
    accounts = [a for a in (prev_accounts or []) if a.get("login") != login]
    accounts.insert(0, {
        "login": login, "salt": salt, "hash": digest,
        "iterations": ITERATIONS, "createdAt": int(time.time() * 1000),
    })

    return {
        "$comment": "Sign-in for the Command Centre. Passwords are not stored -- only a "
                    "PBKDF2-HMAC-SHA256 hash of each. Reset the primary one with: "
                    "python3 set_password.py -- other accounts are added from the app's "
                    "own Sign up screen (needs the admin key) and are never touched here.",
        "schema": 2,
        "enabled": True,
        "accounts": accounts,
        # Legacy mirror of accounts[0], read by older builds of gate.js only.
        "email": login,
        "logins": [login],
        "salt": salt,
        "iterations": ITERATIONS,
        "hash": digest,
        "hint": hint,
        "admin": admin,
        # Unlocks the in-app password reset and sign-up. Like a password, only
        # its hash is stored. Change it with:  python3 set_password.py --admin-key NEW
        "adminKeySalt": key_salt,
        "adminKeyHash": key_hash,
        "maxAttempts": 5,
        "lockoutSeconds": 60,
    }


def remove_account(login):
    if not os.path.exists(OUT):
        sys.exit("No auth.json yet — nothing to remove.")
    auth = json.load(open(OUT, encoding="utf-8"))
    accounts = auth.get("accounts") or (
        [{"login": auth.get("email", ""), "salt": auth.get("salt", ""),
          "hash": auth.get("hash", ""), "iterations": auth.get("iterations", ITERATIONS)}]
        if auth.get("hash") else []
    )
    kept = [a for a in accounts if a.get("login") != login]
    if len(kept) == len(accounts):
        sys.exit('No account named "%s". Current accounts: %s'
                 % (login, ", ".join(a.get("login", "?") for a in accounts) or "(none)"))
    if not kept:
        sys.exit("Refusing to remove the only remaining account — that would lock everyone out. "
                  "Set a new primary account first with set_password.py, or edit auth.json by hand.")

    auth["accounts"] = kept
    auth["email"] = kept[0].get("login", "")
    auth["logins"] = [kept[0].get("login", "")]
    auth["salt"] = kept[0].get("salt", "")
    auth["hash"] = kept[0].get("hash", "")
    auth["iterations"] = kept[0].get("iterations", ITERATIONS)

    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(auth, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
    print('Removed "%s". Remaining: %s' % (login, ", ".join(a.get("login", "?") for a in kept)))
    try:
        sys.path.insert(0, ROOT)
        import sync
        sync.main()
    except Exception as exc:                      # noqa: BLE001
        print("Run 'python3 sync.py' to refresh the offline mirror (%s)" % exc)
    return 0


def main(argv):
    if "--remove" in argv:
        i = argv.index("--remove")
        if i + 1 >= len(argv):
            sys.exit("--remove needs a username.")
        return remove_account(argv[i + 1])

    new_key = None
    if "--admin-key" in argv:
        i = argv.index("--admin-key")
        if i + 1 >= len(argv):
            sys.exit("--admin-key needs a value.")
        new_key = argv[i + 1]
        del argv[i:i + 2]

    # The sign-in name is taken exactly as typed -- case-sensitive, no
    # splitting on "/" or "," -- so "admin/ritik" is one literal username,
    # not two. This also means "Admin/Ritik" is a *different* login from
    # "admin/ritik" and will be rejected.
    if len(argv) >= 2:
        login = argv[0]
        password = argv[1]
        hint = argv[2] if len(argv) > 2 else ""
    else:
        current = ""
        if os.path.exists(OUT):
            try:
                prev = json.load(open(OUT, encoding="utf-8"))
                logins_prev = prev.get("logins") or [prev.get("email", "")]
                current = logins_prev[0] if logins_prev else ""
            except (OSError, ValueError):
                pass
        prompt = "Sign-in name (exact, case-sensitive)" + (" [%s]: " % current if current else ": ")
        login = input(prompt).strip() or current
        if not login:
            sys.exit("A sign-in name is required.")
        password = getpass.getpass("New password: ")
        if not password:
            sys.exit("A password is required.")
        if password != getpass.getpass("Repeat password: "):
            sys.exit("The two passwords did not match. Nothing was changed.")
        hint = input("Hint shown on the sign-in screen (optional): ").strip()

    if not login:
        sys.exit("A sign-in name is required.")
    if len(password) < 6:
        sys.exit("Use at least 6 characters. Nothing was changed.")

    admin, key_salt, key_hash, prev_accounts = "Ritik Nagar", None, None, None
    if os.path.exists(OUT):
        try:
            prev = json.load(open(OUT, encoding="utf-8"))
            admin = prev.get("admin", admin) or admin
            prev_accounts = prev.get("accounts")
            if new_key is None:
                key_salt, key_hash = prev.get("adminKeySalt"), prev.get("adminKeyHash")
        except (OSError, ValueError):
            pass
    if new_key is not None:
        key_salt = key_hash = None

    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(build(login, password, hint, admin,
                        new_key or DEFAULT_ADMIN_KEY, key_salt, key_hash, prev_accounts),
                  fh, indent=2, ensure_ascii=False)
        fh.write("\n")

    extra = len(prev_accounts or []) - (1 if prev_accounts and any(a.get("login") == login for a in prev_accounts) else 0)
    print("auth.json written for %s (PBKDF2-SHA256, %d iterations)%s"
          % (login, ITERATIONS, " -- %d other account(s) kept unchanged" % extra if extra > 0 else ""))
    try:
        sys.path.insert(0, ROOT)
        import sync
        sync.main()
    except Exception as exc:                      # noqa: BLE001
        print("Run 'python3 sync.py' to refresh the offline mirror (%s)" % exc)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
