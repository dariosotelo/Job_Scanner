# Job Scanner — Project Log

---

## For New Contributors & AI Agents

This section is a self-contained briefing. Read it before anything else; the session log below
is historical context rather than daily reading.

### What this project does

Automated daily job scanner for quantitative finance roles. Hits company career portals
directly — no aggregators, no manual browsing. Sends a Telegram message once per day
listing every new job posting found that wasn't seen on a previous run.

Owner: Cesar Dario Sotelo (ETH Zurich MQF, targeting Swiss quant finance roles, Sep 2026).
Working directory: `/Users/darios/Proyectos/Job_Scanner/`

---

### Architecture

```
daily-scan.sh
  │
  ├── node scan.mjs              # Greenhouse / Lever / Ashby JSON API
  ├── node scrape-ubs.mjs        # UBS — Taleo ATS via Playwright headless browser
  ├── node scrape-umantis.mjs    # Umantis ATS — plain HTTP + HTML parse
  ├── node scrape-workday.mjs    # Workday ATS — POST JSON API, paginated
  ├── node scrape-postfinance.mjs# PostFinance — custom SuccessFactors wrapper
  ├── node scrape-prospective.mjs# prospective.ch — HTTP/2 required (see gotchas)
  ├── node scrape-phenom.mjs     # Phenom People — page-embedded JSON, all pages
  └── node notify-telegram.mjs  # reads data/scan-history.tsv → sends Telegram message
```

Every scraper writes new findings to `data/scan-history.tsv` (tab-separated: url, date,
portal, title, company, status, location). `notify-telegram.mjs` reads that file, picks
today's entries not yet in `data/notified-urls.txt`, sends them, and appends those URLs to
the notified file. Deduplication is permanent — a job URL is never sent twice regardless of
how many times you re-run the scan.

---

### File reference

| File | Purpose |
|------|---------|
| `daily-scan.sh` | Runs all scrapers in sequence, then notify. The entry point for cron/launchd. |
| `scan.mjs` | Reads `portals.yml` and hits each Greenhouse/Lever/Ashby API. |
| `scrape-ubs.mjs` | Playwright browser; intercepts UBS's internal Taleo JSON API. |
| `scrape-umantis.mjs` | Fetches Umantis HTML pages; COMPANIES array hardcoded inside. |
| `scrape-workday.mjs` | Workday REST API; limit must be ≤ 20; `total` only reliable on page 1. |
| `scrape-postfinance.mjs` | PostFinance SuccessFactors wrapper; location format `City\|Region\|…` split on `\|`. |
| `scrape-prospective.mjs` | HTTP/2 only — uses Node.js `http2` module, not `fetch()`. |
| `scrape-phenom.mjs` | Phenom People; fetches all ~200 pages, parses JSON blob in `<script>`. |
| `notify-telegram.mjs` | Sends Telegram message with today's new jobs. English, HTML parse mode. |
| `jobs.mjs` | CLI tool — browse results and tracked companies in the terminal. |
| `portals.yml` | Personal config: title keywords, location allow/block, company list. Gitignored. |
| `portals.example.yml` | Template to copy. Edit location_filter.allow and title_filter.positive/negative. |
| `.env` | `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`. Gitignored. |
| `.env.example` | Template for .env. |
| `data/scan-history.tsv` | All job URLs ever found, with date first seen. Gitignored. |
| `data/notified-urls.txt` | All job URLs ever sent via Telegram. Gitignored. |
| `data/daily-scan.log` | stdout+stderr from daily-scan.sh. Gitignored. |

---

### Setup from scratch

