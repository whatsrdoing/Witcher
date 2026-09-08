# HIS Inventory Register Export Bot

Automates the *manual* steps of logging into the HIS through its normal
login page and clicking the page's own **Export** button — it does not
scrape data or bypass any access control.

## Before you run this

- Get written authorization from whoever owns security/compliance
  decisions at your hospital for automating this account's access.
- Never commit `.env` or paste its contents anywhere (chat, tickets,
  logs). It's already git-ignored.
- If the login has MFA/OTP, this script will stop at that step — run
  with `HEADFUL=true` and complete it by hand, or extend the script.

## Setup

```bash
cd his-report-bot
npm install
npx playwright install chromium
cp .env.example .env
```

Edit `.env` with the real base URL, register path, username, and
password.

Open the selectors in `download-report.js` (`SELECTORS` object) and
replace the placeholders with the real element selectors from the
login form and the Export button — right-click each element in Chrome
DevTools → Inspect → copy a stable selector (id, name, or
`data-testid`).

## Run

```bash
npm run download
```

The exported file is saved to `./downloads` (configurable via
`DOWNLOAD_DIR`), prefixed with a timestamp.

## Scheduling

Once the selectors are confirmed working, run it on a schedule with
cron (Linux/macOS) or Task Scheduler (Windows), e.g.:

```
0 7 * * * cd /path/to/his-report-bot && npm run download >> run.log 2>&1
```
