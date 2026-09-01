"""The admin-only "ask a question" assistant.

Two tools, both reading straight from the Shared Data Library (the same
uploads every dashboard already reads from) -- no separate database, no
duplicated numbers. Claude picks which tool(s) to call and how many
times; the actual arithmetic always happens here in plain Python against
the real file, never inside the model. That split is the whole point:
the model is free-form about *which* question it's answering, but the
*number* it hands back is always something this code actually computed.

This is a first version, not a port of every dashboard's own bespoke
formulas (EPR, variance, expiry buckets, ...) -- those still only exist
client-side, per dashboard. What it can answer today is anything
expressible as "sum/count/average/max/min of a column, optionally
filtered by another column" over a Data Library file -- real, exact
numbers, just not yet the dashboards' own specialised calculations.
Growing it to cover those is adding more tools here, one at a time.

Deliberately takes the library index and blob directory as arguments
rather than importing serve.py -- serve.py imports this module, so the
reverse would be circular, and passing them in keeps this file testable
on its own with a fake index."""
import json
import os
import re

import llm
import tabular

SYSTEM_PROMPT = (
    "You are the data assistant inside Paras Health's SCM Gen-Dash, answering questions "
    "for the admin only. You have basic pharmacy/supply-chain knowledge (stock, reorder, "
    "expiry, consumption, GRN, MRP, formulary vs non-formulary, and similar terms), but for "
    "any question about this organisation's actual numbers you MUST use the tools -- never "
    "estimate, guess, or state a number you did not get from a tool result. "
    "Answer in as few words as possible: state the exact value, and nothing else unless the "
    "person asked for an explanation. No preamble, no restating the question, no 'based on the "
    "data'. If a tool result is ambiguous (several files could match, or the column name isn't "
    "clear), ask one short clarifying question instead of guessing. If nothing in the Data "
    "Library can answer the question, say so plainly instead of making a number up."
)

TOOLS = [
    {
        "name": "list_data_files",
        "description": (
            "Lists every file currently in the Shared Data Library, with its name and when it "
            "was last updated. Call this first when you don't already know the exact file name "
            "to use with look_up_column."
        ),
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "look_up_column",
        "description": (
            "Reads one column from one Data Library file (CSV or Excel) and computes sum, "
            "average, count, max, min, or a short list of its distinct values -- optionally "
            "only over rows where another column matches a given value. This is the only way "
            "to get a real number out of an uploaded register; never compute or estimate one "
            "yourself."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "file": {"type": "string", "description": "Part of the file's name, e.g. \"GRN\" or \"COGS July\"."},
                "column": {"type": "string", "description": "Part of the column header to read, e.g. \"Quantity\" or \"Net Amount\"."},
                "operation": {"type": "string", "enum": ["sum", "average", "count", "max", "min", "list_values"]},
                "filter_column": {"type": "string", "description": "Optional -- part of another column's header to filter by."},
                "filter_value": {"type": "string", "description": "Optional -- only rows whose filter_column contains this (case-insensitive) are included."},
            },
            "required": ["file", "column", "operation"],
        },
    },
]

MAX_TURNS = 6
_NUM_RE = re.compile(r"-?\d+(?:\.\d+)?")


def _to_number(cell):
    """Best-effort: strips currency symbols, commas, and surrounding text
    ('₹12,345.00', 'Rs. 500', '12 units') down to the first number in the
    cell. Returns None (not 0) for genuinely non-numeric cells, so those
    rows are excluded from sum/average/max/min rather than silently
    treated as zero."""
    m = _NUM_RE.search(str(cell).replace(",", ""))
    return float(m.group()) if m else None


def _find_column(header, needle):
    needle = needle.strip().lower()
    for i, name in enumerate(header):
        if needle in str(name).strip().lower():
            return i
    return None


def _tool_list_data_files(library_index):
    files = [{"name": f.get("name"), "updatedAt": f.get("updatedAt")} for f in library_index]
    files.sort(key=lambda f: f.get("updatedAt") or 0, reverse=True)
    return {"files": files}