```bash
# 1. Install dependencies
npm install
npx playwright install chromium   # only needed for UBS scraper

# 2. Configure search
cp portals.example.yml portals.yml
# Edit portals.yml: location_filter.allow, title_filter.positive, title_filter.negative

# 3. Telegram bot
# a) Open Telegram → @BotFather → /newbot → copy the token
# b) Send any message to your bot, then:
curl https://api.telegram.org/bot<TOKEN>/getUpdates
# Find "chat":{"id": XXXXXX} — that number is your chat ID

cp .env.example .env
# Fill in TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID

# 4. Test
node scan.mjs --dry-run
node scrape-ubs.mjs --dry-run
bash daily-scan.sh --dry-run     # runs all scrapers without writing anything

# 5. Schedule (macOS launchd — runs at 08:00 daily)
# Edit com.jobscanner.daily.plist with absolute paths, then:
launchctl load ~/Library/LaunchAgents/com.jobscanner.daily.plist

# OR Linux cron:
# 30 8 * * 1-5 cd /path/to/Job_Scanner && bash daily-scan.sh >> data/daily-scan.log 2>&1
```

---

### Terminal commands reference

```bash
# Run everything (production)
bash daily-scan.sh

# Run individual scrapers
node scan.mjs                    # Greenhouse/Lever/Ashby companies from portals.yml
node scrape-ubs.mjs              # UBS Taleo (needs Chromium)
node scrape-umantis.mjs          # Umantis companies (J. Safra Sarasin, AXA CH)
node scrape-workday.mjs          # Workday companies (Rothschild & Co)
node scrape-postfinance.mjs      # PostFinance SuccessFactors
node scrape-prospective.mjs      # Helvetia, Generali Switzerland
node scrape-phenom.mjs           # Allianz (slow — ~200 pages)

# All scrapers accept --dry-run (no file writes, no Telegram)

# Browse results
node jobs.mjs                    # new jobs found today
node jobs.mjs --days 7           # last 7 days
node jobs.mjs --all              # full history
node jobs.mjs --all --filter UBS # filter by keyword (title / company / location)
node jobs.mjs --companies        # list all tracked companies + active filters

# Send today's Telegram notification manually
node notify-telegram.mjs
```

---

### How to add new companies

**Greenhouse (easiest — just a URL):**
Find the slug from `job-boards.greenhouse.io/{slug}/jobs/...` and add to `portals.yml`:
```yaml
- name: New Company
  scan_method: greenhouse-api
  api: https://boards-api.greenhouse.io/v1/boards/{slug}/jobs
```

**Workday:**
Find tenant+instance from `{tenant}.{instance}.myworkdayjobs.com`, board from the URL path.
Add to `COMPANIES` array in `scrape-workday.mjs`:
```js
{ tenant: 'yourcompany', instance: 'wd3', board: 'YourCompany_External', name: 'Your Company' }
```
Then add an entry to `portals.yml` with `scan_method: workday`.

**Umantis:**
Find slug from `{slug}.umantis.com`. Add to `COMPANIES` in `scrape-umantis.mjs`:
```js
{ slug: 'yourcompany', name: 'Your Company' }
```

**prospective.ch:**
Add to `COMPANIES` in `scrape-prospective.mjs`:
```js
{ url: 'https://jobs.yourcompany.com/ch/?lang=en', name: 'Your Company' }
```

**Phenom People:**
Find their `/search-results?s=1` URL and their SuccessFactors company code (from the apply URL).
Add to `COMPANIES` in `scrape-phenom.mjs`:
```js
{ baseUrl: 'https://careers.yourcompany.com/en/search-results?s=1',
  applyUrlBase: 'https://career5.successfactors.eu/careers?company=YOURCODE',
  name: 'Your Company' }
```

For all new companies: add a corresponding entry to `portals.yml` under `tracked_companies:`
so that `node jobs.mjs --companies` lists them correctly.

---

### Technical gotchas (hard-won — read before debugging)

**prospective.ch:**
- `fetch()` / undici returns HTTP 503 because the server requires HTTP/2. Must use Node.js
  built-in `http2` module with `http2.connect()`.
- Must set `':authority': url.host` in request headers explicitly — Node.js http2 does not
  set this pseudo-header automatically, and the server returns 503 without it.
- Rate limiting: rapid repeated requests (e.g. during debugging) cause temporary IP block.
  Clears within a few hours. Daily cold-start run is not affected.

