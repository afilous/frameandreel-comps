# Setup Guide — Poster Comps Scrapers

This walks through getting everything running from scratch: GitHub repo, secrets, Supabase credentials, and how to actually trigger a run. Follow in order the first time; after that you'll mostly just use the "Run a scrape" section.

---

## Part 1 — GitHub repo setup

### 1.1 Create (or choose) the repo

If this is going in its own repo:
1. Go to **github.com** → click the **+** icon (top right) → **New repository**
2. Name it (e.g. `frameandreel-comps`), leave it **Private**, don't initialize with a README (you'll push existing files)
3. Click **Create repository**

If you're adding this into an existing repo (e.g. `afilous/Frameandreel`), just put these files in a subfolder there instead — skip to 1.2.

### 1.2 Push the files

On your own machine, in a terminal:

```bash
cd path/to/where/you/saved/these/files
git init                                    # skip if adding to an existing repo
git add .
git commit -m "Add poster comps scrapers"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/frameandreel-comps.git
git push -u origin main
```

(Replace the URL with your actual repo's URL — GitHub shows it right after you create the repo, under "…or push an existing repository from the command line.")

### 1.3 Add repository secrets

This is how the scrapers get credentials without them ever being visible in your code.

1. On your repo's GitHub page, click **Settings** (top tab bar)
2. In the left sidebar: **Secrets and variables** → **Actions**
3. Click **New repository secret** for each of these, one at a time (name exactly as shown, value is yours to fill in):

| Secret name | Value | Needed for |
|---|---|---|
| `EMOVIEPOSTER_USERNAME` | your eMoviePoster login username | historical scraper |
| `EMOVIEPOSTER_PASSWORD` | your eMoviePoster login password | historical scraper |
| `SUPABASE_URL` | `https://vojshqdxkdvzowdsucjk.supabase.co` | historical scraper (watchlist) |
| `SUPABASE_ANON_KEY` | from Supabase — see Part 2 below | historical scraper (watchlist) |

Not needed yet (only add when you actually use these):

| Secret name | Needed for |
|---|---|
| `FRAMEANDREEL_INGEST_URL` | writing results into YouBase (doesn't exist yet) |
| `FRAMEANDREEL_INGEST_URL_CURRENT_AUCTIONS` | same, for current-auctions results |
| `FRAMEANDREEL_INGEST_KEY` | same |
| `GEMINI_API_KEY` | the Gemini ballpark-estimate tool |
| `EBAY_APP_ID` / `EBAY_CLIENT_SECRET` | eBay comps tool |

Each one: paste the name, paste the value, click **Add secret**. That's it — GitHub never shows the value again after you save it (that's intentional).

---

## Part 2 — Supabase credentials

You already have the project (`Frame_and_reel_valuation_Database`). You just need to copy two values out of it.

1. Go to **supabase.com** → log in → open the **Frame_and_reel_valuation_Database** project
2. Left sidebar → **Project Settings** (gear icon, near the bottom) → **API**
3. You'll see:
   - **Project URL** — copy this, it's your `SUPABASE_URL` (should match `https://vojshqdxkdvzowdsucjk.supabase.co`)
   - **Project API keys** → the one labeled **`anon` `public`** — copy this, it's your `SUPABASE_ANON_KEY`
   - (Ignore the `service_role` key — don't use that one here, it has full admin access and shouldn't be in a scraper)
4. Paste both into GitHub secrets as described in Part 1.3

### Managing the watchlist

No code needed for this part, ever:
1. Same Supabase project → left sidebar → **Table Editor**
2. Click **bid_watchlist**
3. To add a title: click **Insert** → **Insert row** → fill in `title` (and optionally `notes`) → **Save**. Leave `status` as `active`.
4. To stop tracking a title without deleting its history: change its `status` to `archived` instead of deleting the row.

---

## Part 3 — Running a scrape

### Option A: GitHub Actions (no local setup needed)

1. On your repo's GitHub page, click the **Actions** tab
2. Click **Poster Comps Scraper (Master)** in the left sidebar
3. Click **Run workflow** (button on the right, may need to click a dropdown first)
4. Choose a **target** from the dropdown:
   - `emovieposter-titles` — historical comps, reads your watchlist automatically (leave "titles" blank), or type specific titles there to override just this run
   - `emovieposter-current` — current/upcoming auctions (see 3.1 below for the URL you need)
   - `emovieposter-discovery` — tag-based discovery (e.g. `star:Harrison Ford`)
5. Fill in any other fields that appear based on your target choice
6. Click the green **Run workflow** button
7. Click into the running workflow (it'll appear in the list within a few seconds) to watch the live log output

### 3.1 — For current auctions specifically

Good news: you usually don't need to look anything up. The scraper defaults to `https://www.emovieposter.com/agallery/all.html`, which aggregates every current auction (both Tuesday and Thursday, confirmed via a real screenshot showing 2,069 = 1,345 + 724 combined) under one URL that appears stable across auction cycles — no per-cycle ID to hunt down each time.

Leave the **listing_url** field blank when running the workflow (or don't set `LISTING_URL` locally) and it'll use this automatically.

If you ever want just one specific day instead of everything combined: go to emovieposter.com → click that day's auction tab → **Layout: List** → copy the address bar (looks like `emovieposter.com/agallery/mode/1/14.html`) → paste into **listing_url**.

### 3.2 — Automatic scheduled runs (current auctions only)

The workflow also runs itself automatically — **Monday/Wednesday/Saturday, 13:00 UTC (~8am CDT)**, i.e. the day before each of eMoviePoster's actual close days (**Tuesday/Thursday/Sunday**, confirmed) — scraping current auctions with no manual trigger needed.

This scheduled run only ever triggers `emovieposter_current_auctions.ts` — never the historical scraper, since that needs login and deliberate direction (the watchlist), not a blind timer.

**To change the cadence or time:** edit the `cron:` line near the top of `.github/workflows/scrape-master.yml` — it's standard cron syntax, and the time is UTC. For example, `0 13 * * *` would run daily instead of 3x/week.

**To disable it entirely:** delete or comment out the `schedule:` block in the same file.

**To see scheduled runs:** GitHub Actions → **Poster Comps Scraper (Master)** — they show up in the run history the same as manual triggers, just without a person's name attached as the trigger.

### Option B: Run locally

```bash
git clone https://github.com/YOUR_USERNAME/frameandreel-comps.git
cd frameandreel-comps
npm install
npx playwright install --with-deps chromium

# Historical (reads watchlist automatically):
export EMOVIEPOSTER_USERNAME="your_username"
export EMOVIEPOSTER_PASSWORD="your_password"
export SUPABASE_URL="https://vojshqdxkdvzowdsucjk.supabase.co"
export SUPABASE_ANON_KEY="paste_from_supabase"
npm run scrape:emovieposter

# Current auctions (defaults to the aggregated "all.html" listing —
# LISTING_URL only needed if you want one specific day instead):
npm run scrape:current-auctions
```

---

## What each scraper actually needs

| Script | Needs login? | Needs Supabase? | Directed by |
|---|---|---|---|
| `emovieposter_scraper.ts` | Yes | Yes (watchlist) | `bid_watchlist` table, or `TITLES` override |
| `emovieposter_current_auctions.ts` | No | No | Defaults to all current auctions; `LISTING_URL` overrides for one specific day |
| `ebay_comps.ts` | No (API) | No | `TITLES` |
| `retail_listings_scraper.ts` | No | No | `TITLES` |
| `valuation/gemini_estimate.ts` | No | No | `TITLE` + optional fields |

---

## Things still not wired up yet (so you're not surprised)

- **No backend ingest endpoint exists** — everything currently *logs* what it finds instead of writing to YouBase, since `/api/poster-auctions/bulk` etc. don't exist in the EdgeSpark backend yet
- **RLS is off** on all 5 Supabase tables (including `bid_watchlist`) — the anon key currently has open read/write access to everything, not just the watchlist. Fine for personal use, worth locking down before this is more exposed
