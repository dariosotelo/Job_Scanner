#!/usr/bin/env node
/**
 * scrape-postfinance.mjs
 * Scraper for the Swiss Post group jobs platform (job.post.ch).
 * Covers PostFinance (and can be extended to Post / PostAuto brands).
 * Pure HTTP fetch — no Playwright needed.
 *
 * API: POST https://jobs.postfinance.ch/services/recruiting/v1/jobs
 * URL: https://jobs.postfinance.ch/{brand}/job/{urlTitle}/{id}-{locale}
 *
 * Usage:
 *   node scrape-postfinance.mjs            # real run
 *   node scrape-postfinance.mjs --dry-run  # preview without writing
 */

import { readFileSync, appendFileSync, existsSync, writeFileSync } from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const dotenv  = require('dotenv');
const yaml    = require('js-yaml');
dotenv.config();

const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const DRY_RUN = process.argv.includes('--dry-run');

const API_URL = 'https://jobs.postfinance.ch/services/recruiting/v1/jobs';
const BASE_URL = 'https://jobs.postfinance.ch';

// ── Brands to scrape ─────────────────────────────────────────────
// brand: value passed to the API filter (must match exactly)
// name:  display name for notifications
const BRANDS = [
  { brand: 'PostFinance', name: 'PostFinance' },
  // { brand: 'default', name: 'Swiss Post' },   // add if Post group roles wanted
];

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
    `${o.url}\t${date}\tpostfinance\t${o.title}\t${o.company}\tadded\t${o.location || ''}`
  ).join('\n') + '\n';
  appendFileSync(SCAN_HISTORY_PATH, lines, 'utf-8');
}

// ── API ───────────────────────────────────────────────────────────

function buildJobUrl(job) {
  const brand   = job.brandUrl || 'default';
  const slug    = job.urlTitle || '';
  const locale  = (job.supportedLocales || ['de_DE'])[0];
  return `${BASE_URL}/${brand}/job/${slug}/${job.id}-${locale}`;
}

function parseLocation(job) {
  const locs = job.jobLocationShort || [];
  // Format: "City|Region|Canton|Country|ISO "
  return locs.map(l => l.split('|')[0].trim()).filter(Boolean).join(', ');
}

async function fetchBrandJobs(brand) {
  const jobs = [];
  let page  = 0;
  let total = Infinity;

  while (jobs.length < total) {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
      body: JSON.stringify({ locale: 'de_DE', pageNumber: page, sortBy: 'date', brand }),
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    if (page === 0) total = data.totalJobs ?? 0;

    const postings = (data.jobSearchResult || []).map(j => j.response);
    if (postings.length === 0) break;

    for (const p of postings) {
      jobs.push({
        title:    p.unifiedStandardTitle || '',
        location: parseLocation(p),
        url:      buildJobUrl(p),
        company:  brand,
      });
    }

    page++;
  }

  return jobs;
}

// ── Main ─────────────────────────────────────────────────────────

async function main() {
  const filters  = loadFilters();
  const seenUrls = loadSeenUrls();
  const allNew   = [];

  for (const { brand, name } of BRANDS) {
    try {
      const jobs = await fetchBrandJobs(brand);
      console.log(`${name}: ${jobs.length} job(s) total`);

      const newOffers = jobs
        .filter(j => titleMatches(j.title, filters))
        .filter(j => locationMatches(j.location, filters))
        .filter(j => !seenUrls.has(j.url));

      console.log(`${name}: ${newOffers.length} new relevant match(es)`);
      newOffers.forEach(o => console.log(`  + ${o.title} | ${o.location || 'N/A'}`));

      allNew.push(...newOffers);
    } catch (err) {
      console.error(`  ✗ ${name}: ${err.message}`);
    }
  }

  if (allNew.length > 0 && !DRY_RUN) {
    appendToHistory(allNew);
    console.log(`\nSaved ${allNew.length} new job(s) to scan-history.tsv`);
  }

  if (DRY_RUN) console.log('\n(dry run — nothing written)');
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
