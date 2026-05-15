#!/usr/bin/env node
/**
 * scrape-swissre.mjs
 * Scrapes Swiss Re job listings by intercepting their internal JSON search API.
 *
 * Swiss Re's jobSearch.html page calls:
 *   GET https://www.swissre.com/bin/swissre/search?query=&language=en&type=career
 *                                                &employment-type=...&offset=N&rows=10
 *
 * This API is Cloudflare-protected — direct fetch/curl returns a challenge page.
 * Playwright bypasses it; subsequent pages are fetched from within the browser
 * context (via page.evaluate) so the session and cookies are inherited.
 *
 * Usage:
 *   node scrape-swissre.mjs            # real run
 *   node scrape-swissre.mjs --dry-run  # preview without writing
 */

import { readFileSync, appendFileSync, existsSync, writeFileSync } from 'fs';
import { chromium } from 'playwright';
import { createRequire } from 'module';

const _require = createRequire(import.meta.url);
const yaml     = _require('js-yaml');
_require('dotenv').config();

const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const DRY_RUN = process.argv.includes('--dry-run');

const BASE_URL = 'https://www.swissre.com';

// Employment types to include — entry-level / junior / internship programmes only
const EMPLOYMENT_TYPES = ['Internship', 'JuniorPower@swissre', 'Apprentices@swissre'];

const ROWS_PER_PAGE = 10;

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
    `${o.url}\t${date}\tswissre\t${o.title}\tSwiss Re\tadded\t${o.location || ''}`
  ).join('\n') + '\n';
  appendFileSync(SCAN_HISTORY_PATH, lines, 'utf-8');
}

// ── API helpers ───────────────────────────────────────────────────

function buildSearchUrl(offset) {
  const params = new URLSearchParams({
    query:    '',
    language: 'en',
    type:     'career',
    offset:   String(offset),
    rows:     String(ROWS_PER_PAGE),
  });
  for (const et of EMPLOYMENT_TYPES) {
    params.append('employment-type', et);
  }
  return `${BASE_URL}/bin/swissre/search?${params.toString()}`;
}

function buildStartUrl() {
  const params = new URLSearchParams({ searchterm: '' });
  for (const et of EMPLOYMENT_TYPES) {
    params.append('employment-type', et);
  }
  return `${BASE_URL}/careers/jobSearch.html?${params.toString()}`;
}

function parsePositions(data) {
  return (data.positions || []).map(p => ({
    title:    (p.title || '').trim(),
    location: [p.city, p.country].filter(Boolean).join(', '),
    url:      BASE_URL + (p.applyUrl || ''),
  })).filter(p => p.title && p.url !== BASE_URL);
}

// ── Main ─────────────────────────────────────────────────────────

async function scrapeSwissRe() {
  const filters  = loadFilters();
  const seenUrls = loadSeenUrls();

  const browser = await chromium.launch({ headless: true });
  const page    = await browser.newPage();

  let firstPageData = null;

  // Intercept the first API response to get total count
  page.on('response', async resp => {
    if (resp.url().includes('/bin/swissre/search') && firstPageData === null) {
      try {
        firstPageData = await resp.json();
      } catch {}
    }
  });

  console.log('Swiss Re: connecting to careers portal...');
  await page.goto(buildStartUrl(), { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForTimeout(4000);

  if (!firstPageData) {
    console.log('Swiss Re: no API response intercepted — page may not have loaded jobs');
    await browser.close();
    return [];
  }

  const total = firstPageData.total || 0;
  const allJobs = parsePositions(firstPageData);
  console.log(`Swiss Re: ${total} total job(s) matching employment-type filters`);

  // Fetch remaining pages from within the browser context (inherits CF session)
  const totalPages = Math.ceil(total / ROWS_PER_PAGE);
  for (let page_n = 2; page_n <= Math.min(totalPages, 50); page_n++) {
    const offset = (page_n - 1) * ROWS_PER_PAGE;
    const url    = buildSearchUrl(offset);
    try {
      const data = await page.evaluate(async (fetchUrl) => {
        const resp = await fetch(fetchUrl, { credentials: 'include' });
        return resp.json();
      }, url);
      allJobs.push(...parsePositions(data));
    } catch (err) {
      console.error(`Swiss Re: page ${page_n} failed — ${err.message}`);
      break;
    }
    await page.waitForTimeout(500);
  }

  await browser.close();

  console.log(`Swiss Re: ${allJobs.length} job(s) collected`);

  const newOffers = allJobs
    .filter(j => titleMatches(j.title, filters))
    .filter(j => locationMatches(j.location, filters))
    .filter(j => !seenUrls.has(j.url));

  console.log(`Swiss Re: ${newOffers.length} new relevant match(es)`);
  newOffers.forEach(o => console.log(`  + ${o.title} | ${o.location || 'N/A'}`));

  if (newOffers.length > 0 && !DRY_RUN) {
    appendToHistory(newOffers);
    console.log(`Saved ${newOffers.length} new job(s) to scan-history.tsv`);
  }

  if (DRY_RUN) console.log('(dry run — nothing written)');
  return newOffers;
}

scrapeSwissRe().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
