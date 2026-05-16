# Company Coverage

Last updated: 2026-05-16

---

## How each company was configured

### Greenhouse API
Greenhouse publishes a public JSON API for job boards at:
`https://boards-api.greenhouse.io/v1/boards/{slug}/jobs`

To find the slug, visit the company's careers page and look at the URL when it redirects to
`job-boards.greenhouse.io/{slug}/...`. Then verified with:
```bash
curl -s -o /dev/null -w "%{http_code}" https://boards-api.greenhouse.io/v1/boards/{slug}/jobs
```
`200` = valid slug. `404` = company doesn't use Greenhouse or uses a different slug.

Slugs tested during setup (2026-05-13 / 2026-05-14):

| Slug tested | Result | Notes |
|-------------|--------|-------|
| `point72` | ✅ 200 | Active |
| `aqr` | ✅ 200 | Active |
| `janestreet` | ✅ 200 | Active |
| `virtu` | ✅ 200 | Active |
| `imc` | ✅ 200 | Active |
| `optiver` | ✅ 200 | Active |
| `flowtraders` | ✅ 200 | Active |
| `winton` | ✅ 200 | Active — added 2026-05-14 |
| `marshallwace` | ✅ 200 | Active — added 2026-05-14 |
| `citadel` | ❌ 404 | Not on Greenhouse |
| `twosigma` | ❌ 404 | Not on Greenhouse |
| `deshaw` | ❌ 404 | Not on Greenhouse |
| `millennium` | ❌ 404 | Not on Greenhouse |
| `schroders` | ❌ 404 | Uses Oracle HCM CE (not Workday) — automated via scrape-schroders.mjs |
| `lazard` | ❌ 404 | Uses TAL / Oleeo (`lazard-careers.tal.net`), not Greenhouse |
| `dws` | ❌ 404 | Uses Workday (board name unknown) |
| `man-group` | ❌ 404 | Wrong slug format; actual board is `mangroup` on Greenhouse EU |
| `brevanhoward` | ❌ 404 | Not on Greenhouse |
| `candriam` | ❌ 404 | Not on Greenhouse |
| `lyxor` | ❌ 404 | Not on Greenhouse |

### Workday
Workday API: `POST https://{tenant}.{instance}.myworkdayjobs.com/wday/cxs/{tenant}/{board}/jobs`
Body: `{ "appliedFacets": {}, "limit": 20, "offset": 0, "searchText": "" }`

The `tenant` and `instance` come from the careers page URL. The `board` name is in the URL path.
Critical: `limit` must be ≤ 20 (server returns 400 otherwise). `total` is only accurate on page 1.

| Company | Tenant | Instance | Board | How found |
|---------|--------|----------|-------|-----------|
| Rothschild & Co | `rothschildandco` | `wd3` | `Rothschildandco_Lateral` | Web search for their Workday URL |
| Vontobel | `vontobel` | `wd3` | `Vontobel_External_Career` | Extracted from careers page source (`vontobel.wd3.myworkdayjobs.com/...`) |
| Dimensional Fund Advisors | `dimensional` | `wd5` | `DFA_Careers` | careers.dimensional.com links to `dimensional.wd5.myworkdayjobs.com/DFA_Careers` |
| Swiss Life Asset Managers | `swisslife` | `wd3` | `Swiss_Life_Asset_Managers_Career_Site` | User found direct Workday URL; `de-DE` in path is language prefix, board follows it |

Attempted but board name unknown (tenant confirmed alive via 422 response):
- DWS, AXA, Société Générale, Amundi

To find the board name: visit the company's careers page, click any job, and read
the Workday URL: `{tenant}.{instance}.myworkdayjobs.com/{board}/job/...`

### Umantis
URL pattern: `https://{slug}.umantis.com/Jobs/All`
Server-rendered HTML — no browser needed. Slug found from the careers page URL.

| Company | Slug | How found |
|---------|------|-----------|
| J. Safra Sarasin | `jsafrasarasin` | Careers page redirects to this URL |
| AXA Switzerland | `recruitingapp-2735` | AXA CH careers page embeds Umantis iframe; slug extracted from iframe src |

