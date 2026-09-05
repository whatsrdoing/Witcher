import os, sys, csv, tempfile, shutil, sqlite3
sys.path.insert(0, '/home/user/Witcher')
import datastore

bad = 0
def check(name, cond, extra=""):
    global bad
    print(("  PASS  " if cond else "  FAIL  ") + name + (("  " + str(extra)) if extra and not cond else ""))
    if not cond: bad += 1

tmp = tempfile.mkdtemp()
def csvfile(name, rows, hdr):
    p = os.path.join(tmp, name)
    with open(p, "w", newline="") as f:
        w = csv.writer(f); w.writerow(hdr)
        for r in rows: w.writerow(r)
    return p

HDR = ["UNIT", "Item Code", "Qty", "Value"]
dept = csvfile("dept.csv", [["Panipat", "IT%03d" % i, i, i*10] for i in range(1, 11)], HDR)
ip   = csvfile("ip.csv",   [["Panipat", "IP%03d" % i, i, i*20] for i in range(1, 6)],  HDR)
op   = csvfile("op.csv",   [["Panipat", "OP%03d" % i, i, i*30] for i in range(1, 8)],  HDR)

print("\n-- three parts of one month --")
db = os.path.join(tmp, "a.db")
st = datastore.DataStore(db)
st.import_csv(dept, "cogs", "2026-07", source="dept.csv", part="dept")
st.import_csv(ip,   "cogs", "2026-07", source="ip.csv",   part="ip")
st.import_csv(op,   "cogs", "2026-07", source="op.csv",   part="op")
check("all three parts add up, none replaced", st.count("cogs") == 22, st.count("cogs"))
ds = st.datasets()[0]
check("they report as ONE month, not three", len(ds["periods"]) == 1, len(ds["periods"]))
check("that month lists its three parts", len(ds["periods"][0]["parts"]) == 3)
check("the month total is the sum", ds["periods"][0]["rows"] == 22, ds["periods"][0]["rows"])

print("\n-- re-uploading one part replaces only that part --")
ip2 = csvfile("ip2.csv", [["Panipat", "IPNEW%03d" % i, i, i*20] for i in range(1, 4)], HDR)
st.import_csv(ip2, "cogs", "2026-07", source="ip2.csv", part="ip")
check("total reflects the smaller replacement", st.count("cogs") == 20, st.count("cogs"))
rows = list(st.rows("cogs"))
codes = [r[rows[0].index("Item_Code")] for r in rows[1:]]
check("the old IP rows are gone", not any(c.startswith("IP0") for c in codes))
check("the new IP rows are in", sum(c.startswith("IPNEW") for c in codes) == 3)
check("dept was left alone", sum(c.startswith("IT") for c in codes) == 10)
check("op was left alone", sum(c.startswith("OP") for c in codes) == 7)

print("\n-- a part can be dropped on its own --")
st.drop("cogs", "2026-07", part="op")
check("only that part went", st.count("cogs") == 13, st.count("cogs"))
check("the month is still there", len(st.datasets()[0]["periods"]) == 1)
check("two parts remain", len(st.datasets()[0]["periods"][0]["parts"]) == 2)
st.close()

print("\n-- a register with no parts behaves exactly as before --")
db2 = os.path.join(tmp, "b.db")
st = datastore.DataStore(db2)
st.import_csv(dept, "grn", "2026-07", source="jul.csv")
st.import_csv(ip,   "grn", "2026-07", source="jul-again.csv")
check("re-import still replaces the month", st.count("grn") == 5, st.count("grn"))
st.close()

print("\n-- upgrading a database written before parts existed --")
db3 = os.path.join(tmp, "old.db")
con = sqlite3.connect(db3)
con.execute("CREATE TABLE _imports (dataset TEXT, period TEXT, source TEXT, rows INTEGER,"
            " columns INTEGER, imported_at INTEGER, PRIMARY KEY (dataset, period))")
con.execute("CREATE TABLE ds_purchase_register (_period TEXT, _source TEXT, _rowno INTEGER,"
            ' "UNIT" TEXT, "Item_Code" TEXT)')
for i in range(1, 34):
    con.execute("INSERT INTO ds_purchase_register VALUES (?,?,?,?,?)",
                ("2026-07", "PURCHASE REGISTER JULY 26 ALL.csv", i, "Panipat", "OLD%03d" % i))
con.execute("INSERT INTO _imports VALUES ('purchase-register','2026-07',"
            "'PURCHASE REGISTER JULY 26 ALL.csv',33,5,1)")
con.commit(); con.close()

st = datastore.DataStore(db3)                      # migration runs on open
check("existing rows survived the upgrade", st.count("purchase-register") == 33, st.count("purchase-register"))
d = st.datasets()[0]
check("the existing month is still listed", d["periods"][0]["period"] == "2026-07")
check("it reports as the unnamed part", d["periods"][0]["parts"][0]["part"] == "")
check("its source is intact", "PURCHASE REGISTER" in d["periods"][0]["source"])
# and new part-aware imports still work on the upgraded table
st.import_csv(ip, "purchase-register", "2026-08", source="aug.csv", part="")
check("a new month imports into the upgraded table", st.count("purchase-register") == 38, st.count("purchase-register"))
cols = [r[1] for r in st.con.execute("PRAGMA table_info(ds_purchase_register)")]
check("_part column was added", "_part" in cols)
st.close()

st = datastore.DataStore(db3)                      # opening twice must be safe
check("re-opening does not re-migrate or lose rows", st.count("purchase-register") == 38)
st.close()

shutil.rmtree(tmp)
print("\n%s" % ("%d FAILURE(S)" % bad if bad else "all part checks passed"))
sys.exit(1 if bad else 0)
