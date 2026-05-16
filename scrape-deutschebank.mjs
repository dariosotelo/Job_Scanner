#!/usr/bin/env node
/**
 * scrape-deutschebank.mjs
 * Scrapes Deutsche Bank graduate/internship listings via the public Beesite API
 * used by careers.db.com/students-graduates/Search-Programmes/.
 *
 * API endpoint:
 *   GET https://api-deutschebank.beesite.de/graduatesearch/?data={JSON}
 *
 * Notes:
 * - Plain HTTP, no authentication, no Playwright needed.
 * - CountryName is always in German ("Deutschland") regardless of LanguageCode.
 *   Location matching uses CityName (e.g. "Frankfurt am Main") instead.
 * - Ambiguous city values ("Mehrere Standorte", "deutschlandweit") are passed
 *   through as empty so the title filter alone decides relevance.
 * - ~21 total roles currently; all fit on one page.
 * - Job URLs are on db.recsolu.com (Deutsche Bank's Recsolu ATS).
 *
 * Usage:
 *   node scrape-deutschebank.mjs            # real run
 *   node scrape-deutschebank.mjs --dry-run  # preview without writing
 */

import { readFileSync, appendFileSync, existsSync, writeFileSync } from 'fs';
import { createRequire } from 'module';

const _require = createRequire(import.meta.url);
const yaml     = _require('js-yaml');
_require('dotenv').config();

const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const DRY_RUN = process.argv.includes('--dry-run');

const API_BASE = 'https://api-deutschebank.beesite.de/graduatesearch/';
const PAGE_SIZE = 100;

const AMBIGUOUS_CITIES = new Set(['mehrere standorte', 'deutschlandweit', 'multiple locations', '']);

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
    `${o.url}\t${date}\tdeutschebank\t${o.title}\tDeutsche Bank\tadded\t${o.location || ''}`
  ).join('\n') + '\n';
  appendFileSync(SCAN_HISTORY_PATH, lines, 'utf-8');
}

// ── API ───────────────────────────────────────────────────────────

function buildQuery(offset) {
  const data = {
    LanguageCode: 'en',
    SearchParameters: {
      FirstItem: offset + 1,
      CountItem: PAGE_SIZE,
      MatchedObjectDescriptor: [
        'PositionID', 'PositionTitle', 'PositionURI',
        'PositionLocation.CountryName', 'PositionLocation.CityName',
        'PublicationStartDate',
      ],
      Sort: [{ Criterion: 'PublicationStartDate', Direction: 'DESC' }],
    },
    SearchCriteria: [],
  };
  return `${API_BASE}?data=${encodeURIComponent(JSON.stringify(data))}`;
}

async function fetchAllJobs() {
  const res = await fetch(buildQuery(0), {
    headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();

  const result = data.SearchResult || {};
  const total  = result.SearchResultCount || 0;
  const items  = result.SearchResultItems || [];

  const jobs = items.map(it => {
    const desc = it.MatchedObjectDescriptor || {};
    const locs = desc.PositionLocation || [];
    const rawCity = (locs[0]?.CityName || '').trim();
    const city = AMBIGUOUS_CITIES.has(rawCity.toLowerCase()) ? '' : rawCity;
    return {
      title:    (desc.PositionTitle || '').trim(),
      location: city,
      url:      (desc.PositionURI || '').trim(),
    };
  }).filter(j => j.title && j.url);

  // Paginate if needed (unlikely given current ~21 total)
  for (let offset = PAGE_SIZE; offset < total; offset += PAGE_SIZE) {
    await new Promise(r => setTimeout(r, 300));
    const r2 = await fetch(buildQuery(offset), {
      headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
    });
    if (!r2.ok) break;
    const d2 = await r2.json();
    const page = (d2.SearchResult?.SearchResultItems || []).map(it => {
      const desc = it.MatchedObjectDescriptor || {};
      const locs = desc.PositionLocation || [];
      const rawCity = (locs[0]?.CityName || '').trim();
      const city = AMBIGUOUS_CITIES.has(rawCity.toLowerCase()) ? '' : rawCity;
      return { title: (desc.PositionTitle || '').trim(), location: city, url: (desc.PositionURI || '').trim() };
    }).filter(j => j.title && j.url);
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
  console.log(`Deutsche Bank: ${allJobs.length} job(s) fetched (${total} total)`);

  const newOffers = allJobs
    .filter(j => titleMatches(j.title, filters))
    .filter(j => locationMatches(j.location, filters))
    .filter(j => !seenUrls.has(j.url));

  console.log(`Deutsche Bank: ${newOffers.length} new relevant match(es)`);
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