### prospective.ch
Swiss career platform. URL pattern: `https://jobs.{company}.com/ch/?lang=en`
**Important:** Requires HTTP/2. Node.js `fetch()` returns 503 — must use the built-in
`http2` module with explicit `:authority` header.

| Company | URL | How found |
|---------|-----|-----------|
| Helvetia | `https://jobs.helvetia.com/ch/?lang=en&r=1` | Careers page link |
| Generali Switzerland | `https://jobs.generali.ch/?lang=en` | Careers page link |

### Phenom People (Allianz)
Fully client-side rendered. No server-side filtering via URL params.
Jobs are embedded as JSON inside a `<script>` tag on each search results page.
Scraper fetches all pages (~208 for Allianz), parses the JSON blob, filters client-side.

| Company | Base URL | SuccessFactors code | How found |
|---------|----------|---------------------|-----------|
| Allianz | `https://careers.allianz.com/ch/de/search-results?s=1` | `AZGROUPPROD` | Careers page; SF code from apply URL |

### PostFinance (SuccessFactors)
Custom wrapper over SAP SuccessFactors discovered by inspecting network requests
on `jobs.postfinance.ch` using browser DevTools → Network tab → XHR/Fetch filter.

API: `POST https://jobs.postfinance.ch/services/recruiting/v1/jobs`
Body: `{ "locale": "de_DE", "pageNumber": N, "sortBy": "date", "brand": "PostFinance" }`

### UBS (Playwright / Taleo)
UBS uses Taleo ATS which has no public API. The careers page is a React SPA that
calls an internal endpoint. Discovered by opening `jobs.ubs.com` in Chrome DevTools
→ Network tab → filtering for `MatchedJobs` → copying the request as curl.

Intercepted endpoint: `POST https://jobs.ubs.com/TgNewUI/Search/Ajax/MatchedJobs`
Playwright navigates to the portal and intercepts this request automatically.

---

## Automated companies (daily scan)

These run every day via `bash daily-scan.sh` with no manual intervention.

| Company | Platform | Jobs found | Last seen | Notes |
|---------|----------|-----------|-----------|-------|
| UBS | Playwright / Taleo | 11 | 2026-05-13 | Requires Chromium |
| IMC Trading | Greenhouse API | 7 | 2026-05-13 | Amsterdam + Zug office |
| Point72 Asset Management | Greenhouse API | 4 | 2026-05-13 | |
| Jane Street | Greenhouse API | 2 | 2026-05-13 | |
| J. Safra Sarasin | Umantis | 2 | 2026-05-13 | |
| Rothschild & Co | Workday | 1 | 2026-05-13 | |
| PostFinance | SuccessFactors | 1 | 2026-05-13 | |
| Winton Group | Greenhouse API | 0 | — | Added 2026-05-14; 1 match in dry-run |
| Marshall Wace | Greenhouse API | 0 | — | Added 2026-05-14; only recruitment roles currently |
| AQR Capital Management | Greenhouse API | 0 | — | API live; no title matches yet |
| Virtu Financial | Greenhouse API | 0 | — | API live; no title matches yet |
| Optiver | Greenhouse API | 0 | — | API live; no title matches yet |
| Flow Traders | Greenhouse API | 0 | — | API live; no title matches yet |
| AXA Switzerland | Umantis | 0 | — | API live; location field sometimes blank |
| Helvetia | prospective.ch | 0 | — | Rate limited during 2026-05-13 debug session |
| Generali Switzerland | prospective.ch | 0 | — | Rate limited during 2026-05-13 debug session |
| Allianz | Phenom People | 0 | — | 1 match in dry-run (Portfolio Manager, Frankfurt) |
| Vontobel | Workday | 0 | — | Added 2026-05-14; 47 jobs live on API |
| Julius Baer | Workday (×2 boards) | 0 | — | Added 2026-05-14; 1 match in dry-run (Market Risk Controller, Zurich) |
| HSBC | GroupGTI / Solr (plain HTTP) | 0 | — | Added 2026-05-16; ~12 jobs currently, mostly APAC. London/Frankfurt roles auto-caught when posted. |
| GAM Investments | Workday | 0 | — | Added 2026-05-16; 2 jobs live (senior roles, no current matches) |
| Société Générale | Playwright / CES | 0 | — | Added 2026-05-16; 242 EN Trainee+Internship roles; 1 dry-run match (Structured Products, Frankfurt) |
| Amundi | TalentSoft HTML | 0 | — | Added 2026-05-16; 134 jobs across France/Germany/UK/Luxembourg; 1 dry-run match |
| Swiss Life Asset Managers | Workday | 0 | — | Added 2026-05-16; 46 jobs; 2 dry-run matches (Praktikant Asset Mgmt Frankfurt; Stage Quant Risk Analyst Paris) |
| Leonteq | Custom JSON API | 0 | — | Added 2026-05-16; 21 jobs; 1 dry-run match (Graduate Program Retail Flow Trading, Zürich). Note: location normalised — API returns "Zürich" (umlaut). |
| SIX Group | SuccessFactors RMK HTML | 0 | — | Added 2026-05-16; 108 jobs; 0 current matches (Zurich internship present but no positive keyword hit; relevant roles appear when posted) |

