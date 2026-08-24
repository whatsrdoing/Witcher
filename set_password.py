#!/usr/bin/env python3
"""Set the Command Centre's sign-in name(s) and password.

    python3 set_password.py                          # prompts for both
    python3 set_password.py you@example.com 'Secret1'
    python3 set_password.py admin/ritik 'Secret1'     # either name signs in
    python3 set_password.py --admin-key NEWKEY ...   # change the reset key

Writes auth.json with a fresh random salt and a PBKDF2-HMAC-SHA256 hash, then
refreshes the auth.js mirror. The password itself is never stored anywhere.

There is deliberately no "change password" screen inside the app — resetting
is done here, on the machine that holds the folder.
"""
import getpass
import hashlib
import json
import os
import secrets
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, "auth.json")
ITERATIONS = 250_000
DEFAULT_ADMIN_KEY = "U118540720248"


def kdf(secret, salt_hex):
    return hashlib.pbkdf2_hmac(
        "sha256", secret.encode("utf-8"), bytes.fromhex(salt_hex), ITERATIONS, 32
    ).hex()


def build(logins, password, hint="", admin="Ritik Nagar", admin_key=DEFAULT_ADMIN_KEY,
          key_salt=None, key_hash=None):
    salt = secrets.token_hex(16)
    digest = kdf(password, salt)
    if key_hash is None:
        key_salt = secrets.token_hex(16)
        key_hash = kdf(admin_key, key_salt)
    return {
        "$comment": "Sign-in for the Command Centre. The password is not stored -- only a "
                    "PBKDF2-HMAC-SHA256 hash of it. Reset with: python3 set_password.py",
        "schema": 1,
        "enabled": True,
        "email": logins[0],
        "logins": logins,
        "salt": salt,
        "iterations": ITERATIONS,
        "hash": digest,
        "hint": hint,
        "admin": admin,
        # Unlocks the in-app password reset. Like the password, only its hash
        # is stored. Change it with:  python3 set_password.py --admin-key NEW
        "adminKeySalt": key_salt,
        "adminKeyHash": key_hash,
        "maxAttempts": 5,
        "lockoutSeconds": 60,
    }


def split_logins(raw):
    parts = [p.strip() for p in raw.replace(",", "/").split("/")]
    seen, out = set(), []
    for p in parts:
        if p and p.lower() not in seen:
            seen.add(p.lower())
            out.append(p)
    return out


def main(argv):
    new_key = None
    if "--admin-key" in argv:
        i = argv.index("--admin-key")
        if i + 1 >= len(argv):
            sys.exit("--admin-key needs a value.")
        new_key = argv[i + 1]
        del argv[i:i + 2]

    if len(argv) >= 2:
        logins = split_logins(argv[0])
        password = argv[1]
        hint = argv[2] if len(argv) > 2 else ""
    else:
        current = ""
        if os.path.exists(OUT):
            try:
                prev = json.load(open(OUT, encoding="utf-8"))
                current = "/".join(prev.get("logins") or [prev.get("email", "")])
            except (OSError, ValueError):
                pass
        prompt = "Sign-in name(s), separate multiple with /" + (" [%s]: " % current if current else ": ")
        raw = input(prompt).strip() or current
        logins = split_logins(raw)
        if not logins:
            sys.exit("At least one sign-in name is required.")
        password = getpass.getpass("New password: ")
        if not password:
            sys.exit("A password is required.")
        if password != getpass.getpass("Repeat password: "):
            sys.exit("The two passwords did not match. Nothing was changed.")
        hint = input("Hint shown on the sign-in screen (optional): ").strip()

    if not logins:
        sys.exit("At least one sign-in name is required.")
    if len(password) < 6:
        sys.exit("Use at least 6 characters. Nothing was changed.")

    admin, key_salt, key_hash = "Ritik Nagar", None, None
    if os.path.exists(OUT):
        try:
            prev = json.load(open(OUT, encoding="utf-8"))
            admin = prev.get("admin", admin) or admin
            if new_key is None:
                key_salt, key_hash = prev.get("adminKeySalt"), prev.get("adminKeyHash")
        except (OSError, ValueError):
            pass
    if new_key is not None:
        key_salt = key_hash = None

    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(build(logins, password, hint, admin,
                        new_key or DEFAULT_ADMIN_KEY, key_salt, key_hash),
                  fh, indent=2, ensure_ascii=False)
        fh.write("\n")

    print("auth.json written for %s (PBKDF2-SHA256, %d iterations)" % ("/".join(logins), ITERATIONS))
    try:
        sys.path.insert(0, ROOT)
        import sync
        sync.main()
    except Exception as exc:                      # noqa: BLE001
        print("Run 'python3 sync.py' to refresh the offline mirror (%s)" % exc)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