def _tool_look_up_column(args, library_index, library_blobs_dir):
    query = (args.get("file") or "").strip().lower()
    matches = [f for f in library_index if query in (f.get("name") or "").lower()]
    if not matches:
        return {"error": "No Data Library file matches \"%s\". Call list_data_files to see what's there." % args.get("file")}
    if len(matches) > 1:
        return {"error": "Several files match \"%s\": %s -- ask which one." % (
            args.get("file"), ", ".join(f.get("name") or "" for f in matches[:8]))}

    entry = matches[0]
    blob_path = os.path.join(library_blobs_dir, entry.get("id") or "")
    if not os.path.exists(blob_path):
        return {"error": "That file's data is missing on disk."}

    try:
        rows = tabular.read_rows(blob_path, name_hint=entry.get("name") or "")
    except tabular.UnsupportedFormat:
        return {"error": "\"%s\" is an old-style .xls file -- re-save it as .xlsx or .csv and "
                          "re-upload before asking about it. CSV and .xlsx/.xlsm are supported." % entry.get("name")}
    if len(rows) < 2:
        return {"error": "\"%s\" has no readable rows." % entry.get("name")}
    header, data_rows = rows[0], rows[1:]

    col_idx = _find_column(header, args.get("column") or "")
    if col_idx is None:
        return {"error": "No column matching \"%s\" in \"%s\". Columns are: %s." % (
            args.get("column"), entry.get("name"), ", ".join(str(h) for h in header))}

    filter_idx = None
    if args.get("filter_column"):
        filter_idx = _find_column(header, args["filter_column"])
        if filter_idx is None:
            return {"error": "No column matching \"%s\" to filter by." % args["filter_column"]}

    filter_value = (args.get("filter_value") or "").strip().lower()
    selected = []
    for row in data_rows:
        if filter_idx is not None and filter_idx < len(row):
            if filter_value not in str(row[filter_idx]).strip().lower():
                continue
        elif filter_idx is not None:
            continue
        if col_idx < len(row):
            selected.append(row[col_idx])

    op = args.get("operation")
    if op == "count":
        return {"file": entry.get("name"), "column": header[col_idx], "matchedRows": len(selected), "result": len(selected)}
    if op == "list_values":
        seen, ordered = set(), []
        for v in selected:
            v = str(v).strip()
            if v and v not in seen:
                seen.add(v)
                ordered.append(v)
            if len(ordered) >= 25:
                break
        return {"file": entry.get("name"), "column": header[col_idx], "matchedRows": len(selected), "values": ordered}

    numbers = [n for n in (_to_number(v) for v in selected) if n is not None]
    if not numbers:
        return {"error": "No numeric values found in \"%s\" for the matched rows." % header[col_idx],
                "matchedRows": len(selected)}
    result = {"sum": sum, "average": lambda xs: sum(xs) / len(xs), "max": max, "min": min}[op](numbers)
    return {"file": entry.get("name"), "column": header[col_idx], "matchedRows": len(selected),
            "numericRows": len(numbers), "result": round(result, 4)}


def _run_tool(name, args, library_index, library_blobs_dir):
    if name == "list_data_files":
        return _tool_list_data_files(library_index)
    if name == "look_up_column":
        return _tool_look_up_column(args, library_index, library_blobs_dir)
    return {"error": "Unknown tool %s" % name}


def ask(question, library_index, library_blobs_dir):
    """Runs the tool-use loop to completion and returns (answer, error) --
    exactly one of the two is set. Never raises; a failure at any step
    (no API key, a network error, too many turns) comes back as `error`
    for the caller to show plainly rather than as an exception."""
    question = (question or "").strip()
    if not question:
        return None, "Ask something first."
    if not llm.llm_enabled():
        return None, "The assistant isn't set up yet -- see set_llm.py."

    messages = [{"role": "user", "content": question}]
    for _ in range(MAX_TURNS):
        response, err = llm.messages_create(messages, system=SYSTEM_PROMPT, tools=TOOLS, max_tokens=1024)
        if err:
            return None, err

        content = response.get("content") or []
        messages.append({"role": "assistant", "content": content})

        if response.get("stop_reason") != "tool_use":
            text = "".join(b.get("text", "") for b in content if b.get("type") == "text").strip()
            return (text or "No answer came back."), None

        results = []
        for block in content:
            if block.get("type") != "tool_use":
                continue
            output = _run_tool(block.get("name"), block.get("input") or {}, library_index, library_blobs_dir)
            results.append({"type": "tool_result", "tool_use_id": block.get("id"), "content": json.dumps(output)})
        messages.append({"role": "user", "content": results})

    return None, "Took too many steps to resolve -- try asking more specifically."
