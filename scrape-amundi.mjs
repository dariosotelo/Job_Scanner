#!/usr/bin/env node
/**
 * scrape-amundi.mjs
 * Scrapes Amundi job listings from their TalentSoft-based careers site.
 *
 * Site: https://jobs.amundi.com/job/list-of-jobs.aspx
 * ATS:  TalentSoft (Cegid) — server-rendered HTML, plain HTTP, no auth required.
 *
 * Pagination: ?page=N (50 items per page, wraps on overflow).
 * Country filter: ?changefacet=1&facet_JobCountry={ID} per-request.
 *
 * Target countries (IDs from facet sidebar — May 2026):
 *   France       → 79  (~107 jobs)
 *   Germany      → 29  (~9 jobs)
 *   United Kingdom → 162 (~5 jobs)
 *   Luxembourg   → 119 (~13 jobs)
 *
 * Job URL:   https://jobs.amundi.com/offre-de-emploi/emploi-{slug}_{id}.aspx
 * Location:  set to country name (no city in listing pages; filtering at country level)
 *
 * Usage:
 *   node scrape-amundi.mjs            # real run
 *   node scrape-amundi.mjs --dry-run  # preview without writing
 */

import { readFileSync, appendFileSync, existsSync, writeFileSync } from 'fs';
import { createRequire } from 'module';

const _require = createRequire(import.meta.url);
const yaml     = _require('js-yaml');
_require('dotenv').config();

const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const DRY_RUN = process.argv.includes('--dry-run');

const BASE_URL   = 'https://jobs.amundi.com';
const LIST_PATH  = '/job/list-of-jobs.aspx';
const PAGE_SIZE  = 50;

// Country facet IDs → display name for location field
const TARGET_COUNTRIES = [
  { id: 79,  name: 'Paris, France' },
  { id: 29,  name: 'Germany' },
  { id: 162, name: 'London, United Kingdom' },
  { id: 119, name: 'Luxembourg' },
];

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  'Accept': 'text/html,application/xhtml+xml',
};

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
    `${o.url}\t${date}\tamundi\t${o.title}\tAmundi\tadded\t${o.location || ''}`
  ).join('\n') + '\n';
  appendFileSync(SCAN_HISTORY_PATH, lines, 'utf-8');
}

// ── HTML parsing ──────────────────────────────────────────────────

function decodeHtml(str) {
  return str
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

function parseJobsFromHtml(html, location) {
  // Split on each list item boundary
  const blocks = html.split('<li').slice(1);
  const jobs = [];
  for (const block of blocks) {
    if (!block.includes('offerlist-item')) continue;
    // URL from onclick
    const urlM = block.match(/location\.href='(\/offre-de-emploi\/[^']+)'/);
    if (!urlM) continue;
    const url = `${BASE_URL}${urlM[1]}`;
    // Title from the anchor inside h3
    const titleM = block.match(/ts-offer-list-item__title-link[^>]+>\s*([^<]+)/);
    if (!titleM) continue;
    const title = decodeHtml(titleM[1].trim());
    if (title) jobs.push({ title, url, location });
  }
  return jobs;
}

function getTotalFromHtml(html) {
  const m = html.match(/(\d+)\s*offre/i);
  return m ? Number(m[1]) : 0;
}

// ── Fetching ──────────────────────────────────────────────────────

async function fetchCountryJobs(countryId, countryName) {
  const jobs  = [];
  let   page  = 1;
  let   total = null;

  while (true) {
    const params = new URLSearchParams({
      changefacet:    '1',
      facet_JobCountry: String(countryId),
      page:           String(page),
    });
    const url = `${BASE_URL}${LIST_PATH}?${params}`;
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${countryName} page ${page}`);
    const html = await res.text();

    if (total === null) {
      total = getTotalFromHtml(html);
      console.log(`Amundi (${countryName}): ${total} total job(s)`);
    }

    const pageJobs = parseJobsFromHtml(html, countryName);
    if (pageJobs.length === 0) break;
    jobs.push(...pageJobs);

    if (jobs.length >= total) break;
    page++;
    await new Promise(r => setTimeout(r, 400));
  }

  return jobs;
}

// ── Main ─────────────────────────────────────────────────────────

async function main() {
  const filters  = loadFilters();
  const seenUrls = loadSeenUrls();

  const allJobs = [];
  for (const country of TARGET_COUNTRIES) {
    try {
      const jobs = await fetchCountryJobs(country.id, country.name);
      allJobs.push(...jobs);
    } catch (err) {
      console.error(`Amundi (${country.name}): ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`Amundi: ${allJobs.length} job(s) fetched across target countries`);

  const newOffers = allJobs
    .filter(j => titleMatches(j.title, filters))
    .filter(j => locationMatches(j.location, filters))
    .filter(j => !seenUrls.has(j.url));

  console.log(`Amundi: ${newOffers.length} new relevant match(es)`);
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