**Phenom People (Allianz):**
- No server-side filtering — URL query params are ignored. Must fetch all pages (~208 for Allianz)
  and filter client-side.
- Jobs are embedded as a large JSON blob inside a `<script>` tag in each page's HTML.
- JSON field order: `country` appears BEFORE `jobId` in each record — anchor the regex on
  `jobId`, then use a wide ±600/800 char context window to extract surrounding fields.
- `applyUrl` in the page HTML belongs to a different job's record — never use it. Construct
  URLs directly from `jobId`: `${applyUrlBase}&career_job_req_id=${jobId}&career_ns=job_application`.
- Location field: `cityStateCountry` (e.g. "Zurich, Zurich, Switzerland"). Swiss jobs appear
  scattered through all pages — early exit by country would miss them. Fetch everything.

**Workday:**
- `limit > 20` returns HTTP 400. Always use `limit: 20`.
- The `total` field in the API response is only accurate on the first page. Capture it once
  and reuse it. On pages 2+, `total` returns 0.

**UBS (Taleo via Playwright):**
- The Taleo ATS loads data via an internal POST API that Playwright intercepts.
- Requires Chromium: `npx playwright install chromium` during setup.
- Keywords are hardcoded inside `scrape-ubs.mjs` (not read from portals.yml).

**Telegram:**
- Message format uses HTML parse mode (`parse_mode=HTML`).
- Chat ID for a channel starts with `-100...`. To get it: forward a message from the channel
  to @userinfobot on Telegram.
- If sending to a channel instead of a direct chat: create the channel, add the bot as an
  admin, use the channel's `-100...` ID as `TELEGRAM_CHAT_ID`.

---

### Sharing notifications with friends (Telegram channel approach)

To share job notifications with friends without them running the scanner:

1. Create a new Telegram channel (public or private).
2. Add your bot as an **admin** with "Post Messages" permission.
3. Get the channel chat ID: forward any message from the channel to **@userinfobot** on
   Telegram. It replies with a chat ID starting with `-100...`.
4. Set that ID as `TELEGRAM_CHAT_ID` in `.env`.
5. Share the channel invite link with your friends. They join the channel — no setup needed
   on their end. When you run the scanner, the bot posts to the channel and all members see it.

To revert to personal DM: change `TELEGRAM_CHAT_ID` back to your own user ID.

---

## Session — 2026-05-13

### Context
Setting up career-ops from scratch for Cesar Dario Sotelo Aportela.
Profile: ETH Zurich MQF student, targeting quantitative finance roles in Switzerland.
Tool: https://github.com/santifer/career-ops

---

### 1. Prerequisites verified
- Node.js v25.9.0 ✅
- npm 11.12.1 ✅
- git 2.39.2 ✅
- Go: not installed (optional, skipped)
- Playwright/Chromium: installed via `npx playwright install chromium`

### 2. Folder created
`/Users/darios/Proyectos/Career_Bot/`

### 3. Config files created (personalised)

| File | Notes |
|------|-------|
| `config/profile.yml` | Identity, target roles, CHF 80-120k comp, Sep 2026 availability, EU visa note |
| `modes/_profile.md` | 5 role archetypes: Quant Researcher, Quant Analyst, Risk Analyst, Portfolio Analyst, Data Scientist Finance |
| `cv.md` | Full CV in markdown from uploaded PDF |
| `portals.yml` | 30 companies — Swiss banks, asset managers, quant funds, European IB |

### 4. portals.yml bug fixed
Original file used wrong YAML keys (`companies:`, `filters.titles:`, `filters.location:`).
Corrected to `tracked_companies:`, `title_filter:`, `location_filter:` as expected by `scan.mjs`.

