#!/bin/bash
# daily-scan.sh — Scan portals + UBS + notify via Telegram if new jobs found.

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO_DIR"

LOG="$REPO_DIR/data/daily-scan.log"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting scan..." >> "$LOG"

# 1. Zero-token API scanner (Greenhouse/Ashby/Lever companies)
node scan.mjs >> "$LOG" 2>&1

# 2. UBS Playwright scraper (Taleo — no public API)
node scrape-ubs.mjs >> "$LOG" 2>&1

# 3. Umantis scraper (J. Safra Sarasin and other Umantis companies)
node scrape-umantis.mjs >> "$LOG" 2>&1

# 4. Workday scraper (Rothschild & Co, Morgan Stanley, and other Workday companies)
node scrape-workday.mjs >> "$LOG" 2>&1

# 5. PostFinance / Swiss Post group scraper (SuccessFactors-based)
node scrape-postfinance.mjs >> "$LOG" 2>&1

# 6. Prospective.ch scraper (Helvetia and other Swiss companies on this platform)
node scrape-prospective.mjs >> "$LOG" 2>&1

# 7. Phenom People scraper (Allianz and other Phenom People companies)
node scrape-phenom.mjs >> "$LOG" 2>&1

# 8. SuccessFactors Playwright scraper (Pictet and other SF companies)
node scrape-successfactors.mjs >> "$LOG" 2>&1

# 9. LGT Private Bank scraper (CoreMedia CMS, plain HTTP)
node scrape-lgt.mjs >> "$LOG" 2>&1

# 10. Swiss Re scraper (Cloudflare-protected JSON API via Playwright)
node scrape-swissre.mjs >> "$LOG" 2>&1

# 11. Zurich Insurance scraper (server-rendered HTML, plain HTTP)
node scrape-zurich.mjs >> "$LOG" 2>&1

# 12. JPMorgan Chase scraper (Oracle HCM Candidate Experience REST API)
node scrape-jpmorgan.mjs >> "$LOG" 2>&1

# 13. Goldman Sachs scraper (Higher public GraphQL endpoint)
node scrape-goldman.mjs >> "$LOG" 2>&1

# 14. BlackRock scraper (Radancy ATS, plain HTTP)
node scrape-blackrock.mjs >> "$LOG" 2>&1

# 15. Lazard scraper (TAL / Oleeo board pages over plain HTTPS)
node scrape-lazard.mjs >> "$LOG" 2>&1

# 16. Schroders scraper (Oracle HCM Candidate Experience REST API)
node scrape-schroders.mjs >> "$LOG" 2>&1

# 17. Notify Telegram if anything new was found today
node notify-telegram.mjs >> "$LOG" 2>&1

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Done." >> "$LOG"
