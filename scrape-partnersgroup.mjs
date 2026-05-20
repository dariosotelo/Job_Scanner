#!/usr/bin/env node
/**
 * scrape-partnersgroup.mjs
 * Scrapes Partners Group job listings (Zug HQ + other locations).
 *
 * Uses the IDX (connectid.cloud) middleware API that sits in front of their
 * SAP SuccessFactors instance. Plain HTTP POST — no browser needed.
 *
 * Endpoint:
 *   POST https://idxatsportal-prod-api.connectid.cloud/api/clients/67/jobs
 *   Body: { page: N, pageSize: 100 }
 *   Auth: static Bearer token from public JS (partnersgroup.com/en/javascripts/shared/jobs-ats.js)
 *
 * Job detail URL:
 *   https://www.partnersgroup.com/en/careers/open-positions/job-details/{jobreqid}
 *
 * Usage:
 *   node scrape-partnersgroup.mjs            # real run
 *   node scrape-partnersgroup.mjs --dry-run  # preview without writing
 */

import { readFileSync, appendFileSync, existsSync, writeFileSync } from 'fs';
import { createRequire } from 'module';

const _require = createRequire(import.meta.url);
const yaml     = _require('js-yaml');
_require('dotenv').config();

const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const DRY_RUN = process.argv.includes('--dry-run');

const API_URL    = 'https://idxatsportal-prod-api.connectid.cloud/api/clients/67/jobs';
const DETAIL_URL = 'https://www.partnersgroup.com/en/careers/open-positions/job-details';
const PAGE_SIZE  = 100;

// Static token embedded in partnersgroup.com/en/javascripts/shared/jobs-ats.js
const BEARER_TOKEN = '56f067aa86809e1165da1621d1edbb9b6bcda4fc36b297be4fc1e5e1da4c2d230a5c81d040cdfa994ecf9c2d1c05b9cb00d36527d73ed6611b695af86c049f80';

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
    `${o.url}\t${date}\tpartnersgroup\t${o.title}\tPartners Group\tadded\t${o.location || ''}`
  ).join('\n') + '\n';
  appendFileSync(SCAN_HISTORY_PATH, lines, 'utf-8');
}

// ── Fetch ─────────────────────────────────────────────────────────

async function fetchPage(page) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${BEARER_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ page, pageSize: PAGE_SIZE }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} on page ${page}`);
  return res.json();
}

async function fetchAllJobs() {
  const first = await fetchPage(1);
  const totalPages = first.meta?.totalPages ?? 1;
  const allJobs = first.jobs ?? [];

  for (let p = 2; p <= totalPages; p++) {
    await new Promise(r => setTimeout(r, 400));
    const data = await fetchPage(p);
    allJobs.push(...(data.jobs ?? []));
  }

  return { total: first.meta?.totalCount ?? allJobs.length, jobs: allJobs };
}

// ── Main ─────────────────────────────────────────────────────────

async function main() {
  const filters  = loadFilters();
  const seenUrls = loadSeenUrls();

  const { total, jobs: allJobs } = await fetchAllJobs();
  console.log(`Partners Group: ${allJobs.length} job(s) fetched (${total} reported)`);

  const offers = allJobs.map(j => ({
    url:      `${DETAIL_URL}/${j.jobreqid}`,
    title:    j.externaltitle?.trim() || j.jobtitle?.trim() || '',
    location: j.location?.trim() || '',
  }));

  const newOffers = offers
    .filter(j => titleMatches(j.title, filters))
    .filter(j => locationMatches(j.location, filters))
    .filter(j => !seenUrls.has(j.url));

  console.log(`Partners Group: ${newOffers.length} new relevant match(es)`);
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
