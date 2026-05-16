#!/usr/bin/env node
/**
 * scrape-hsbc.mjs
 * Scrapes HSBC early careers listings via the GroupGTI / Solr API.
 *
 * API endpoint (GET):
 *   https://hsbcearlycareers.groupgti.com/Search/CandidateVacancies?q=*:*&rows=100&wt=json
 *
 * Job URL format (SPA hash routing):
 *   https://hsbcearlycareers.groupgti.com/VacancyPosting/Search#!/{slug}
 *
 * Notes:
 * - Plain HTTP GET, no auth. POST requires a session cookie the browser sets on landing page.
 * - Location uses dynamicstring_VacancyDetail_Location_Text (e.g. "UK", "Singapore").
 * - City uses dynamicstring_VacancyDetail_City_Text (e.g. "Leeds", "Hong Kong SAR").
 * - ~12 total roles currently, mostly APAC + UK apprenticeships. London/Frankfurt roles
 *   will be caught automatically when posted.
 *
 * Usage:
 *   node scrape-hsbc.mjs            # real run
 *   node scrape-hsbc.mjs --dry-run  # preview without writing
 */

import { readFileSync, appendFileSync, existsSync, writeFileSync } from 'fs';
import { createRequire } from 'module';

const _require = createRequire(import.meta.url);
const yaml     = _require('js-yaml');
_require('dotenv').config();

const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const DRY_RUN = process.argv.includes('--dry-run');

const API_BASE    = 'https://hsbcearlycareers.groupgti.com/Search/CandidateVacancies';
const JOB_URL_BASE = 'https://hsbcearlycareers.groupgti.com/VacancyPosting/Search#!/';
const PAGE_SIZE   = 100;

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
    `${o.url}\t${date}\thsbc\t${o.title}\tHSBC\tadded\t${o.location || ''}`
  ).join('\n') + '\n';
  appendFileSync(SCAN_HISTORY_PATH, lines, 'utf-8');
}

// ── API ───────────────────────────────────────────────────────────

function buildUrl(offset) {
  const params = new URLSearchParams({
    q:     '*:*',
    rows:  String(PAGE_SIZE),
    start: String(offset),
    wt:    'json',
    fl:    [
      'dynamicstring_Vacancy_Name',
      'dynamicstring_ShortName',
      'dynamicstring_VacancyDetail_Location_Text',
      'dynamicstring_VacancyDetail_City_Text',
    ].join(','),
  });
  return `${API_BASE}?${params}`;
}

const HEADERS = { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' };

function docToJob(doc) {
  const title    = (doc.dynamicstring_Vacancy_Name || '').trim();
  const slug     = (doc.dynamicstring_ShortName || '').trim();
  const locText  = (doc.dynamicstring_VacancyDetail_Location_Text || '').trim();
  const cityText = (doc.dynamicstring_VacancyDetail_City_Text || '').trim();
  const location = locText || cityText;
  const url      = slug ? `${JOB_URL_BASE}${slug}` : '';
  return { title, location, url };
}

async function fetchAllJobs() {
  const res = await fetch(buildUrl(0), { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data  = await res.json();
  const resp  = data.response || {};
  const total = resp.numFound || 0;
  const jobs  = (resp.docs || []).map(docToJob).filter(j => j.title && j.url);

  for (let offset = PAGE_SIZE; offset < total; offset += PAGE_SIZE) {
    await new Promise(r => setTimeout(r, 300));
    const r2 = await fetch(buildUrl(offset), { headers: HEADERS });
    if (!r2.ok) break;
    const d2   = await r2.json();
    const page = (d2.response?.docs || []).map(docToJob).filter(j => j.title && j.url);
    if (page.length === 0) break;
    jobs.push(...page);
  }

  return { total, jobs };
}

// ── Main ─────────────────────────────────────────────────────────

async function main() {
  const filters  = loadFilters();
  const seenUrls = loadSeenUrls();

  const { total, jobs: allJobs } = await fetchAllJobs();
  console.log(`HSBC: ${allJobs.length} job(s) fetched (${total} total)`);

  const newOffers = allJobs
    .filter(j => titleMatches(j.title, filters))
    .filter(j => locationMatches(j.location, filters))
    .filter(j => !seenUrls.has(j.url));

  console.log(`HSBC: ${newOffers.length} new relevant match(es)`);
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
