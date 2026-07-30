/**
 * Shared eMoviePoster login/session module — used by both
 * emovieposter_scraper.ts (historical sales, needs login) and
 * emovieposter_current_auctions.ts does NOT use this (no login needed).
 *
 * Login form confirmed via screenshot (logged-out state): "Username" (not
 * email) + "Password" labels each directly beside their input, a "Log-in"
 * button, and a "Keep me logged in on this device" checkbox. No raw
 * HTML/id attributes confirmed — uses label-anchored XPath locators as a
 * resilient stand-in. If fragile in practice, get the raw <input> HTML for
 * an exact-selector fallback.
 */

import type { BrowserContext, Page } from "playwright";
import { promises as fs } from "fs";
import path from "path";
import { isBlockPage } from "./scrape-core";

export const ARCHIVE_BASE_URL = "https://www.emovieposter.com";
const LOGIN_URL = "https://www.emovieposter.com/login"; // TODO: confirm actual login path

const STATE_DIR = path.resolve(process.cwd(), ".scraper-state");
export const STORAGE_STATE_PATH = path.join(STATE_DIR, "emovieposter-session.json");

async function login(page: Page): Promise<void> {
  const username = process.env.EMOVIEPOSTER_USERNAME;
  const password = process.env.EMOVIEPOSTER_PASSWORD;
  if (!username || !password) {
    throw new Error("Missing EMOVIEPOSTER_USERNAME / EMOVIEPOSTER_PASSWORD env vars");
  }

  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });

  const usernameInput = page.locator("xpath=//*[contains(text(), 'Username')]/following::input[1]");
  const passwordInput = page.locator("xpath=//*[contains(text(), 'Password')]/following::input[1]");
  const keepLoggedInCheckbox = page.locator("xpath=//*[contains(text(), 'Keep me logged in')]/preceding::input[@type='checkbox'][1]");
  const loginButton = page.locator("text=Log-in").first();

  await usernameInput.fill(username);
  await passwordInput.fill(password);

  const hasKeepLoggedIn = (await keepLoggedInCheckbox.count()) > 0;
  if (hasKeepLoggedIn) {
    const isChecked = await keepLoggedInCheckbox.isChecked().catch(() => false);
    if (!isChecked) await keepLoggedInCheckbox.check().catch(() => {});
  }

  await loginButton.click();
  await page.waitForLoadState("networkidle");

  if (await isBlockPage(page)) {
    throw new Error("Hit a block/CAPTCHA page during login — stopping.");
  }
}

export async function ensureLoggedIn(context: BrowserContext, page: Page): Promise<void> {
  const hasSavedSession = await fs
    .access(STORAGE_STATE_PATH)
    .then(() => true)
    .catch(() => false);

  if (hasSavedSession) {
    await page.goto(`${ARCHIVE_BASE_URL}/account`, { waitUntil: "domcontentloaded" });
    // TODO: replace with a real "am I logged in" check once selectors are known
    const stillLoggedIn = !(await isBlockPage(page)) && !page.url().includes("/login");
    if (stillLoggedIn) {
      console.log("Reusing saved session — skipping login.");
      return;
    }
    console.log("Saved session expired, logging in fresh.");
  }

  await login(page);
  await context.storageState({ path: STORAGE_STATE_PATH });
}