### 5. Greenhouse API slugs audited
Ran dry-run scan — 11 companies returned HTTP 404 on Greenhouse API.
Confirmed only **Optiver** and **Flow Traders** have working Greenhouse boards.
All other companies (Goldman Sachs, JPMorgan, BlackRock, UBS, Swiss Re, etc.) use Workday/Taleo — not supported by zero-token scanner.
Fixed: removed wrong `api:` fields, switched to `scan_method: websearch` for those companies.

### 6. Telegram notification system built

**Files created:**
- `notify-telegram.mjs` — reads today's entries from `data/scan-history.tsv`, sends formatted Telegram message
- `daily-scan.sh` — wrapper script: runs `scan.mjs` then `notify-telegram.mjs`, logs to `data/daily-scan.log`
- `~/Library/LaunchAgents/com.careerops.dailyscan.plist` — macOS LaunchAgent, fires daily at 08:00

**Message format:**
```
📋 New Job(s) Posted — 2026-05-13

• Off-Cycle Internship Quantitative Risk Analyst
  UBS · Zurich, Switzerland

• Junior Risk Analyst – Structured Products
  Vontobel · Zurich, Switzerland
```

**Deduplication:** handled by `scan.mjs` — jobs already in `scan-history.tsv` are never re-added, so next-day scans only surface genuinely new postings.

**Setup remaining:**
- Add `TELEGRAM_CHAT_ID` to `.env` (token already set)
- Register LaunchAgent: `launchctl load ~/Library/LaunchAgents/com.careerops.dailyscan.plist`

### 7. How the scanner works (important limitation)

The zero-token scanner (`node scan.mjs`) only works for companies using **Greenhouse, Ashby, or Lever** ATS.
Most major Swiss/European banks (UBS, ZKB, Pictet, Julius Baer, Goldman Sachs, JPMorgan, BlackRock) use **Workday or Taleo** — these are skipped by the API scanner.

For those companies, jobs are discovered via **websearch** when running interactively inside Claude Code:
```
claude  →  /career-ops scan
```

The daily automated scan (`daily-scan.sh`) will only catch Greenhouse/Ashby/Lever companies.
For Swiss bank roles, run `/career-ops scan` manually inside Claude Code periodically.

---

### 8. Telegram setup completed
- Chat ID retrieved automatically via `getUpdates` API (id: 1538570817)
- Added to `.env` as `TELEGRAM_CHAT_ID`
- Test message sent successfully with 14 real job findings

### 9. Message format updated to Dominican Spanish
- Edited `formatMessage()` in `notify-telegram.mjs`
- Header: "Ke lo ke broder! Salieron X vainas nuevas pa ti"
- Footer: "¡Dale ke va! Entra al career-ops y evalúa esas vainas 💪"

### 10. Deduplication across days
- Added `data/notified-urls.txt` — tracks every URL ever sent via Telegram
- `notify-telegram.mjs` checks this file before sending; already-notified jobs are skipped
- Jobs in `scan-history.tsv` from previous days are never re-added by `scan.mjs` (separate dedup)

### 11. Cron job registered (replaces LaunchAgent)
- Added to crontab: Mon–Fri 8:30am
- Command: `PATH=/opt/homebrew/bin:/usr/bin:/bin /bin/bash /Users/darios/Proyectos/Career_Bot/career-ops/daily-scan.sh`
- Existing Weather Forecast cron entries preserved

### 12. UBS Playwright scraper built (`scrape-ubs.mjs`)
- UBS uses Taleo ATS (no public API) — zero-token scanner cannot reach it
- Used Playwright to intercept the `MatchedJobs` JSON API that UBS's SPA calls on search
- API endpoint: `POST https://jobs.ubs.com/TgNewUI/Search/Ajax/MatchedJobs`
- Portal URL: `https://jobs.ubs.com/TGNewUI/Search/Home/Home?partnerid=25008&siteid=5176#home`
- Parses fields: `jobtitle`, `formtext23` (location), `reqid` (to build job URL)
- Integrated into `daily-scan.sh` — runs after `scan.mjs`, before `notify-telegram.mjs`

