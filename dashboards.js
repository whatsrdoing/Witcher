/* GENERATED FILE — do not edit.
   Source: dashboards.json   Regenerate: python3 sync.py
   This mirror only exists so index.html also works from file://. */
window.__PARAS_REGISTRY__ = {
  "$comment": "PARAS HEALTH — SUPPLY CHAIN COMMAND CENTRE registry. This is the ONLY file you edit to add a dashboard. See docs/ADDING_A_DASHBOARD.md.",
  "schema": 1,
  "app": {
    "org": "PARAS HEALTH",
    "title": "Supply Chain Command Centre",
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
    }
  ],
  "dashboards": [
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
            "Transfer Date",
            "From Store",
            "To Store",
            "Item Name",
            "Transfered Qty.",
            "EPR."
          ]
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
    }
  ]
};