---

## Websearch companies (manual only)

These are documented in `portals.yml` but require running `/career-ops scan` inside
Claude Code. They are **not** picked up by the daily cron job.

Most of these companies use Workday or proprietary ATS systems that block automated
scraping. To automate them, the Workday board name needs to be found from their careers URL.

### Swiss banks & private banks
| Company | HQ | Why not automated |
|---------|----|-------------------|
| Julius Baer | Zurich | Workday — board name not yet found |
| ~~Vontobel~~ | ~~Zurich~~ | Moved to automated (Workday) — 2026-05-14 |
| Zürcher Kantonalbank (ZKB) | Zurich | Custom ATS |
| Pictet Group | Geneva | Custom ATS |
| Lombard Odier | Geneva | Custom ATS |
| Basellandschaftliche Kantonalbank (BLKB) | Basel | Custom ATS |
| Banque Cantonale Vaudoise (BCV) | Lausanne | Custom ATS |

### Swiss asset managers & insurers
| Company | HQ | Why not automated |
|---------|----|-------------------|
| Partners Group | Zug | Custom ATS |
| ~~GAM Investments~~ | ~~Zurich~~ | Workday (`gam.wd3`, board: `GAM`) — automated via `scrape-workday.mjs` |
| ~~Swiss Life Asset Managers~~ | ~~Zurich~~ | Workday (`swisslife.wd3`, board: `Swiss_Life_Asset_Managers_Career_Site`) — automated via `scrape-workday.mjs` (2026-05-16) |
| Unigestion | Geneva | Custom ATS |
| ~~Leonteq~~ | ~~Zurich~~ | Custom JSON API (`careers.leonteq.com/publishedJobs.php`) — automated via `scrape-leonteq.mjs` (2026-05-16) |
| Swiss Re | Zurich | Custom ATS |
| Zurich Insurance Group | Zurich | Custom ATS |
| Baloise Group | Basel | Merging with Helvetia in 2026 — monitor both |
| ~~SIX Group~~ | ~~Zurich~~ | SuccessFactors RMK (`jobs.six-group.com`) — automated via `scrape-six.mjs` (2026-05-16) |

