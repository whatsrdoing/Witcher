"""Read a CSV or Excel file into rows of plain strings, stdlib only.

Excel files have no built-in Python reader -- normally that means
`openpyxl` or `pandas`, both pip installs. This app installs nothing
beyond the standard library anywhere else (mail.py, sync.py, serve.py
itself), so the assistant's ability to read a Data Library upload
shouldn't be the one place that changes. An .xlsx is just a zip archive
of XML files, and reading the first sheet's cell values back out of that
XML is well within reach of `zipfile` + `xml.etree` alone -- this reads
values only (no formatting, no formulas, no multi-sheet awareness beyond
"whichever sheet is first"), which is all a value-lookup needs.
"""
import csv
import io
import os
import re
import zipfile
import xml.etree.ElementTree as ET

XLSX_NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
COL_RE = re.compile(r"^([A-Z]+)")


def _col_to_index(ref):
    """'B7' -> 1 (zero-based column index)."""
    m = COL_RE.match(ref or "")
    if not m:
        return 0
    letters = m.group(1)
    n = 0
    for ch in letters:
        n = n * 26 + (ord(ch) - ord("A") + 1)
    return n - 1


def read_csv_rows(path, max_rows=20000):
    with open(path, encoding="utf-8-sig", errors="replace", newline="") as fh:
        reader = csv.reader(fh)
        rows = []
        for i, row in enumerate(reader):
            if i >= max_rows:
                break
            rows.append(row)
        return rows


def read_xlsx_rows(path, max_rows=20000):
    with zipfile.ZipFile(path) as zf:
        names = zf.namelist()
        sheet_name = next((n for n in names if n.startswith("xl/worksheets/sheet")), None)
        if not sheet_name:
            return []

        shared = []
        if "xl/sharedStrings.xml" in names:
            root = ET.fromstring(zf.read("xl/sharedStrings.xml"))
            for si in root.findall(XLSX_NS + "si"):
                # A shared string can be one <t> or several <r><t> runs -- join them.
                text = "".join(t.text or "" for t in si.iter(XLSX_NS + "t"))
                shared.append(text)

        root = ET.fromstring(zf.read(sheet_name))
        sheet_data = root.find(XLSX_NS + "sheetData")
        if sheet_data is None:
            return []

        rows = []
        for row_el in sheet_data.findall(XLSX_NS + "row"):
            if len(rows) >= max_rows:
                break
            cells = row_el.findall(XLSX_NS + "c")
            width = max((_col_to_index(c.get("r")) for c in cells), default=-1) + 1
            row = [""] * width
            for c in cells:
                idx = _col_to_index(c.get("r"))
                ctype = c.get("t")
                v_el = c.find(XLSX_NS + "v")
                if ctype == "s":
                    value = shared[int(v_el.text)] if v_el is not None and v_el.text else ""
                elif ctype == "inlineStr":
                    t_el = c.find(XLSX_NS + "is/" + XLSX_NS + "t")
                    value = t_el.text if t_el is not None else ""
                elif v_el is not None:
                    value = v_el.text or ""
                else:
                    value = ""
                row[idx] = value
            rows.append(row)
        return rows


class UnsupportedFormat(Exception):
    """Raised for a format this reads no rows from at all (currently just
    legacy .xls) -- distinct from a file that parsed fine but had no data,
    so callers can say why instead of just "nothing found"."""


def read_rows(path, name_hint="", max_rows=20000):
    """Picks CSV, XLSX, or legacy XLS by the file's actual name (a Data
    Library blob has no extension of its own -- the original filename
    lives in the index), not by sniffing content. Returns [] on a parse
    failure for a format that's otherwise supported -- a corrupt file
    should read as "no data found", never break the question it was asked
    as part of answering. Raises UnsupportedFormat for .xls specifically:
    that's a real binary format (OLE/BIFF8), not zip+XML like .xlsx, and
    guessing at a hand-rolled reader for it risks a wrong number for a
    tool whose entire point is exact ones -- refusing outright is safer
    than a plausible-looking mistake."""
    ext = os.path.splitext(name_hint)[1].lower()
    if ext == ".xls":
        raise UnsupportedFormat(name_hint)
    try:
        if ext in (".xlsx", ".xlsm"):
            return read_xlsx_rows(path, max_rows)
        return read_csv_rows(path, max_rows)
    except (OSError, ValueError, KeyError, zipfile.BadZipFile, ET.ParseError):
        return []
