#!/usr/bin/env python3
"""Set up the admin-only "ask a question" assistant.

    python3 set_llm.py                          # prompts for the API key
    python3 set_llm.py --key sk-ant-...          # set it directly
    python3 set_llm.py --key sk-ant-... --model claude-sonnet-5
    python3 set_llm.py --key sk-ant-... --workspace wrkspc_...
    python3 set_llm.py --test "how many files are in the data library?"
    python3 set_llm.py --remove                  # turn the assistant off again

Some API keys from console.anthropic.com are "identity-linked" -- tied to
your login rather than to one workspace -- and Anthropic requires those
requests to also name which workspace they act in. If __admin/ask reports
"anthropic-workspace-id is required...", open console.anthropic.com, check
the workspace picker (top left) for the workspace your key belongs to, open
Settings for that workspace, and copy its ID (starts with "wrkspc_") into
--workspace. A plain (non-identity-linked) key doesn't need this at all.

Writes llm_config.json to the data folder (see paths.py) -- never inside
the app folder, never mirrored anywhere the browser can read it, same
reasoning as auth.json's password hashes and mail_config.json's SMTP
credentials. Run this on the machine that holds the data folder, not
through the app itself: this is a real Anthropic API key from
console.anthropic.com (a different account and a different bill than a
claude.ai subscription -- a subscription cannot be used here), and it
has no reason to ever pass through a browser or get typed into any web
form. Every question this key answers is billed by Anthropic per use;
see their console for current pricing before turning this on.
"""
import getpass
import sys

import llm
import assistant


def main(argv):
    if "--remove" in argv:
        try:
            import os
            os.remove(llm.LLM_CONFIG_PATH)
            print("Assistant is now off -- __admin/ask will say so plainly instead of answering.")
        except OSError:
            print("Nothing to remove.")
        return 0

    test_q = None
    if "--test" in argv:
        i = argv.index("--test")
        if i + 1 >= len(argv):
            sys.exit("--test needs a question in quotes.")
        test_q = argv[i + 1]
        del argv[i:i + 2]

    values = {}
    for flag, key in (("--key", "apiKey"), ("--model", "model"), ("--workspace", "workspaceId")):
        if flag in argv:
            i = argv.index(flag)
            if i + 1 >= len(argv):
                sys.exit("%s needs a value." % flag)
            values[key] = argv[i + 1]
            del argv[i:i + 2]

    prev = llm.read_llm_config() or {}
    if not values:
        # Fully interactive -- nothing passed on the command line at all.
        # Any flag given at all skips this entirely and falls back to
        # the previous/default values below, so --key alone (the common
        # case, and how --test invokes this non-interactively) never
        # blocks on stdin for a model prompt it wasn't asked for.
        typed = getpass.getpass("Anthropic API key from console.anthropic.com (not shown): ").strip()
        values["apiKey"] = typed or prev.get("apiKey", "")
        values["model"] = input("Model [%s]: " % prev.get("model", llm.DEFAULT_MODEL)).strip() or prev.get("model", llm.DEFAULT_MODEL)
        workspace = input(
            "Workspace ID (only needed if your key is \"identity-linked\" -- leave blank "
            "if unsure, add it later with --workspace if __admin/ask asks for one) [%s]: "
            % prev.get("workspaceId", "")
        ).strip()
        values["workspaceId"] = workspace or prev.get("workspaceId", "")

    if not values.get("apiKey", prev.get("apiKey")):
        sys.exit("An API key is required. Nothing was saved.")

    cfg = dict(prev)
    cfg.update(values)
    cfg.setdefault("model", llm.DEFAULT_MODEL)
    llm.write_llm_config(cfg)
    print("Saved to %s" % llm.LLM_CONFIG_PATH)
    print("The admin-only assistant will now answer for real -- each question is billed by "
          "Anthropic per use; check console.anthropic.com for current pricing and usage.")

    if test_q:
        answer, err = assistant.ask(test_q, [], "")
        if err:
            print("Test question failed: %s" % err)
            return 1
        print("Answer: %s" % answer)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
