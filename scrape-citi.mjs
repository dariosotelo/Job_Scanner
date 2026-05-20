#!/usr/bin/env node
/**
 * scrape-citi.mjs
 * Scrapes Citi job listings for Switzerland (jobs.citi.com — TalentBrew by Radancy).
 *
 * The site is server-rendered; plain HTTP GET returns full job data with no JS
 * execution required. Fetches the Switzerland location page and paginates via ?p=N.
 *
 * Entry point:
 *   https://jobs.citi.com/location/switzerland-jobs/287/2658434/2
 *   (covers Zurich and Geneva; 287 = Citi org ID, 2658434 = Switzerland GeoName ID)
 *
 * Usage:
 *   node scrape-citi.mjs            # real run
 *   node scrape-citi.mjs --dry-run  # preview without writing
 */

import { readFileSync, appendFileSync, existsSync, writeFileSync } from 'fs';
import { createRequire } from 'module';

const _require = createRequire(import.meta.url);
const yaml     = _require('js-yaml');
_require('dotenv').config();

const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const DRY_RUN = process.argv.includes('--dry-run');

const BASE_URL     = 'https://jobs.citi.com';
const LOCATION_URL = `${BASE_URL}/location/switzerland-jobs/287/2658434/2`;
const HEADERS      = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
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
    `${o.url}\t${date}\tciti\t${o.title}\tCiti\tadded\t${o.location || ''}`
  ).join('\n') + '\n';
  appendFileSync(SCAN_HISTORY_PATH, lines, 'utf-8');
}

// ── Fetch & parse ─────────────────────────────────────────────────

async function fetchPage(page) {
  const url = page === 1 ? LOCATION_URL : `${LOCATION_URL}?p=${page}`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} on page ${page}`);
  return res.text();
}

function parsePage(html) {
  const sectionM = html.match(/data-total-pages="(\d+)"/);
  const totalPages = sectionM ? parseInt(sectionM[1], 10) : 1;

  const jobs = [];
  const blocks = [...html.matchAll(/<li class="sr-job-item">([\s\S]*?)<\/li>/g)];
  for (const [, block] of blocks) {
    const hrefM  = block.match(/href="(\/job\/[^"]+)"/);
    const titleM = block.match(/<a class="sr-job-item__link"[^>]*>\s*([\s\S]*?)\s*<\/a>/);
    const locM   = block.match(/sr-job-location">([^<]+)<\/span>/);
    if (!hrefM || !titleM) continue;
    jobs.push({
      url:      BASE_URL + hrefM[1],
      title:    titleM[1].trim(),
      location: locM ? locM[1].trim() : '',
    });
  }

  return { totalPages, jobs };
}

async function fetchAllJobs() {
  const html1 = await fetchPage(1);
  const { totalPages, jobs: allJobs } = parsePage(html1);

  for (let p = 2; p <= totalPages; p++) {
    await new Promise(r => setTimeout(r, 400));
    const html = await fetchPage(p);
    const { jobs } = parsePage(html);
    if (jobs.length === 0) break;
    allJobs.push(...jobs);
  }

  return allJobs;
}

// ── Main ─────────────────────────────────────────────────────────

async function main() {
  const filters  = loadFilters();
  const seenUrls = loadSeenUrls();

  const allJobs = await fetchAllJobs();
  console.log(`Citi: ${allJobs.length} job(s) found in Switzerland`);

  const newOffers = allJobs
    .filter(j => titleMatches(j.title, filters))
    .filter(j => locationMatches(j.location, filters))
    .filter(j => !seenUrls.has(j.url));

  console.log(`Citi: ${newOffers.length} new relevant match(es)`);
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
