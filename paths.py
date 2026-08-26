"""Where the Command Centre keeps its data.

Everything the app accumulates -- uploaded files, the month-on-month
database, the accounts -- lives OUTSIDE the app folder, at a fixed place on
this machine.

The reason is upgrades. A new build arrives as a zip that gets extracted to
a new folder, and anything sitting inside the old folder is simply not there
any more. Keeping the data at an address that does not move means upgrading
is "unzip and run" with nothing to remember and nothing to copy by hand.

Resolution order, first one that works:

  1. PARAS_DATA_DIR         an explicit override; also what the tests use
  2. <SystemDrive>\\ParasHealth\\CommandCentre   the normal answer on Windows
     ~/ParasHealth/CommandCentre                 the same idea elsewhere
  3. <app folder>/data      only if (2) cannot be created -- announced
                            loudly, because data that quietly went somewhere
                            unexpected is worse than data that failed to move

Every script that touches this data imports from here, so serve.py, sync.py
and set_password.py cannot end up disagreeing about where it is.
"""

import os
import shutil
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))

_resolved = None      # cache: the decision is made once per process
_fell_back = False    # True when (3) was used, so callers can say so


def _preferred():
    """The fixed per-machine location, before checking we can write to it."""
    env = os.environ.get("PARAS_DATA_DIR")
    if env:
        return os.path.abspath(env), "PARAS_DATA_DIR"
    if os.name == "nt":
        # SystemDrive rather than a hard-coded C: -- it is C: on essentially
        # every machine, and correct on the rare one where Windows lives
        # somewhere else.
        drive = os.environ.get("SystemDrive") or "C:"
        return os.path.join(drive + os.sep, "ParasHealth", "CommandCentre"), "default"
    return os.path.join(os.path.expanduser("~"), "ParasHealth", "CommandCentre"), "default"


def _writable(path):
    """Can we actually create and write here? Ask by doing, not by guessing --
    a locked-down machine can present a path that looks fine and refuses the
    first write."""
    try:
        os.makedirs(path, exist_ok=True)
        probe = os.path.join(path, ".write-test")
        with open(probe, "w") as fh:
            fh.write("ok")
        os.remove(probe)
        return True
    except OSError:
        return False


def data_dir():
    """The folder holding everything this install has accumulated."""
    global _resolved, _fell_back
    if _resolved:
        return _resolved
    want, source = _preferred()
    if _writable(want):
        _resolved = want
        return _resolved

    # Could not use the fixed location. Say so plainly rather than quietly
    # putting the data somewhere that the next upgrade will wipe.
    _fell_back = True
    _resolved = os.path.join(ROOT, "data")
    os.makedirs(_resolved, exist_ok=True)
    sys.stderr.write(
        "\n  WARNING: could not use %s\n"
        "  Data is going in the app folder instead:\n    %s\n"
        "  It will NOT survive extracting a new build to a new folder.\n"
        "  To fix, either create that folder once by hand, or set\n"
        "  PARAS_DATA_DIR to somewhere you can write.\n\n" % (want, _resolved))
    return _resolved


def fell_back():
    """True when data_dir() had to use the app folder. Call after data_dir()."""
    return _fell_back


def library_dir(): return os.path.join(data_dir(), "library")
def library_blobs(): return os.path.join(library_dir(), "blobs")
def library_index(): return os.path.join(library_dir(), "index.json")
def db_path(): return os.path.join(data_dir(), "library.db")
def auth_path(): return os.path.join(data_dir(), "auth.json")


def ensure():
    """Create the folders. Safe to call repeatedly."""
    os.makedirs(library_blobs(), exist_ok=True)
    return data_dir()


# ---------------------------------------------------------------------------
# Bringing an older install across
# ---------------------------------------------------------------------------

def _copy_tree(src, dst):
    """Copy src into dst without overwriting anything already there. Returns
    how many files were copied."""
    n = 0
    for base, _dirs, files in os.walk(src):
        rel = os.path.relpath(base, src)
        target = dst if rel == "." else os.path.join(dst, rel)
        os.makedirs(target, exist_ok=True)
        for name in files:
            s, d = os.path.join(base, name), os.path.join(target, name)
            if os.path.exists(d):
                continue                      # never clobber the newer copy
            shutil.copy2(s, d)
            # A truncated copy indexed as complete is the failure that loses
            # data silently, so check rather than assume.
            if os.path.getsize(s) != os.path.getsize(d):
                os.remove(d)
                raise OSError("short copy: %s" % s)
            n += 1
    return n


def migrate(report=print):
    """Move an older install's data to the fixed location, once.

    Copies rather than moves: if anything goes wrong the original is still
    there. Nothing already at the destination is touched, so running this
    against a populated data folder does nothing.
    """
    dest = ensure()
    old_data = os.path.join(ROOT, "data")
    old_auth = os.path.join(ROOT, "auth.json")
    moved = []

    if os.path.isdir(old_data) and os.path.abspath(old_data) != os.path.abspath(dest):
        try:
            n = _copy_tree(old_data, dest)
            if n:
                moved.append("%d file%s from the app folder" % (n, "" if n == 1 else "s"))
        except OSError as exc:
            report("  ! could not bring the old data across: %s" % exc)

    # auth.json ships inside the zip, so the copy in the app folder is only
    # ever a starting point: it seeds the real one the first time and is
    # ignored from then on, which is what stops an upgrade resetting accounts.
    if os.path.isfile(old_auth) and not os.path.exists(auth_path()):
        try:
            shutil.copy2(old_auth, auth_path())
            moved.append("accounts (auth.json)")
        except OSError as exc:
            report("  ! could not bring auth.json across: %s" % exc)

    if moved:
        report("  moved to %s: %s" % (dest, "; ".join(moved)))
        report("  the originals are untouched and can be deleted once you are happy.")
    return moved