### 13. 5 new Greenhouse companies added (confirmed working APIs)
| Company | Greenhouse slug | Notes |
|---------|----------------|-------|
| Point72 | `point72` | Global quant hedge fund |
| AQR | `aqr` | Quant asset manager |
| Jane Street | `janestreet` | Prop trading, quant roles |
| Virtu Financial | `virtu` | Market maker |
| IMC Trading | `imc` | Amsterdam market maker, has Zug office |

### 14. Title filter tuned for entry-level only
**User profile:** applying to internships and graduate programs only; no experience roles acceptable.

**Negative filter additions:**
- Senior, Director, Vice President, VP, Managing Director, MD, Head of, Principal, Partner (experience-required titles)
- Contact Center, Thought Leadership, Events Management (non-finance departments)
- Software Developer (added alongside Software Engineer)

**Positive filter additions:**
- Off-Cycle Internship, Summer Internship, Winter Internship, Spring Internship, Internship Program
- Graduate Program, Graduate Talent, New Grad, Entry Level
- Risk Control, Group Risk, RiskLab, Derivatives, Credit Risk, Market Risk, Counterparty, Actuarial (Swiss bank naming conventions)

### 15. First real scan results (2026-05-13)
- **Greenhouse (7 companies scanned, 691 total jobs):** 11 new offers added
  - Point72: Quantitative Researcher (London), Risk Manager (London), Investment Analyst Program
  - IMC Trading: Quant Developer Zug ×2, Quant Researcher Amsterdam/Zug, Risk Manager Zug, Research Analyst London
  - Jane Street: Quantitative Researcher (London)
- **UBS Playwright scraper:** 3 new offers — Derivatives & Solutions ZH, Group Risk Control ZH, RiskLab AI ZH
- **Total sent via Telegram:** 14 real job notifications

---

### Company list location
All companies are in [`portals.yml`](portals.yml) under the `tracked_companies:` section (line ~100+).

**Auto-scannable (Greenhouse API — picked up by daily cron):**
- Optiver, Flow Traders, Point72, AQR, Jane Street, Virtu Financial, IMC Trading

**Playwright-scraped (picked up by daily cron via `scrape-ubs.mjs`):**
- UBS (Taleo ATS)

**Websearch only (need manual `/career-ops scan` in Claude Code):**
- All Swiss banks (ZKB, Julius Baer, Pictet, Lombard Odier, etc.)
- Goldman Sachs, JPMorgan, BlackRock, Morgan Stanley, and all other Workday/custom ATS firms

---

### 16. Umantis scraper built (`scrape-umantis.mjs`)

**J. Safra Sarasin** uses Umantis ATS (common in Swiss companies) — server-rendered HTML, no Playwright needed.

- URL: `https://jsafrasarasin.umantis.com/Jobs/All`
- Pure HTTP fetch + regex parsing (no browser automation)
- Generic `COMPANIES` array — any Umantis company can be added with just `{ slug, name }`
- Parses: job links via `href="/Vacancies/{id}/Description/{lang}"` + `aria-label` for title
- Location extracted from `tableaslist_element_XXXXXX">&nbsp;|&nbsp;{City}, CH` pattern
- Applies same `title_filter` / `location_filter` from portals.yml
- Integrated into `daily-scan.sh` (step 3, runs after scrape-ubs.mjs)
- Added J. Safra Sarasin to portals.yml as `scan_method: umantis`

**Test result (dry-run, 2026-05-13):**
- 13 total jobs found, 2 relevant: Business Risk Manager (ZH), Sustainable Investment Analyst (ZH)

**To add more Umantis companies** — edit the `COMPANIES` array in `scrape-umantis.mjs`:
```js
{ slug: 'zkb', name: 'ZKB' }  // if ZKB uses Umantis
```

---

### To-do / Next steps
- [ ] Evaluate first job posting: paste URL into Claude Code → `/career-ops`
- [ ] Add more companies with Greenhouse/Ashby/Lever APIs as discovered
- [ ] Check if other Swiss banks (ZKB, Pictet) use Umantis — if yes, add to scrape-umantis.mjs
- [ ] Provide more company career page URLs to build additional scrapers

