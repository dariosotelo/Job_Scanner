# Job Scanner

Automated daily job scanner for finance roles. Hits company career portals directly — no scraping aggregators, no duplicates, Telegram notification when something new appears.

Covers 8 ATS platforms out of the box:

| Platform | Companies (examples) |
|----------|---------------------|
| Greenhouse API | Point72, Jane Street, AQR, IMC, Optiver, Flow Traders, Virtu |
| Workday | Rothschild & Co (add any Workday company) |
| Umantis | J. Safra Sarasin, AXA Switzerland |
| Taleo (Playwright) | UBS |
| SuccessFactors | PostFinance |
| prospective.ch | Helvetia, Generali Switzerland |
| Phenom People | Allianz |
| Higher GraphQL | Goldman Sachs |

---

## Setup

### 1. Install dependencies

```bash
npm install
npx playwright install chromium   # only needed for UBS scraper
```

### 2. Configure your search

```bash
cp portals.example.yml portals.yml
```

Edit `portals.yml`:
- `location_filter.allow` — cities/countries you want (e.g. Zurich, London, Paris)
- `title_filter.positive` — job title keywords to match
- `title_filter.negative` — keywords that disqualify a title (e.g. Senior, Sales)

### 3. Set up Telegram notifications

Create your own bot (free, 2 minutes):
1. Open Telegram → message [@BotFather](https://t.me/BotFather) → `/newbot` → follow prompts
2. Copy the token it gives you
3. Send any message to your new bot, then run:
   ```bash
   curl https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates
   ```
   Find `"chat":{"id": XXXXXX}` — that number is your chat ID

```bash
cp .env.example .env
# Edit .env and fill in TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID
```

### 4. Run a test

```bash
bash daily-scan.sh             # full pipeline
# or run individual scrapers:
node scan.mjs --dry-run
node scrape-ubs.mjs --dry-run
node scrape-goldman.mjs --dry-run
```

### 5. Schedule daily runs

**macOS (launchd)** — runs every day at 08:00:

Create `~/Library/LaunchAgents/com.jobscanner.daily.plist`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.jobscanner.daily</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>/absolute/path/to/Job_Scanner/daily-scan.sh</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>8</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>/absolute/path/to/Job_Scanner/data/daily-scan.log</string>
  <key>StandardErrorPath</key>
  <string>/absolute/path/to/Job_Scanner/data/daily-scan.log</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.jobscanner.daily.plist
```

**Linux (cron)**:
```bash
crontab -e
# Add:
30 8 * * 1-5 cd /path/to/Job_Scanner && bash daily-scan.sh >> data/daily-scan.log 2>&1
```

---

## Browsing results (CLI)

Use `jobs.mjs` to browse findings without opening any files:

```bash
node jobs.mjs                        # new jobs found today
node jobs.mjs --days 7               # last 7 days
node jobs.mjs --all                  # full history
node jobs.mjs --companies            # list all tracked companies + active filters
node jobs.mjs --filter "risk"        # filter by keyword (title, company, or location)
node jobs.mjs --days 7 --filter UBS  # combine flags
```

---

## Adding companies

### Greenhouse (easiest)
Find the company's Greenhouse board slug from their job page URL
(`job-boards.greenhouse.io/{slug}/jobs/...`), then add to `portals.yml`:

```yaml
- name: New Company
  scan_method: greenhouse-api
  api: https://boards-api.greenhouse.io/v1/boards/{slug}/jobs
```

### Workday
Find the tenant and board name from their careers URL
(`{tenant}.{instance}.myworkdayjobs.com/{board}`), then add to `scrape-workday.mjs`:

```js
{ tenant: 'yourcompany', instance: 'wd3', board: 'YourCompany_External', name: 'Your Company' }
```

### Umantis
Find the slug from their careers URL (`{slug}.umantis.com`), add to `scrape-umantis.mjs`:

```js
{ slug: 'yourcompany', name: 'Your Company' }
```

### prospective.ch
Find their URL (Swiss companies on this platform have `/job-vacancies/` links), add to `scrape-prospective.mjs`:

```js
{ url: 'https://jobs.yourcompany.com/ch/?lang=en', name: 'Your Company' }
```

### Phenom People
Find their search-results URL and SuccessFactors company code, add to `scrape-phenom.mjs`:

```js
{ baseUrl: 'https://careers.yourcompany.com/en/search-results?s=1', applyUrlBase: 'https://career5.successfactors.eu/careers?company=YOURCODE', name: 'Your Company' }
```

### Higher GraphQL
Some sites expose a public role-search API behind their careers frontend.
Goldman Sachs is the reference implementation in `scrape-goldman.mjs`.

---

## How deduplication works

Every job URL found is stored in `data/scan-history.tsv` with the date it was first seen.
On each run, any URL already in the file is silently skipped — you only get notified once per job,
no matter how many times you run the scanner.

To reset (re-scan everything as new): delete `data/scan-history.tsv` and `data/notified-urls.txt`.

---

## File structure

```
Job_Scanner/
├── daily-scan.sh               ← run all scrapers + notify
├── scan.mjs                    ← Greenhouse / Lever / Ashby API scanner
├── scrape-ubs.mjs              ← UBS (Taleo, Playwright)
├── scrape-umantis.mjs          ← Umantis ATS
├── scrape-workday.mjs          ← Workday ATS
├── scrape-postfinance.mjs      ← PostFinance (SuccessFactors)
├── scrape-prospective.mjs      ← prospective.ch
├── scrape-phenom.mjs           ← Phenom People
├── notify-telegram.mjs         ← Telegram notification sender
├── portals.example.yml         ← template — copy to portals.yml and edit
├── .env.example                ← template — copy to .env and fill in tokens
├── package.json
└── data/
    ├── scan-history.tsv        ← auto-created on first run
    ├── notified-urls.txt       ← auto-created on first run
    └── daily-scan.log          ← auto-created on first run
```
