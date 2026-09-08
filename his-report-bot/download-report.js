/**
 * Logs into the HIS through its normal UI and clicks the page's own
 * Export button to download the Inventory Registers report.
 *
 * This does NOT scrape or bypass any access control — it drives the
 * browser the same way a human user would, using credentials the
 * account already has. Only run this against a system you are
 * authorized (in writing, by whoever owns that decision) to automate.
 *
 * Setup:
 *   1. npm install
 *   2. npx playwright install chromium
 *   3. cp .env.example .env   and fill in real values (never commit .env)
 *   4. Fill in the selector placeholders below to match the real page
 *      (open the site, right-click each element -> Inspect -> copy a
 *      stable selector, e.g. an id, name, or data-testid attribute).
 *   5. node download-report.js
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
require('dotenv').config();

const {
  HIS_BASE_URL,
  HIS_REGISTER_PATH,
  HIS_USERNAME,
  HIS_PASSWORD,
  DOWNLOAD_DIR = './downloads',
  HEADFUL = 'false',
} = process.env;

function requireEnv(name, value) {
  if (!value) {
    throw new Error(`Missing required env var: ${name}. Copy .env.example to .env and fill it in.`);
  }
  return value;
}

// ---- Fill these in to match the real login form and export button ----
const SELECTORS = {
  usernameInput: '#username',       // e.g. input[name="username"]
  passwordInput: '#password',       // e.g. input[name="password"]
  loginButton: 'button[type="submit"]',
  // Something on the post-login page that proves the login worked
  loggedInMarker: 'text=Dashboard',
  exportButton: 'text=Export',
  // If clicking Export opens a submenu (e.g. "Export as Excel"), set this too
  exportFormatOption: null,         // e.g. 'text=Excel', or null if not needed
};
// ------------------------------------------------------------------------

async function main() {
  requireEnv('HIS_BASE_URL', HIS_BASE_URL);
  requireEnv('HIS_USERNAME', HIS_USERNAME);
  requireEnv('HIS_PASSWORD', HIS_PASSWORD);

  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: HEADFUL !== 'true' });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();

  try {
    await page.goto(HIS_BASE_URL, { waitUntil: 'domcontentloaded' });

    await page.fill(SELECTORS.usernameInput, HIS_USERNAME);
    await page.fill(SELECTORS.passwordInput, HIS_PASSWORD);
    await page.click(SELECTORS.loginButton);

    // If the account uses MFA/OTP, this script stops here — handle that
    // step manually (run with HEADFUL=true) or extend this with your
    // own MFA flow before automating further.
    await page.waitForSelector(SELECTORS.loggedInMarker, { timeout: 30000 });

    const registerUrl = new URL(HIS_REGISTER_PATH || '/InventoryRegisters', HIS_BASE_URL).toString();
    await page.goto(registerUrl, { waitUntil: 'domcontentloaded' });

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.click(SELECTORS.exportButton),
      SELECTORS.exportFormatOption
        ? page.click(SELECTORS.exportFormatOption)
        : Promise.resolve(),
    ]);

    const suggested = download.suggestedFilename();
    const stamped = `${new Date().toISOString().replace(/[:.]/g, '-')}_${suggested}`;
    const savePath = path.join(DOWNLOAD_DIR, stamped);
    await download.saveAs(savePath);

    console.log(`Saved report to ${savePath}`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('Failed to download report:', err.message);
  process.exit(1);
});
