#!/usr/bin/env node
/**
 * scrape-blackrock.mjs
 * Scrapes BlackRock job listings from careers.blackrock.com (Radancy ATS).
 *
 * The site returns 494+ jobs globally via a plain HTTP JSON endpoint that
 * wraps HTML in a JSON response body. No browser / Playwright needed.
 *
 * Endpoint:
 *   GET https://careers.blackrock.com/search-jobs/results
 *   Params: ActiveFacetID=45831, CurrentPage=N, RecordsPerPage=25,
 *           IsPagination=True (page 2+), SortCriteria=0, SearchType=5
 *
 * Jobs are filtered client-side by portals.yml title + location rules.
 * BlackRock has UK (London, Edinburgh) and Zurich offices — both are in
 * the portals.yml allow list.
 *
 * Usage:
 *   node scrape-blackrock.mjs            # real run
 *   node scrape-blackrock.mjs --dry-run  # preview without writing
 */

import { readFileSync, appendFileSync, existsSync, writeFileSync } from 'fs';
import { createRequire } from 'module';

const _require = createRequire(import.meta.url);
const yaml     = _require('js-yaml');
_require('dotenv').config();

const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const DRY_RUN = process.argv.includes('--dry-run');

const BASE_URL   = 'https://careers.blackrock.com';
const SITE_ID    = 45831;
const PAGE_SIZE  = 25;
const MAX_PAGES  = 40;

// ── Filters ──────────────────────────────────────────────────────

function loadFilters() {
  const config = yaml.load(readFileSync('portals.yml', 'utf-8'));
  return {
    positive: (config.title_filter?.positive || []).map(s => s.toLowerCase()),
    negative: (config.title_filter?.negative || []).map(s => s.toLowerCase()),
    allowLoc: (config.location_filter?.allow  || []).map(s => s.toLowerCase()),
    blockLoc: (config.location_filter?.block  || []).map(s => s.toLowerCase()),
  };
}

function titleMatches(title, { positive, negative }) {
  const t = title.toLowerCase();
  if (negative.some(n => t.includes(n))) return false;
  return positive.some(p => t.includes(p));
}

function locationMatches(location, { allowLoc, blockLoc }) {
  if (!location) return true;
  const l = location.toLowerCase();
  if (blockLoc.some(b => l.includes(b))) return false;
  if (allowLoc.length === 0) return true;
  return allowLoc.some(a => l.includes(a));
}

function loadSeenUrls() {
  if (!existsSync(SCAN_HISTORY_PATH)) return new Set();
  const lines = readFileSync(SCAN_HISTORY_PATH, 'utf-8').trim().split('\n').slice(1);
  return new Set(lines.map(l => l.split('\t')[0]).filter(Boolean));
}

function appendToHistory(offers) {
  if (!existsSync(SCAN_HISTORY_PATH)) {
    writeFileSync(SCAN_HISTORY_PATH, 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\n');
  }
  const date = new Date().toISOString().slice(0, 10);
  const lines = offers.map(o =>
    `${o.url}\t${date}\tblackrock\t${o.title}\tBlackRock\tadded\t${o.location || ''}`
  ).join('\n') + '\n';
  appendFileSync(SCAN_HISTORY_PATH, lines, 'utf-8');
}

// ── Fetch & parse ─────────────────────────────────────────────────

function buildUrl(page) {
  const params = new URLSearchParams({
    ActiveFacetID:              SITE_ID,
    CurrentPage:                page,
    RecordsPerPage:             PAGE_SIZE,
    Distance:                   50,
    RadiusUnitType:             0,
    Keywords:                   '',
    Location:                   '',
    ShowRadius:                 'False',
    IsPagination:               page > 1 ? 'True' : 'False',
    FacetTerm:                  '',
    FacetType:                  0,
    SearchResultsModuleName:    'Section 3 - Search Results',
    SearchFiltersModuleName:    'Section 3 - Search Filters',
    SortCriteria:               0,
    SortDirection:              0,
    SearchType:                 5,
    PostalCode:                 '',
    ResultsType:                0,
  });
  return `${BASE_URL}/search-jobs/results?${params}`;
}

async function fetchPage(page) {
  const res = await fetch(buildUrl(page), {
    headers: {
      'User-Agent':        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'X-Requested-With':  'XMLHttpRequest',
      'Accept':            'application/json, text/javascript, */*',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} on page ${page}`);
  return res.json();
}

function parseHtml(html) {
  const jobs = [];
  const blocks = html.match(/<li class="section3__search-results-li">([\s\S]*?)<\/li>/g) || [];
  for (const block of blocks) {
    const hrefM  = block.match(/href="(\/job\/[^"]+\/\d+\/(\d+))"/);
    const titleM = block.match(/<h2 class="section3__job-title">([^<]+)<\/h2>/);
    const locM   = block.match(/<span class="section3__job-info">([^<]+)<\/span>/);
    if (!hrefM || !titleM) continue;
    jobs.push({
      url:      BASE_URL + hrefM[1],
      title:    titleM[1].trim().replace(/&#x2[0-9A-F];|&amp;|&#x[\dA-F]+;/gi, s => {
        const decoded = { '&#x2013;': '–', '&#x2014;': '—', '&#x202f;': ' ', '&amp;': '&' };
        return decoded[s] ?? s;
      }),
      location: locM ? locM[1].trim() : '',
    });
  }
  return jobs;
}

async function fetchAllJobs() {
  const first   = await fetchPage(1);
  const html1   = first.results || '';
  const totalM  = html1.match(/data-total-results="(\d+)"/);
  const pagesM  = html1.match(/data-total-pages="(\d+)"/);
  const total   = totalM ? parseInt(totalM[1], 10) : 0;
  const pages   = pagesM ? parseInt(pagesM[1], 10) : 1;

  const allJobs = parseHtml(html1);

  for (let p = 2; p <= Math.min(pages, MAX_PAGES); p++) {
    await new Promise(r => setTimeout(r, 300));
    const data     = await fetchPage(p);
    const pageJobs = parseHtml(data.results || '');
    if (pageJobs.length === 0) break;
    allJobs.push(...pageJobs);
  }

  return { total, jobs: allJobs };
}

// ── Main ─────────────────────────────────────────────────────────

async function main() {
  const filters  = loadFilters();
  const seenUrls = loadSeenUrls();

  const { total, jobs: allJobs } = await fetchAllJobs();
  console.log(`BlackRock: ${allJobs.length} job(s) fetched (${total} reported)`);

  const newOffers = allJobs
    .filter(j => titleMatches(j.title, filters))
    .filter(j => locationMatches(j.location, filters))
    .filter(j => !seenUrls.has(j.url));

  console.log(`BlackRock: ${newOffers.length} new relevant match(es)`);
  newOffers.forEach(o => console.log(`  + ${o.title} | ${o.location || 'N/A'}`));

  if (newOffers.length > 0 && !DRY_RUN) {
    appendToHistory(newOffers);
    console.log(`Saved ${newOffers.length} new job(s) to scan-history.tsv`);
  }

  if (DRY_RUN) console.log('(dry run — nothing written)');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