### Global banks (European offices)
| Company | Relevant offices | Why not automated |
|---------|-----------------|-------------------|
| Goldman Sachs | Zurich, Frankfurt, London | Higher GraphQL — automated via `scrape-goldman.mjs` |
| Lazard | London, Paris | TAL / Oleeo — automated via `scrape-lazard.mjs` |
| JPMorgan Chase | Zurich, London, Frankfurt | Oracle HCM CE — automated via `scrape-jpmorgan.mjs` |
| BlackRock | Zurich, London | Radancy ATS — automated via `scrape-blackrock.mjs` |
| Morgan Stanley | London, Frankfurt, Paris | Workday wd5 — automated via `scrape-workday.mjs` |
| Schroders | London, Zurich | Oracle HCM CE — automated via `scrape-schroders.mjs` |
| BNP Paribas | Paris, London | WordPress REST API (UK early-career) — automated via `scrape-bnpparibas.mjs` |
| Deutsche Bank | Frankfurt, London | Beesite graduate API (`api-deutschebank.beesite.de`) — automated via `scrape-deutschebank.mjs` |
| Société Générale | Paris, Frankfurt, London | CES (`api.socgen.com/…/search-profile`) — Playwright scraper via `scrape-societegenerale.mjs` |
| HSBC | Geneva, Zurich | GroupGTI / Solr — automated via `scrape-hsbc.mjs` |
| Allianz Global Investors | Frankfurt, Paris | Likely covered by Allianz Phenom scraper |

### Quant & systematic funds
| Company | HQ | Why not automated |
|---------|----|-------------------|
| Man Group | London / Zurich | Greenhouse EU board (`mangroup`) — automated |
| Brevan Howard | Geneva | Not on Greenhouse; ATS unknown |
| Squarepoint Capital | Geneva | Greenhouse (`squarepointcapital`) — automated |
| Qube Research & Technologies | London / Paris | Not on Greenhouse; ATS unknown |

### Paris asset managers
| Company | Why not automated |
|---------|-------------------|
| ~~Amundi~~ | TalentSoft HTML — automated via `scrape-amundi.mjs` (2026-05-16) |

---

## Resources for finding more companies

### quant-jobs-zurich (community-maintained list)
https://github.com/adrische/quant-jobs-zurich

Comprehensive curated list of quant finance employers in Zurich and Switzerland,
organized by category (banks, hedge funds, asset managers, insurers, consultancies).
Also includes a separate AI jobs list: https://github.com/adrische/AI-Jobs-Switzerland

Use this list when running out of companies to add. Check each career URL for
Workday/Greenhouse/Umantis patterns to determine if automation is possible.

**Leads already extracted from this list (not yet added to scanner):**

| Company | ATS found | URL from list |
|---------|-----------|---------------|
| ~~Julius Baer~~ | ~~Workday~~ | Moved to automated — boards `JB_Career_Site_Graduates` + `Internships` (2026-05-14) |
| Lombard Odier | Workday (`lombardodier.wd3`, board: `Lombard_Odier_Careers`) | `lombardodier.wd3.myworkdayjobs.com/Lombard_Odier_Careers` |
| Pictet | SuccessFactors (company code: `banquepict`) | `career5.successfactors.eu/career?company=banquepict` |
| ZKB | refline.ch (custom ATS, needs scraper) | `apply.refline.ch/792841/search.html` |
| Citi Zurich | Taleo | `jobs.citi.com/search-jobs/Zurich` |
| LGT Capital Partners | Custom | `lgtcp.com/en/careers/current-vacancies/` |
| Squarepoint Capital | Greenhouse (`squarepointcapital`) | `squarepoint-capital.com/open-opportunities` (Zug/London) |
| Worldquant | Custom | `worldquant.com/career-listing/?location=zug-switzerland` |
| RAM Active Investments | Custom | `ram-ai.com/de/careers/` |
| Swiss Re | Custom | `careers.swissre.com` |
| Zurich Insurance | Custom | `careers.zurich.com` |

---

## How to automate a websearch company

1. Visit their careers page and search for any open role
2. Look at the URL — if it contains `.myworkdayjobs.com`, note the `{tenant}`, `{instance}`, and `{board}` segments
3. Add to `COMPANIES` in `scrape-workday.mjs`:
   ```js
   { tenant: 'company', instance: 'wd3', board: 'Company_External', name: 'Company' }
   ```
4. Add entry to `portals.yml` with `scan_method: workday`
5. Test: `node scrape-workday.mjs --dry-run`