---

## Session — 2026-05-13 (continued) + 2026-05-14

### 17. AXA Switzerland added to Umantis scraper

**Investigation:** AXA's main careers page (`www.axa.ch/en/about-axa/jobs-career/job-vacancies/`)
embeds a prospective.ch iframe, which itself loads data from an Umantis backend.

**Decision:** scrape Umantis directly — simpler than parsing iframes, reuses existing scraper.
- Umantis slug: `recruitingapp-2735`
- Added to `COMPANIES` array in `scrape-umantis.mjs`
- Added entry to `portals.yml` (`scan_method: umantis`)

**Location note:** AXA's Umantis instance does not include the `, CH` suffix in location strings
(unlike J. Safra Sarasin). Locations may appear blank. Acceptable since all AXA CH postings are Swiss.

---

### 18. Workday scraper built (`scrape-workday.mjs`)

**Rothschild & Co** uses Workday ATS. Main careers page is protected by Cloudflare Turnstile
(blocks both curl and headless Playwright). Workaround: discovered the Workday API endpoint
via web search without touching the protected page.

**API pattern:** `POST https://{tenant}.{instance}.myworkdayjobs.com/wday/cxs/{tenant}/{board}/jobs`
Body: `{ appliedFacets: {}, limit: 20, offset: N, searchText: '' }`

**Critical bugs found and fixed:**
1. `limit > 20` → HTTP 400. Workday rejects any limit above 20.
2. `total` field returns 0 on pages 2+. Must capture `data.total` from the first page only
   and reuse that value throughout pagination. Fix: `if (total === null) total = data.total || 0`.

**Rothschild & Co config:**
- Tenant: `rothschildandco`, Instance: `wd3`, Board: `Rothschildandco_Lateral`
- Job URL: `https://rothschildandco.wd3.myworkdayjobs.com/Rothschildandco_Lateral{externalPath}`

**To add a Workday company:** Find the tenant+instance from their careers URL
(`{tenant}.{instance}.myworkdayjobs.com`), find the board name from the URL path.
Add to `COMPANIES` array in `scrape-workday.mjs`.

---

### 19. PostFinance scraper built (`scrape-postfinance.mjs`)

PostFinance runs a custom wrapper over SAP SuccessFactors at `jobs.postfinance.ch`.

**API:** `POST https://jobs.postfinance.ch/services/recruiting/v1/jobs`
Body: `{ locale: 'de_DE', pageNumber: N, sortBy: 'date', brand: 'PostFinance' }`

**Job URL reverse-engineered:** `https://jobs.postfinance.ch/{brandUrl}/job/{urlTitle}/{id}-{locale}`
Fields extracted from API response: `brandUrl`, `urlTitle`, `id`, `supportedLocales[0]`.

Location field format: `"City|Region|Canton|Country|ISO "` — split on `|` and take first element.

**Bug found:** Financial Risk Manager roles were being filtered out because PostFinance's HQ
is in Bern, which was not in `location_filter.allow`. Added `- bern` to `portals.yml`.

**Can extend to Swiss Post group** by adding `{ brand: 'default', name: 'Swiss Post' }` to `BRANDS`.

---

### 20. prospective.ch scraper built (`scrape-prospective.mjs`)

prospective.ch is a Swiss career platform. Key discovery: **requires HTTP/2**.
Node.js `fetch()` / undici uses HTTP/1.1 by default → server returns HTTP 503.
`curl` works because it negotiates HTTP/2 via ALPN automatically.

**Solution:** replaced `fetch()` with a custom `postH2()` function using Node.js built-in `http2` module.

**Two bugs found and fixed during development:**

1. **Generali 0 jobs despite regex matching in isolation:**
   Generali's job card HTML has `class` attribute before `href`:
   `<a class="job job-0" href="..." title="...">` 
   Original regex `/<a\s+href=` didn't match. Fixed to `/<a\s+[^>]*href=`.

