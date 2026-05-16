#!/usr/bin/env node
/**
 * scrape-societegenerale.mjs
 * Scrapes Société Générale early-career listings by intercepting the internal
 * CES search proxy that the Drupal/Quantum JavaScript calls on page load.
 *
 * The CES endpoint (api.socgen.com) requires OAuth via SG SSO — direct HTTP
 * access is blocked. Playwright inherits the Drupal + Imperva session so the
 * browser's same-origin POST to /search-proxy.php works transparently.
 *
 * Approach (mirrors scrape-swissre.mjs):
 *   1. Navigate to the search page — the JS fires an initial search request.
 *   2. Intercept the /search-proxy.php response to get the first page.
 *   3. Paginate by calling the proxy from within the browser context (fetch
 *      inherits the established session).
 *
 * Contract types searched: GRADUATE_JOB (Trainee) + INTERNSHIP.
 * Language filter: English job postings only.
 *
 * Usage:
 *   node scrape-societegenerale.mjs            # real run
 *   node scrape-societegenerale.mjs --dry-run  # preview without writing
 */

import { readFileSync, appendFileSync, existsSync, writeFileSync } from 'fs';
import { chromium } from 'playwright';
import { createRequire } from 'module';

const _require = createRequire(import.meta.url);
const yaml     = _require('js-yaml');
_require('dotenv').config();

const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const DRY_RUN = process.argv.includes('--dry-run');

// Navigate with contract-type filters pre-set so the auto-search fires correctly.
// The page fires multiple proxy calls; we intercept the one with the job+contract filter.
const SEARCH_PAGE  = 'https://careers.societegenerale.com/en/search'
                   + '?refinementList%5BjobType%5D%5B0%5D=Trainee'
                   + '&refinementList%5BjobType%5D%5B1%5D=Internship';
const PROXY_PATH   = '/search-proxy.php';
const SKIP_COUNT   = 100;   // items per page (CES supports up to 100)

// CES contract type IDs (from drupalSettings.quantum.quantum_filters.refContrat.en)
const CONTRACT_TYPES = ['GRADUATE_JOB', 'INTERNSHIP'];

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
    `${o.url}\t${date}\tsocietegenerale\t${o.title}\tSociété Générale\tadded\t${o.location || ''}`
  ).join('\n') + '\n';
  appendFileSync(SCAN_HISTORY_PATH, lines, 'utf-8');
}

// ── CES search helpers ────────────────────────────────────────────

// Exact body format captured from browser DevTools (CamelCase keys, typed advanced filter)
function buildSearchBody(skipFrom) {
  return JSON.stringify({
    profile:      'ces_profile_sgcareers',
    query: {
      advanced: [
        { type: 'simple', name: 'sourcestr6', op: 'eq', value: 'job' },
        { type: 'multi',  name: 'sourcestr8', op: 'eq', values: CONTRACT_TYPES },
      ],
      skipCount: SKIP_COUNT,
      skipFrom,
    },
    lang:         'en',
    responseType: 'SearchResult',
  });
}

function parseJobs(data) {
  // CES response structure: { TotalCount, Result: { Docs: [...] } }
  const docs = data?.Result?.Docs ?? [];
  return docs.map(d => {
    const title    = (d.title || '').trim();
    const rawUrl   = d.url1 || '';
    const url      = rawUrl.startsWith('http') ? rawUrl
                   : rawUrl ? `https://careers.societegenerale.com${rawUrl}` : '';
    // sourcestr7 = "City, Country" (most reliable location field for jobs)
    const location = (d.sourcestr7 || '').trim();
    return { title, url, location };
  }).filter(j => j.title && j.url);
}

function getTotal(data) {
  return data?.TotalCount ?? 0;
}

// ── Main ─────────────────────────────────────────────────────────

async function scrapeSocGen() {
  const filters  = loadFilters();
  const seenUrls = loadSeenUrls();

  const browser = await chromium.launch({ headless: true });
  const page    = await browser.newPage();

  // The proxy requires an OAuth JWT from SG SSO, added by the Drupal JS layer as
  // 'authorization-api: Bearer …' header.  We intercept the first auto-search request
  // to capture this token (and the x-proxy-url for the CES endpoint), then reuse
  // both headers for our own paginated calls with skipCount=100.
  let authHeader  = null;
  let proxyUrlHdr = null;

  page.on('request', req => {
    if (!req.url().includes(PROXY_PATH) || authHeader) return;
    const h = req.headers();
    if (h['authorization-api']) {
      authHeader  = h['authorization-api'];
      proxyUrlHdr = h['x-proxy-url'] || '';
    }
  });

  console.log('Société Générale: loading search page (waiting for OAuth token)...');
  await page.goto(SEARCH_PAGE, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForTimeout(6_000);

  if (!authHeader) {
    console.log('Société Générale: OAuth token not found — skipping');
    await browser.close();
    return;
  }

  // The CES search endpoint is /search-profile — use the captured URL as-is.
  const cesBase = proxyUrlHdr;

  // Helper: call proxy from browser context with the captured auth headers
  async function callProxy(skipFrom) {
    return page.evaluate(async ([proxyPath, auth, xProxyUrl, body]) => {
      try {
        const resp = await fetch(proxyPath, {
          method:  'POST',
          headers: {
            'Content-Type':      'application/json',
            'authorization-api': auth,
            'x-proxy-url':       xProxyUrl,
          },
          body,
        });
        if (!resp.ok) return null;
        return resp.json();
      } catch { return null; }
    }, [PROXY_PATH, authHeader, cesBase, buildSearchBody(skipFrom)]);
  }

  // First page
  const firstData = await callProxy(0);
  if (!firstData) {
    console.log('Société Générale: proxy call returned null — skipping');
    await browser.close();
    return;
  }

  const total   = getTotal(firstData);
  const allJobs = parseJobs(firstData);
  console.log(`Société Générale: ${total} total job(s) (Trainee + Internship, EN)`);

  // Paginate remaining batches
  for (let skipFrom = SKIP_COUNT; skipFrom < total; skipFrom += SKIP_COUNT) {
    try {
      const data = await callProxy(skipFrom);
      if (data) allJobs.push(...parseJobs(data));
    } catch (err) {
      console.error(`Société Générale: pagination failed at skipFrom=${skipFrom} — ${err.message}`);
      break;
    }
    await page.waitForTimeout(400);
  }

  await browser.close();

  console.log(`Société Générale: ${allJobs.length} job(s) collected`);

  const newOffers = allJobs
    .filter(j => titleMatches(j.title, filters))
    .filter(j => locationMatches(j.location, filters))
    .filter(j => !seenUrls.has(j.url));

  console.log(`Société Générale: ${newOffers.length} new relevant match(es)`);
  newOffers.forEach(o => console.log(`  + ${o.title} | ${o.location || 'N/A'}`));

  if (newOffers.length > 0 && !DRY_RUN) {
    appendToHistory(newOffers);
    console.log(`Saved ${newOffers.length} new job(s) to scan-history.tsv`);
  }

  if (DRY_RUN) console.log('(dry run — nothing written)');
}

scrapeSocGen().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
