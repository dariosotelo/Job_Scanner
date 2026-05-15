#!/usr/bin/env node
/**
 * scrape-zurich.mjs
 * Scrapes Zurich Insurance job listings from careers.zurich.com.
 *
 * The page is server-side rendered HTML (SAP SuccessFactors behind the scenes,
 * but exposed as a plain HTML table — no Playwright needed).
 *
 * URL pattern:
 *   GET https://www.careers.zurich.com/search/?q=&locationsearch=Switzerland%2C+London&startrow=N
 * Returns 25 jobs per page. Pagination via startrow (0, 25, 50, ...).
 * Total job count is parsed from the "Results X to Y of Z" header on page 1.
 *
 * Usage:
 *   node scrape-zurich.mjs            # real run
 *   node scrape-zurich.mjs --dry-run  # preview without writing
 */

import { readFileSync, appendFileSync, existsSync, writeFileSync } from 'fs';
import { createRequire } from 'module';

const _require = createRequire(import.meta.url);
const yaml     = _require('js-yaml');
_require('dotenv').config();

const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const DRY_RUN = process.argv.includes('--dry-run');

const BASE_URL      = 'https://www.careers.zurich.com';
const PAGE_SIZE     = 25;
const LOCATION_PARAM = 'Switzerland%2C+London';

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
    `${o.url}\t${date}\tzurichinsurance\t${o.title}\tZurich Insurance\tadded\t${o.location || ''}`
  ).join('\n') + '\n';
  appendFileSync(SCAN_HISTORY_PATH, lines, 'utf-8');
}

// ── Fetch & parse ─────────────────────────────────────────────────

async function fetchPage(startrow) {
  const url = `${BASE_URL}/search/?q=&locationsearch=${LOCATION_PARAM}&startrow=${startrow}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} at startrow=${startrow}`);
  return res.text();
}

function parseTotal(html) {
  const m = html.match(/Results?\s+\d+\s+to\s+\d+\s+of\s+(\d+)/i);
  return m ? parseInt(m[1], 10) : 0;
}

function parseJobs(html) {
  const rows = html.match(/<tr class="data-row">([\s\S]*?)<\/tr>/g) || [];
  const jobs = [];
  for (const row of rows) {
    const titleM = row.match(
      /class="jobTitle hidden-phone">\s*<a href="(\/job\/[^"]+)"[^>]*>([^<]+)<\/a>/
    );
    const locM = row.match(
      /class="colLocation hidden-phone"[^>]*>[\s\S]*?<span class="jobLocation">\s*([^<]+?)\s*<\/span>/
    );
    if (!titleM) continue;
    jobs.push({
      url:      BASE_URL + titleM[1],
      title:    titleM[2].trim().replace(/&amp;/g, '&'),
      location: locM ? locM[1].trim().replace(/&amp;/g, '&') : '',
    });
  }
  return jobs;
}

async function fetchAllJobs() {
  const firstHtml = await fetchPage(0);
  const total     = parseTotal(firstHtml);
  const allJobs   = parseJobs(firstHtml);

  const totalPages = Math.ceil(total / PAGE_SIZE);
  for (let p = 1; p < Math.min(totalPages, 40); p++) {
    const html      = await fetchPage(p * PAGE_SIZE);
    const pageJobs  = parseJobs(html);
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
  console.log(`Zurich Insurance: ${allJobs.length} job(s) total (${total} reported)`);

  const newOffers = allJobs
    .filter(j => titleMatches(j.title, filters))
    .filter(j => locationMatches(j.location, filters))
    .filter(j => !seenUrls.has(j.url));

  console.log(`Zurich Insurance: ${newOffers.length} new relevant match(es)`);
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