2. **Silent 503 from rate limiting:**
   When server returns 503, the function was resolving with the error HTML body instead of rejecting.
   Fix: capture `:status` from `req.on('response', h => { status = h[':status'] || 200; })`,
   then reject if `status !== 200`.

3. **`:authority` pseudo-header must be set explicitly:**
   Without `':authority': url.host` in the request headers, the server returns 503.
   Confirmed: isolated tests with and without this header show different results.

**Pagination auto-detection:**
Page sizes differ by company (Helvetia: 9, Generali: 15). Instead of hardcoding, the scraper
parses `sendPagination(N)` calls from the HTML and takes the next offset > current offset.

**Rate limiting:** during the debug session (repeated test requests), the IP was temporarily
blocked by prospective.ch. This is normal and clears within hours. Daily cron is not affected
since it makes only 1-2 requests per company per day.

**Companies added:**
| Company | URL | portals.yml entry |
|---------|-----|-------------------|
| Helvetia | `https://jobs.helvetia.com/ch/?lang=en&r=1` | ✅ |
| Generali Switzerland | `https://jobs.generali.ch/?lang=en` | ✅ |

---

### 21. First full end-to-end pipeline test (2026-05-13)

Ran `bash daily-scan.sh` — all scrapers executed sequentially.

**Results:**
| Scraper | Company | New offers found |
|---------|---------|-----------------|
| scan.mjs | Point72 Asset Management | 1 (Quantitative Researcher, London) |
| scan.mjs | Jane Street | 1 (Quantitative Researcher, London) |
| scrape-ubs.mjs | UBS | 8 (internships and off-cycle programs, Zurich) |
| scrape-umantis.mjs | J. Safra Sarasin | 2 (Business Risk Manager, Sustainable Investment Analyst) |
| scrape-umantis.mjs | AXA Switzerland | 0 |
| scrape-workday.mjs | Rothschild & Co | 1 (Equity Research Analyst, London) |
| scrape-postfinance.mjs | PostFinance | 1 (Financial Risk Manager, Bern) |
| scrape-prospective.mjs | Helvetia | ✗ 503 (IP rate limited from debug session) |
| scrape-prospective.mjs | Generali | ✗ 503 (same) |

**Telegram:** 14 offers sent in 2 batches. All 14 URLs stored in `scan-history.tsv`.
Deduplication confirmed: re-running the scan finds 0 new offers (all already in history).

---

### 22. Allianz scraper built (`scrape-phenom.mjs`) — 2026-05-14

**ATS:** Phenom People (phenompeople.com), tenant `AISAIPGB`. Fully client-side rendered —
server-side filtering via URL params does not work. No filterable JSON API found.

**Solution:** fetch all pages (5 concurrent, 800ms between batches), parse the job JSON blob
embedded in each page's `<script>` tag, apply `portals.yml` title + location filters client-side.

**Key implementation details:**
- `jobId` anchors each record in the HTML — context window ±600/800 chars extracts fields
- `cityStateCountry` used as location string (e.g. "Zurich, Zurich, Switzerland")
- Job URL constructed as: `https://career5.successfactors.eu/careers?company=AZGROUPPROD&career_job_req_id={jobId}`
- ~1540 global jobs scanned per run; early exit when all pages exhausted
- Paris added to `portals.yml` location allow list (alongside London, Frankfurt, Amsterdam already present)

**Test result:** 1 relevant offer found (Third Party Risk Manager, Frankfurt) on first run.

---

### 23. Telegram notifications switched to English — 2026-05-14

`notify-telegram.mjs` message format changed from Dominican Spanish to English:
- Header: "🔔 N new job postings — YYYY-MM-DD"
- Footer: "Run /career-ops pipeline to evaluate."

---

### 24. Job_Scanner — standalone GitHub repo created — 2026-05-14

