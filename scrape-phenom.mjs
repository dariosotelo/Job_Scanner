#!/usr/bin/env node
/**
 * scrape-phenom.mjs
 * Generic scraper for companies using the Phenom People career platform.
 *
 * Phenom People is client-side rendered — server-side location filtering via URL params
 * does not work. Strategy: fetch ALL pages, parse the embedded JSON job data, then apply
 * portals.yml title + location filters client-side.
 *
 * Add any Phenom People tenant to the COMPANIES list below.
 *
 * Usage:
 *   node scrape-phenom.mjs            # real run
 *   node scrape-phenom.mjs --dry-run  # preview without writing
 */

import { readFileSync, appendFileSync, existsSync, writeFileSync } from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const dotenv  = require('dotenv');
const yaml    = require('js-yaml');
dotenv.config();

const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const DRY_RUN = process.argv.includes('--dry-run');

const PAGE_SIZE   = 10;   // Phenom People hard-caps at 10 results per page
const CONCURRENCY = 5;    // simultaneous page requests per batch
const DELAY_MS    = 800;  // ms between batches (rate limiting)

// ── Companies using Phenom People ────────────────────────────────
// baseUrl:      search-results page (include ?s=1 or equivalent)
// applyUrlBase: prefix for constructing per-job apply URLs (append &career_job_req_id={id}&career_ns=job_application)
// name:         display name
const COMPANIES = [
  {
    baseUrl:      'https://careers.allianz.com/ch/de/search-results?s=1',
    applyUrlBase: 'https://career5.successfactors.eu/careers?company=AZGROUPPROD',
    name:         'Allianz',
  },
  // Add more Phenom People tenants here, e.g.:
  // { baseUrl: 'https://careers.example.com/en/search-results?s=1', applyUrlBase: '...', name: 'Example' },
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
    `${o.url}\t${date}\tphenom\t${o.title}\t${o.company}\tadded\t${o.location || ''}`
  ).join('\n') + '\n';
  appendFileSync(SCAN_HISTORY_PATH, lines, 'utf-8');
}

// ── Parser ────────────────────────────────────────────────────────

function decode(s) {
  return s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function extractField(ctx, name) {
  const m = new RegExp(`"${name}":"([^"]*?)"`).exec(ctx);
  return m ? decode(m[1]) : '';
}

// Each job record in the HTML has: "jobId":"N" as an anchor.
// We extract title, cityStateCountry (full location string), and construct the apply URL.
function parsePageJobs(html, companyName, applyUrlBase) {
  const jobs = [];

  for (const m of html.matchAll(/"jobId":"(\d+)"/g)) {
    const jobId = m[1];
    // Context window: 600 chars before (country, cityState) and 800 after (title, unit)
    const ctx = html.slice(Math.max(0, m.index - 600), m.index + 800);

    const title    = extractField(ctx, 'title');
    const location = extractField(ctx, 'cityStateCountry') || extractField(ctx, 'cityState');

    if (!title) continue; // skip malformed records

    const url = `${applyUrlBase}&career_job_req_id=${jobId}&career_ns=job_application`;
    jobs.push({ title, url, location: decode(location), company: companyName, jobId });
  }

  return jobs;
}

// ── HTTP helper ───────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchPage(baseUrl, offset) {
  const sep = baseUrl.includes('?') ? '&' : '?';
  const url = offset === 0 ? baseUrl : `${baseUrl}${sep}from=${offset}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept':          'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} at offset ${offset}`);
  return res.text();
}

// ── Scraper ───────────────────────────────────────────────────────

async function scrapeCompany(company, filters, seenUrls) {
  const allJobs = new Map(); // jobId → job (dedup within run)
  let offset = 0;
  let done   = false;

  while (!done) {
    // Fetch a batch of pages concurrently
    const offsets = Array.from({ length: CONCURRENCY }, (_, i) => offset + i * PAGE_SIZE);
    const pages   = await Promise.allSettled(offsets.map(o => fetchPage(company.baseUrl, o)));

    for (const result of pages) {
      if (result.status === 'rejected') continue;
      const html = result.value;

      // No job records on this page → we've passed the end of all listings
      if (!html.includes('"jobId"')) { done = true; break; }

      for (const j of parsePageJobs(html, company.name, company.applyUrlBase)) {
        allJobs.set(j.jobId, j);
      }
    }

    offset += CONCURRENCY * PAGE_SIZE;
    if (!done) await sleep(DELAY_MS);
  }

  const total = allJobs.size;
  console.log(`${company.name}: ${total} total job(s) scanned`);

  const newOffers = [...allJobs.values()]
    .filter(j => titleMatches(j.title, filters))
    .filter(j => locationMatches(j.location, filters))
    .filter(j => !seenUrls.has(j.url));

  console.log(`${company.name}: ${newOffers.length} new relevant offer(s)`);
  newOffers.forEach(o => console.log(`  + ${o.title} | ${o.location || 'N/A'}`));

  return newOffers;
}

// ── Main ─────────────────────────────────────────────────────────

async function main() {
  const filters  = loadFilters();
  const seenUrls = loadSeenUrls();
  const allNew   = [];

  for (const company of COMPANIES) {
    try {
      const offers = await scrapeCompany(company, filters, seenUrls);
      allNew.push(...offers);
    } catch (err) {
      console.error(`  ✗ ${company.name}: ${err.message}`);
    }
    await sleep(2000);
  }

  if (allNew.length > 0 && !DRY_RUN) {
    appendToHistory(allNew);
    console.log(`\nSaved ${allNew.length} offer(s) to scan-history.tsv`);
  }

  if (DRY_RUN) console.log('\n(dry run — nothing written)');
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
