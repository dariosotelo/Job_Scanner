#!/bin/bash
# daily-scan.sh — Scan portals + UBS + notify via Telegram if new jobs found.

# Ensure Homebrew binaries (node, npx) are on PATH when run via launchd
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO_DIR"

LOG="$REPO_DIR/data/daily-scan.log"
FAILURES_FILE="$REPO_DIR/data/last-run-failures.txt"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting scan..." >> "$LOG"

# Clear failures from the previous run
> "$FAILURES_FILE"

# Run a scraper step; log any non-zero exit to both the log and failures file.
run_step() {
  local label="$1"; shift
  "$@" >> "$LOG" 2>&1
  local code=$?
  if [[ $code -ne 0 ]]; then
    echo "$label" >> "$FAILURES_FILE"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: $label exited with code $code" >> "$LOG"
  fi
}

# 1. Zero-token API scanner (Greenhouse/Ashby/Lever companies)
run_step "scan.mjs" node scan.mjs

# 2. UBS Playwright scraper (Taleo — no public API)
run_step "scrape-ubs.mjs" node scrape-ubs.mjs

# 3. Umantis scraper (J. Safra Sarasin and other Umantis companies)
run_step "scrape-umantis.mjs" node scrape-umantis.mjs

# 4. Workday scraper (Rothschild & Co, Morgan Stanley, and other Workday companies)
run_step "scrape-workday.mjs" node scrape-workday.mjs

# 5. PostFinance / Swiss Post group scraper (SuccessFactors-based)
run_step "scrape-postfinance.mjs" node scrape-postfinance.mjs

# 6. Prospective.ch scraper (Helvetia and other Swiss companies on this platform)
run_step "scrape-prospective.mjs" node scrape-prospective.mjs

# 7. Phenom People scraper (Allianz and other Phenom People companies)
run_step "scrape-phenom.mjs" node scrape-phenom.mjs

# 8. SuccessFactors Playwright scraper (Pictet and other SF companies)
run_step "scrape-successfactors.mjs" node scrape-successfactors.mjs

# 9. LGT Private Bank scraper (CoreMedia CMS, plain HTTP)
run_step "scrape-lgt.mjs" node scrape-lgt.mjs

# 10. Swiss Re scraper (Cloudflare-protected JSON API via Playwright)
run_step "scrape-swissre.mjs" node scrape-swissre.mjs

# 11. Zurich Insurance scraper (server-rendered HTML, plain HTTP)
run_step "scrape-zurich.mjs" node scrape-zurich.mjs

# 12. JPMorgan Chase scraper (Oracle HCM Candidate Experience REST API)
run_step "scrape-jpmorgan.mjs" node scrape-jpmorgan.mjs

# 13. Goldman Sachs scraper (Higher public GraphQL endpoint)
run_step "scrape-goldman.mjs" node scrape-goldman.mjs

# 14. BlackRock scraper (Radancy ATS, plain HTTP)
run_step "scrape-blackrock.mjs" node scrape-blackrock.mjs

# 15. Lazard scraper (TAL / Oleeo board pages over plain HTTPS)
run_step "scrape-lazard.mjs" node scrape-lazard.mjs

# 16. Schroders scraper (Oracle HCM Candidate Experience REST API)
run_step "scrape-schroders.mjs" node scrape-schroders.mjs

# 17. BNP Paribas scraper (WordPress REST API — UK early-career portal)
run_step "scrape-bnpparibas.mjs" node scrape-bnpparibas.mjs

# 18. Deutsche Bank scraper (Beesite graduate search API, plain HTTP)
run_step "scrape-deutschebank.mjs" node scrape-deutschebank.mjs

# 19. HSBC scraper (GroupGTI / Solr API, plain HTTP GET)
run_step "scrape-hsbc.mjs" node scrape-hsbc.mjs

# 20. Société Générale scraper (CES / search-profile API, OAuth via Playwright)
run_step "scrape-societegenerale.mjs" node scrape-societegenerale.mjs

# 21. Amundi scraper (TalentSoft HTML, plain HTTP)
run_step "scrape-amundi.mjs" node scrape-amundi.mjs

# 22. Leonteq scraper (custom JSON API, plain HTTP)
run_step "scrape-leonteq.mjs" node scrape-leonteq.mjs

# 23. SIX Group scraper (SuccessFactors RMK, server-rendered HTML)
run_step "scrape-six.mjs" node scrape-six.mjs

# 24. Citi scraper (TalentBrew by Radancy, server-rendered HTML, Switzerland location page)
run_step "scrape-citi.mjs" node scrape-citi.mjs

# 25. Partners Group scraper (IDX / connectid.cloud middleware over SuccessFactors, plain HTTP)
run_step "scrape-partnersgroup.mjs" node scrape-partnersgroup.mjs

# 26. Notify Telegram — new jobs summary + any scraper errors
run_step "notify-telegram.mjs" node notify-telegram.mjs

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Done." >> "$LOG"
