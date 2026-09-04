/* GENERATED FILE — do not edit.
   Source: dashboards.json   Regenerate: python3 sync.py
   This mirror only exists so index.html also works from file://. */
window.__PARAS_REGISTRY__ = {
  "$comment": "PARAS HEALTH — SUPPLY CHAIN COMMAND CENTRE registry. This is the ONLY file you edit to add a dashboard. See docs/ADDING_A_DASHBOARD.md.",
  "schema": 1,
  "app": {
    "org": "PARAS HEALTH",
    "title": "SCM Gen-Dash",
    "tagline": "Offline workspace for supply chain, procurement and pharmacy intelligence",
    "defaultMode": "local",
    "defaultTheme": "dark"
  },
  "categories": [
    {
      "id": "procurement",
      "name": "Procurement",
      "icon": "cart",
      "accent": "#4E86E0",
      "order": 1
    },
    {
      "id": "pharmacy",
      "name": "Pharmacy",
      "icon": "pill",
      "accent": "#2DD4BF",
      "order": 2
    },
    {
      "id": "inventory",
      "name": "Inventory",
      "icon": "boxes",
      "accent": "#A78BFA",
      "order": 3
    },
    {
      "id": "vendor",
      "name": "Vendor",
      "icon": "handshake",
      "accent": "#F0A93B",
      "order": 4
    },
    {
      "id": "governance",
      "name": "Governance",
      "icon": "shield",
      "accent": "#7FB2F0",
      "order": 5
    },
    {
      "id": "audit",
      "name": "Audit",
      "icon": "clipboard",
      "accent": "#FB7185",
      "order": 6
    },
    {
      "id": "reports",
      "name": "Reports",
      "icon": "chart",
      "accent": "#34D399",
      "order": 7
    },
    {
      "id": "other",
      "name": "Other",
      "icon": "grid",
      "accent": "#7B8792",
      "order": 8
    },
    {
      "id": "admin",
      "name": "Admin Tools",
      "icon": "folder",
      "accent": "#5B8DEF",
      "order": 9
    }
  ],
  "dashboards": [
    {
      "id": "data-library",
      "name": "Data Library",
      "category": "admin",
      "description": "Drop every register here once — CSV or Excel. The Command Centre reads each file's columns, offers it to every dashboard that needs it, and files it month-by-month into the shared database.",
      "file": "dashboards/Data_Library.html",
      "icon": "folder",
      "status": "live",
      "order": 1,
      "adminOnly": true,
      "tags": [
        "upload",
        "import",
        "registers",
        "files",
        "database"
      ]
    },
    {
      "id": "procurement-operations",
      "name": "Procurement Operations",
      "category": "procurement",
      "description": "Purchase orders, GRN cycle times, fill rates and spend across the procurement pipeline.",
      "file": "dashboards/Procurement_Dashboard.html",
      "icon": "cart",
      "status": "live",
      "order": 1,
      "tags": [
        "PO",
        "GRN",
        "spend",
        "fill rate"
      ],
      "inputs": [
        {
          "label": "Purchase Register",
          "match": [
            "purchase\\s*register",
            "\\bpr\\b"
          ],
          "needs": [
            "UNIT",
            "Item Code",
            "PO No",
            "Status"
          ]
        },
        {
          "label": "GRN Register",
          "match": [
            "\\bgrn\\b"
          ],
          "needs": [
            "UNIT",
            "Item Code",
            "Received Qty.",
            "GRN No."
          ]
        }
      ]
    },
    {
      "id": "rate-mrp-variance",
      "name": "Rate & MRP Variance",
      "category": "procurement",
      "description": "Rate contract adherence, purchase rate drift and MRP variance exception tracking.",
      "file": "dashboards/Procurement_Rate_MRP_Variance_Dashboard.html",
      "icon": "trending",
      "status": "live",
      "order": 2,
      "tags": [
        "rate contract",
        "MRP",
        "variance",
        "pricing"
      ],
      "inputs": [
        {
          "label": "RC rate file",
          "match": [
            "rc\\s*rate",
            "rate\\s*contract",
            "\\brc\\b"
          ],
          "needs": [
            "RC Rate"
          ],
          "optional": true
        },
        {
          "label": "GRN Register",
          "match": [
            "\\bgrn\\b"
          ],
          "needs": [
            "UNIT",
            "Item Code",
            "Item Name",
            "Item Category",
            "Received Qty.",
            "EPR",
            "MRP",
            "Total Value",
            "GRN No.",
            "GRN Date"
          ]
        }
      ]
    },
    {
      "id": "pharmacy-console",
      "name": "Formulary Compliance & Savings",
      "category": "pharmacy",
      "description": "Actual consumption valued against the 2025-26 weighted average — formulary compliance and realised savings.",
      "file": "dashboards/Pharmacy_Console.html",
      "icon": "pill",
      "status": "live",
      "order": 1,
      "tags": [
        "formulary",
        "compliance",
        "savings",
        "COGS"
      ],
      "inputs": [
        {
          "label": "COGS",
          "match": [
            "cogs",
            "consumption"
          ],
          "needs": [
            "UNIT",
            "Item Id",
            "Qty",
            "Ispackage",
            "Total EPR",
            "Total MRP"
          ],
          "keep": [
            "UNIT",
            "Item Id",
            "Ispackage",
            "Item Name",
            "Item Category Name",
            "Item Sub Category Name",
            "Department Name",
            "Generic Name",
            "Qty",
            "Total EPR",
            "Total Unit Cost",
            "Total MRP"
          ]
        },
        {
          "label": "Benchmark sheet",
          "match": [
            "benchmark",
            "weighted"
          ],
          "needs": [],
          "optional": true
        }
      ]
    },
    {
      "id": "pharmacy-space-calculator",
      "name": "Pharmacy Space Calculator",
      "category": "pharmacy",
      "description": "Bed count → total pharmacy area and store-wise space breakdown, with a basic floor layout. No file upload — enter a bed count and it calculates.",
      "file": "dashboards/Pharmacy_Area_Dashboard.html",
      "icon": "grid",
      "status": "live",
      "order": 3,
      "tags": [
        "space",
        "area",
        "floorplan",
        "layout",
        "calculator",
        "beds"
      ]
    },
    {
      "id": "non-formulary-utilisation",
      "name": "Non-Formulary Utilisation",
      "category": "pharmacy",
      "description": "Non-formulary item utilisation, leakage hotspots and substitution opportunities.",
      "file": "dashboards/Non_Formulary_Dashboard.html",
      "icon": "flask",
      "status": "live",
      "order": 2,
      "tags": [
        "non-formulary",
        "utilisation",
        "leakage"
      ],
      "inputs": [
        {
          "label": "Non-Formulary List",
          "match": [
            "non\\s*formulary",
            "item\\s*master",
            "item\\s*list"
          ],
          "needs": [
            "ItemId",
            "ITEM NAME",
            "ITEM CODE"
          ]
        },
        {
          "label": "Stock Transfer",
          "match": [
            "stock\\s*transfer",
            "store\\s*transfer",
            "\\btransfer\\b"
          ],
          "needs": [
            "UNIT",
            "From Store",
            "To Store",
            "Item Code",
            "Transfered Qty."
          ]
        },
        {
          "label": "IP Issue",
          "match": [
            "ip\\s*issue",
            "\\bissue\\b"
          ],
          "needs": [
            "UNIT",
            "Item Code",
            "Department Name",
            "Qty"
          ]
        },
        {
          "label": "GRN Register",
          "match": [
            "\\bgrn\\b"
          ],
          "needs": [
            "UNIT",
            "Store",
            "Item Code",
            "Received Qty.",
            "GRN No."
          ]
        },
        {
          "label": "Purchase Register",
          "match": [
            "purchase\\s*register",
            "\\bpr\\b"
          ],
          "needs": [
            "UNIT",
            "Store Name",
            "Item Code",
            "PO No",
            "Status"
          ]
        }
      ]
    },
    {
      "id": "store-transfer",
      "name": "Store Transfer",
      "category": "inventory",
      "description": "Store-to-store transfer movement, ageing and settlement between units.",
      "file": "dashboards/Store_Transfer_Dashboard.html",
      "icon": "truck",
      "status": "live",
      "order": 1,
      "tags": [
        "transfer",
        "inter-store",
        "movement"
      ],
      "inputs": [
        {
          "label": "Stock Transfer",
          "match": [
            "stock\\s*transfer",
            "store\\s*transfer",
            "\\btransfer\\b"
          ],
          "needs": [
            "Transfer Date",
            "From Store",
            "To Store",
            "Item Name",
            "Transfered Qty.",
            "EPR."
          ],
          "keep": [
            "UNIT",
            "Transfer Date",
            "From Store",
            "To Store",
            "Item Name",
            "Item Code",
            "Transfered Qty.",
            "EPR."
          ],
          "auto": false
        },
        {
          "label": "Stock Transfer",
          "match": [
            "stock\\s*transfer",
            "store\\s*transfer",
            "\\btransfer\\b"
          ],
          "needs": [
            "Transfer Date",
            "From Store",
            "To Store",
            "Item Name",
            "Transfered Qty.",
            "EPR."
          ],
          "keep": [
            "UNIT",
            "Transfer Date",
            "From Store",
            "To Store",
            "Item Name",
            "Item Code",
            "Transfered Qty.",
            "EPR."
          ],
          "auto": false
        }
      ]
    },
    {
      "id": "employee-permissions",
      "name": "SCM Employee Permissions",
      "category": "governance",
      "description": "Role and permission matrix for supply chain users — module access, report rights and approval limits across units.",
      "file": "dashboards/SCM_Employee_Permission_Dashboard.html",
      "icon": "users",
      "status": "live",
      "order": 1,
      "tags": [
        "roles",
        "access",
        "permissions",
        "SOD",
        "approval"
      ],
      "inputs": [
        {
          "label": "Permission file",
          "match": [
            "permission",
            "rights",
            "role"
          ],
          "needs": [],
          "auto": false
        }
      ]
    },
    {
      "id": "rtv-repurchase",
      "name": "RTV & Repurchase",
      "category": "vendor",
      "description": "Returns to vendor matched against later GRNs — what went back, what was bought again, and the spend that round trip cost.",
      "file": "dashboards/RTV_Repurchase_Dashboard.html",
      "icon": "handshake",
      "status": "live",
      "order": 1,
      "tags": [
        "RTV",
        "return to vendor",
        "GRN",
        "repurchase"
      ],
      "inputs": [
        {
          "label": "RTV Report",
          "match": [
            "\\brtv\\b",
            "return\\s*to\\s*vendor",
            "\\breturn\\s*register\\b"
          ],
          "needs": [
            "UNIT",
            "Return No",
            "Return Date",
            "Item Code",
            "Return Qty.",
            "Supplier Name"
          ]
        },
        {
          "label": "GRN Register",
          "match": [
            "\\bgrn\\b"
          ],
          "needs": [
            "GRN No.",
            "GRN Date",
            "Item Code",
            "Received Qty.",
            "Total Value",
            "Supplier Name"
          ]
        }
      ]
    },
    {
      "id": "local-purchase",
      "name": "Local Purchase",
      "category": "procurement",
      "description": "Local and emergency purchases outside the rate contract — by-unit spend, approval slabs, PO cross-checks, expiry exposure and repeat-purchase flags.",
      "file": "dashboards/Local_Purchase_Dashboard.html",
      "icon": "handshake",
      "status": "live",
      "order": 3,
      "tags": [
        "local",
        "emergency",
        "LP",
        "vendor",
        "GRN",
        "approval"
      ],
      "inputs": [
        {
          "label": "GRN Register",
          "match": [
            "\\bgrn\\b"
          ],
          "needs": [
            "UNIT",
            "GRN No.",
            "GRN Date",
            "Item Code",
            "Item Name",
            "PO No.",
            "Supplier Name",
            "Received Qty.",
            "EPR"
          ]
        },
        {
          "label": "Purchase Register",
          "match": [
            "purchase\\s*register",
            "\\bpr\\b"
          ],
          "needs": [
            "UNIT",
            "PO No",
            "PO Date",
            "Item Code",
            "Status"
          ]
        }
      ]
    },
    {
      "id": "data-health-check",
      "name": "Data Health Check",
      "category": "admin",
      "description": "Runs every register you have through generic quality checks — exact duplicate rows, blank or inconsistent columns, unreadable or out-of-range dates, negative or outlier numbers — before any of it reaches a dashboard.",
      "file": "dashboards/Data_Health_Check_Dashboard.html",
      "icon": "check",
      "status": "live",
      "order": 2,
      "adminOnly": true,
      "tags": [
        "quality",
        "cleansing",
        "duplicates",
        "anomaly",
        "audit",
        "validation"
      ],
      "inputs": [
        {
          "label": "GRN Register",
          "match": [
            "\\bgrn\\b"
          ],
          "needs": [
            "UNIT",
            "Item Code",
            "Received Qty.",
            "GRN No."
          ],
          "optional": true
        },
        {
          "label": "Purchase Register",
          "match": [
            "purchase\\s*register",
            "\\bpr\\b"
          ],
          "needs": [
            "UNIT",
            "Item Code",
            "PO No",
            "Status"
          ],
          "optional": true
        },
        {
          "label": "COGS",
          "match": [
            "cogs",
            "consumption"
          ],
          "needs": [
            "UNIT",
            "Item Id",
            "Qty",
            "Total EPR",
            "Total MRP"
          ],
          "optional": true
        },
        {
          "label": "Stock Transfer",
          "match": [
            "stock\\s*transfer",
            "store\\s*transfer",
            "\\btransfer\\b"
          ],
          "needs": [
            "UNIT",
            "From Store",
            "To Store",
            "Item Code",
            "Transfered Qty."
          ],
          "optional": true
        },
        {
          "label": "RTV Register",
          "match": [
            "\\brtv\\b",
            "return\\s*to\\s*vendor",
            "\\breturn\\s*register\\b"
          ],
          "needs": [
            "UNIT",
            "Return No",
            "Return Date",
            "Item Code",
            "Supplier Name"
          ],
          "optional": true
        },
        {
          "label": "Non-Formulary List",
          "match": [
            "non\\s*formulary"
          ],
          "needs": [
            "ItemId",
            "ITEM NAME",
            "ITEM CODE"
          ],
          "optional": true
        },
        {
          "label": "Formulary List",
          "match": [
            "\\bformulary\\s*(item\\s*)?list\\b"
          ],
          "needs": [
            "ItemId",
            "ITEM NAME",
            "ITEM CODE"
          ],
          "optional": true
        },
        {
          "label": "Expiry Stock",
          "match": [
            "expiry\\s*stock",
            "\\bexpiry\\b"
          ],
          "needs": [],
          "optional": true
        },
        {
          "label": "Non Moving",
          "match": [
            "non\\s*moving",
            "slow\\s*moving"
          ],
          "needs": [],
          "optional": true
        },
        {
          "label": "SCM Employee / Permissions",
          "match": [
            "scm\\s*employee",
            "permission",
            "\\brole\\b"
          ],
          "needs": [],
          "optional": true
        }
      ]
    },
    {
      "id": "scm-audit",
      "name": "Full SCM Audit",
      "category": "audit",
      "description": "End-to-end supply chain audit trail — indent to issue, with exceptions flagged at each hop.",
      "file": "",
      "icon": "shield",
      "status": "planned",
      "order": 4,
      "tags": [
        "audit",
        "trail",
        "exceptions",
        "compliance"
      ],
      "inputs": []
    },
    {
      "id": "item-consumption",
      "name": "Item Consumption",
      "category": "pharmacy",
      "description": "Item-level consumption across units and months — movement, seasonality and reorder signals.",
      "file": "",
      "icon": "chart",
      "status": "planned",
      "order": 5,
      "tags": [
        "consumption",
        "usage",
        "movement",
        "reorder"
      ],
      "inputs": []
    },
    {
      "id": "top-50-items",
      "name": "Top 50 Items",
      "category": "pharmacy",
      "description": "The fifty items driving the most spend and movement, and how that list shifts month to month.",
      "file": "",
      "icon": "trending",
      "status": "planned",
      "order": 6,
      "tags": [
        "top 50",
        "ABC",
        "spend",
        "movement"
      ],
      "inputs": []
    },
    {
      "id": "expiry-stock",
      "name": "Expiry Stock",
      "category": "inventory",
      "description": "Stock approaching expiry by unit and batch — value at risk and the window left to act.",
      "file": "",
      "icon": "warn",
      "status": "planned",
      "order": 7,
      "tags": [
        "expiry",
        "batch",
        "near expiry",
        "write-off"
      ],
      "inputs": []
    },
    {
      "id": "non-moving",
      "name": "Non Moving",
      "category": "inventory",
      "description": "Items with no movement over the period — where working capital is sitting still.",
      "file": "",
      "icon": "boxes",
      "status": "planned",
      "order": 8,
      "tags": [
        "non moving",
        "slow moving",
        "dead stock",
        "ageing"
      ],
      "inputs": []
    }
  ],
  "datasets": [
    {
      "id": "cogs",
      "name": "COGS",
      "hint": "Cost of goods sold / consumption valuation",
      "needs": [
        "UNIT",
        "Item Id",
        "Qty",
        "Ispackage",
        "Total EPR",
        "Total MRP"
      ],
      "parts": [
        {
          "id": "dept",
          "name": "Department Consumption"
        },
        {
          "id": "ip",
          "name": "IP Pharmacy"
        },
        {
          "id": "op",
          "name": "OP Pharmacy"
        }
      ]
    },
    {
      "id": "grn-register",
      "name": "GRN Register",
      "hint": "Goods receipt notes",
      "needs": [
        "UNIT",
        "Item Code",
        "Received Qty.",
        "GRN No."
      ]
    },
    {
      "id": "rtv-register",
      "name": "RTV / Return to Vendor",
      "hint": "Returns raised back to suppliers",
      "needs": [
        "UNIT",
        "Return No",
        "Return Date",
        "Item Code",
        "Return Qty."
      ]
    },
    {
      "id": "purchase-register",
      "name": "Purchase Register",
      "hint": "Purchase orders and receipts",
      "needs": [
        "UNIT",
        "Item Code",
        "PO No",
        "Status"
      ]
    },
    {
      "id": "stock-transfer",
      "name": "Stock Transfer",
      "hint": "Store-to-store movement (STRPIR)",
      "needs": [
        "UNIT",
        "From Store",
        "To Store",
        "Item Code",
        "Transfered Qty."
      ]
    },
    {
      "id": "scm-employee",
      "name": "SCM Employee",
      "hint": "Roles, permissions and approval limits",
      "needs": []
    },
    {
      "id": "non-formulary",
      "name": "Non Formulary Item List",
      "hint": "Items outside the formulary",
      "needs": [
        "ItemId",
        "ITEM NAME",
        "ITEM CODE"
      ]
    },
    {
      "id": "formulary",
      "name": "Formulary Item List",
      "hint": "Approved formulary items",
      "needs": [
        "ItemId",
        "ITEM NAME",
        "ITEM CODE"
      ]
    },
    {
      "id": "expiry-stock",
      "name": "Expiry Stock",
      "hint": "Batch-wise stock nearing expiry",
      "needs": []
    },
    {
      "id": "non-moving",
      "name": "Non Moving",
      "hint": "Items with no movement in the period",
      "needs": []
    }
  ]
};
