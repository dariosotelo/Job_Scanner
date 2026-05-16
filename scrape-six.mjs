#!/usr/bin/env node
/**
 * scrape-six.mjs
 * Scrapes SIX Group job listings from jobs.six-group.com (SuccessFactors RMK ATS).
 *
 * Server-rendered HTML — no browser needed.
 * Pagination: ?startrow=N (100 jobs per page).
 * Total: ~108 jobs globally; filtered client-side by title + location.
 *
 * Usage:
 *   node scrape-six.mjs            # real run
 *   node scrape-six.mjs --dry-run  # preview without writing
 */

import { readFileSync, appendFileSync, existsSync, writeFileSync } from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const yaml    = require('js-yaml');
require('dotenv').config();

const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const DRY_RUN = process.argv.includes('--dry-run');

const BASE_URL  = 'https://jobs.six-group.com';
const PAGE_SIZE = 100;

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
    `${o.url}\t${date}\tsix\t${o.title}\tSIX Group\tadded\t${o.location || ''}`
  ).join('\n') + '\n';
  appendFileSync(SCAN_HISTORY_PATH, lines, 'utf-8');
}

// ── Parser ────────────────────────────────────────────────────────

function parseJobs(html) {
  const jobs = [];
  const rowRegex = /class="data-row"[\s\S]*?class="jobTitle-link"\s+href="([^"]+)"[^>]*>([^<]+)<[\s\S]*?class="jobLocation"[^>]*>\s*([^<\n]+)/g;
  let m;
  while ((m = rowRegex.exec(html)) !== null) {
    jobs.push({
      url:      BASE_URL + m[1],
      title:    m[2].trim(),
      location: m[3].trim(),
    });
  }
  return jobs;
}

// ── Scraper ──────────────────────────────────────────────────────

async function main() {
  const filters  = loadFilters();
  const seenUrls = loadSeenUrls();

  // Fetch page 1 to get total count, then fetch remaining pages
  const allJobs = [];
  let startRow = 0;
  let total = null;

  while (true) {
    const url = `${BASE_URL}/search/?q=&optionsFacetsDD_country=&optionsFacetsDD_customfield1=&startrow=${startRow}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();

    if (total === null) {
      const m = html.match(/von <b>(\d+)<\/b>/);
      total = m ? parseInt(m[1]) : 0;
    }

    const jobs = parseJobs(html);
    allJobs.push(...jobs);

    startRow += PAGE_SIZE;
    if (startRow >= total || jobs.length === 0) break;
  }

  console.log(`SIX Group: ${allJobs.length} job(s) total`);

  const newOffers = allJobs
    .filter(j => titleMatches(j.title, filters))
    .filter(j => locationMatches(j.location, filters))
    .filter(j => !seenUrls.has(j.url));

  console.log(`SIX Group: ${newOffers.length} new relevant match(es)`);
  newOffers.forEach(o => console.log(`  + ${o.title} | ${o.location || 'N/A'}`));

  if (newOffers.length > 0 && !DRY_RUN) {
    appendToHistory(newOffers);
    console.log(`\nSaved ${newOffers.length} new job(s) to scan-history.tsv`);
  }

  if (DRY_RUN) console.log('\n(dry run — nothing written)');
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