Project extracted from the `santifer/career-ops` fork into a clean standalone repo at
`/Users/darios/Proyectos/Job_Scanner/`. Rationale:
- The fork's system-layer (`*.mjs` files) were heavily customised — upstream updates would overwrite them
- The original repo has 8-language READMEs, governance docs, CI/CD pipelines — all irrelevant overhead
- A clean repo is easier for friends to fork and adapt

**Files included:**
- All 7 scrapers + `daily-scan.sh` + `notify-telegram.mjs`
- `jobs.mjs` — new CLI tool (see below)
- `portals.example.yml` — sanitised template (no personal data)
- `.env.example` — shows Telegram setup instructions
- `package.json`, `.gitignore`, `README.md`, `PROJECT_LOG.md`

**Files intentionally excluded (gitignored):**
- `portals.yml` — personal keywords and company list
- `.env` — Telegram tokens
- `data/scan-history.tsv`, `data/notified-urls.txt` — personal scan history

**Friends setup:** `cp portals.example.yml portals.yml` → edit keywords/locations →
create own Telegram bot via @BotFather → `cp .env.example .env` → fill tokens → run.

---

### 25. CLI tool built (`jobs.mjs`) — 2026-05-14

`node jobs.mjs` — browse scan results and tracked companies from the terminal without opening files.

**Commands:**
```
node jobs.mjs                     New jobs found today
node jobs.mjs --days 7            Last 7 days
node jobs.mjs --all               Full history
node jobs.mjs --companies         All tracked companies grouped by scan method + active filters
node jobs.mjs --filter <keyword>  Filter by title, company, or location
```

Flags can be combined: `node jobs.mjs --days 7 --filter London`

---

### Current scraper coverage summary (as of 2026-05-14)

| Platform | Script | Companies |
|----------|--------|-----------|
| Greenhouse / Lever / Ashby API | `scan.mjs` | Point72, AQR, Jane Street, Virtu, IMC, Optiver, Flow Traders |
| Taleo (Playwright) | `scrape-ubs.mjs` | UBS |
| Umantis | `scrape-umantis.mjs` | J. Safra Sarasin, AXA Switzerland |
| Workday | `scrape-workday.mjs` | Rothschild & Co |
| SuccessFactors custom | `scrape-postfinance.mjs` | PostFinance |
| prospective.ch | `scrape-prospective.mjs` | Helvetia, Generali Switzerland |
| Phenom People | `scrape-phenom.mjs` | Allianz |

**Total companies with automated daily scanning: 14**

---

### 26. Telegram channel setup — sharing notifications with friends — 2026-05-14

To broadcast job notifications to friends without them running the scanner:

1. Create a Telegram channel (public or private).
2. Add your bot as an **admin** with "Post Messages" permission.
3. Get the channel chat ID: forward any message from the channel to **@userinfobot** on
   Telegram. It replies with the chat ID in the format `-1001234567890`.
4. Replace `TELEGRAM_CHAT_ID` in `.env` with this channel ID.
5. Friends join the channel via invite link. No setup, no tokens, nothing — they just receive
   the notification automatically whenever the daily scan runs.

This approach means one person (the scanner owner) runs the cron job; everyone else just
subscribes. The bot must be a channel admin, not just a member.

---

### 27. Terminal command reference — documented — 2026-05-14

Full terminal command reference added to the "For New Contributors" section at the top of
this file. Covers: running the full pipeline, individual scrapers, dry-run mode, and all
`jobs.mjs` flags. This is the canonical reference for running and testing the scanner.

---

### Going forward

All scanner work happens in `Job_Scanner/`. The `Career_Bot/career-ops/` folder is only
relevant for its CV evaluation and interview prep features (separate functionality).

### To-do / Next steps
- [ ] Test prospective.ch scraper (Helvetia + Generali) on a cold-start run — rate limit from 2026-05-13 debug session should have cleared
- [ ] `git init` and push `Job_Scanner` to GitHub
- [ ] Add more companies as career page URLs are provided
- [ ] Consider adding Baloise Group (merging with Helvetia in 2026 — monitor both portals)