For non-Workday ATS systems, a custom scraper would need to be built (see existing scrapers as reference).

---

## Tracking status — plain summary

Last updated: 2026-05-16

### Automated daily scan ✅

These companies are scraped every day by `daily-scan.sh`. New matching jobs appear in your Telegram channel automatically.

Point72 — Greenhouse API
AQR Capital Management — Greenhouse API
Jane Street — Greenhouse API
Virtu Financial — Greenhouse API
IMC Trading — Greenhouse API
Optiver — Greenhouse API
Flow Traders — Greenhouse API
Winton Group — Greenhouse API
Marshall Wace — Greenhouse API
UBS — Playwright (intercepts Taleo internal API)
J. Safra Sarasin — Umantis API
AXA Switzerland — Umantis API
Rothschild & Co — Workday API
Vontobel — Workday API
Julius Baer — Workday API (two boards: graduates + internships)
Lombard Odier — Workday API
LGT Capital Partners — Workday API
PostFinance — SuccessFactors custom scraper
Helvetia — prospective.ch scraper
Generali Switzerland — prospective.ch scraper
Allianz — Phenom People scraper (~200 pages, runs slowly)
Pictet — SuccessFactors Playwright scraper (career012)
LGT Private Bank — plain HTTP (CoreMedia CMS fragment endpoint)
Swiss Re — Playwright (intercepts internal JSON API at swissre.com/bin/swissre/search)
Zurich Insurance — plain HTTP (server-rendered HTML, careers.zurich.com)
JPMorgan Chase — Oracle HCM CE REST API (plain HTTP, UK location filter)
Goldman Sachs — Higher GraphQL API (plain HTTP, higher.gs.com)
Man Group — Greenhouse API (slug: mangroup)
Squarepoint Capital — Greenhouse API (slug: squarepointcapital)
BlackRock — Radancy ATS (plain HTTP, 494 global jobs, client-side location filter)
Lazard — TAL / Oleeo board pages (plain HTTPS, lazard-careers.tal.net)
Morgan Stanley — Workday API (wd5 instance, External board, UK+Germany+France country filter)
Dimensional Fund Advisors — Workday API (wd5 instance, DFA_Careers board)
Schroders — Oracle HCM CE REST API (plain HTTP, 37 global jobs, client-side filter)
BNP Paribas — WordPress REST API (careers.bnpparibas.co.uk UK early-career portal, ~11 jobs)
Deutsche Bank — Beesite graduate search API (plain HTTP, ~21 graduate/internship roles)
HSBC — GroupGTI / Solr API (plain HTTP GET, hsbcearlycareers.groupgti.com, ~12 jobs)
Société Générale — CES / search-profile API (Playwright, OAuth token captured from page auto-search, ~242 Trainee+Internship roles)
Amundi — TalentSoft HTML (plain HTTP, jobs.amundi.com, France+Germany+UK+Luxembourg, ~134 jobs)
GAM Investments — Workday API (wd3 instance, GAM board, ~2 jobs)
Swiss Life Asset Managers — Workday API (wd3 instance, Swiss_Life_Asset_Managers_Career_Site board, ~46 jobs)
Leonteq — custom JSON API (careers.leonteq.com/publishedJobs.php, ~21 jobs)
SIX Group — SuccessFactors RMK HTML (jobs.six-group.com, ~108 jobs, 100/page)

### Not yet automated ❌

These companies are known targets but not yet in the daily scan. Reason noted where known.
ZKB (Zürcher Kantonalbank) — uses refline.ch, a Swiss niche ATS. Needs a custom scraper.
Unigestion — custom ATS, not investigated.
Baloise Group — custom ATS (merging with Helvetia in 2026 — monitor both).
Brevan Howard — ATS unknown.
Squarepoint Capital — custom site (squarepoint-capital.com), no standard ATS detected.
Qube Research & Technologies — ATS unknown.
RAM Active Investments — custom site (ram-ai.com), no standard ATS detected.
Worldquant — custom site (worldquant.com), no standard ATS detected.
