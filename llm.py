"""Claude API access for the admin-only assistant.

Raw HTTPS via urllib, deliberately -- not the official `anthropic` pip
package. This app installs nothing beyond the Python standard library
anywhere else (mail.py's SMTP client is the same discipline for the same
reason), and the one feature in the whole thing that talks to the
internet at all shouldn't be the one place that changes that.

Credentials live in appstore's llm_config table (see appstore.py), set
with `set_llm.py`, run locally on the machine that holds the data folder
-- never typed into the app itself, never sent anywhere but
api.anthropic.com.

Every call is best-effort in the sense that it never raises back to the
caller -- but unlike mail.send_mail (where "silently did nothing" is the
right failure mode for a notification), an assistant question with no
answer needs the caller to know that plainly, so this returns None on
failure and the reason as a second value, rather than swallowing it."""
import json
import ssl
import urllib.error
import urllib.request

import appstore

API_URL = "https://api.anthropic.com/v1/messages"
API_VERSION = "2023-06-01"
DEFAULT_MODEL = "claude-opus-5"
TIMEOUT = 60


def read_llm_config():
    return appstore.read_llm_config()


def write_llm_config(cfg):
    appstore.write_llm_config(cfg)


def llm_enabled():
    cfg = read_llm_config()
    return bool(cfg and cfg.get("apiKey"))


def messages_create(messages, system=None, tools=None, max_tokens=1024, model=None):
    """One call to POST /v1/messages. Returns (response_dict, None) on
    success or (None, reason_string) on any failure -- no API key
    configured, a network error, or the API itself rejecting the
    request.

    `model` overrides the configured default for this one call only (the
    per-question model picker in the Ask panel) -- it never touches the
    saved config, which stays whatever set_llm.py last wrote."""
    cfg = read_llm_config()
    if not cfg or not cfg.get("apiKey"):
        return None, "no API key configured -- see set_llm.py"

    payload = {"model": model or cfg.get("model") or DEFAULT_MODEL, "max_tokens": max_tokens, "messages": messages}
    if system:
        payload["system"] = system
    if tools:
        payload["tools"] = tools

    body = json.dumps(payload).encode("utf-8")
    headers = {
        "content-type": "application/json",
        "x-api-key": cfg["apiKey"],
        "anthropic-version": API_VERSION,
    }
    if cfg.get("workspaceId"):
        headers["anthropic-workspace-id"] = cfg["workspaceId"]
    req = urllib.request.Request(API_URL, data=body, method="POST", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT, context=ssl.create_default_context()) as resp:
            return json.loads(resp.read().decode("utf-8")), None
    except urllib.error.HTTPError as exc:
        try:
            detail = json.loads(exc.read().decode("utf-8"))
            reason = (detail.get("error") or {}).get("message") or str(exc)
        except (ValueError, OSError):
            reason = str(exc)
        print("  Claude API call failed (HTTP %s): %s" % (exc.code, reason))
        return None, reason
    except (OSError, ValueError) as exc:
        print("  Claude API call failed: %s" % exc)
        return None, str(exc)
