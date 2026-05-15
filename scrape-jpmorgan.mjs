#!/usr/bin/env node
/**
 * scrape-jpmorgan.mjs
 * Scrapes JPMorgan Chase job listings via the Oracle HCM Candidate Experience REST API.
 *
 * Oracle HCM CE API endpoint:
 *   GET https://jpmc.fa.oraclecloud.com/hcmRestApi/resources/latest/recruitingCEJobRequisitions
 *
 * Key implementation notes:
 * - The finder string MUST use literal `;` as attribute separator and literal `,` between
 *   attributes — do NOT URLSearchParams-encode the finder value (breaks the parser).
 * - The facetsList sub-values use `%3B` (encoded semicolons) as their separator.
 * - Location filter requires BOTH lastSelectedFacet=LOCATIONS AND selectedLocationsFacet=<id>
 *   in the finder string; omitting lastSelectedFacet returns count=correct but jobs=[].
 * - Pagination uses `offset=N` in the finder string (not a top-level query param).
 * - Job URL: https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/job/{Id}
 *
 * Location IDs (from locationsFacet in API response):
 *   300000000289276 = United Kingdom
 *   300000000289639 = Singapore
 *   300000000289330 = Hong Kong
 *   (Switzerland does not appear in JPMorgan's active location facets)
 *
 * Usage:
 *   node scrape-jpmorgan.mjs            # real run
 *   node scrape-jpmorgan.mjs --dry-run  # preview without writing
 */

import { readFileSync, appendFileSync, existsSync, writeFileSync } from 'fs';
import { createRequire } from 'module';

const _require = createRequire(import.meta.url);
const yaml     = _require('js-yaml');
_require('dotenv').config();

const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const DRY_RUN = process.argv.includes('--dry-run');

const CE_BASE  = 'https://jpmc.fa.oraclecloud.com';
const API_BASE = CE_BASE + '/hcmRestApi/resources/latest/recruitingCEJobRequisitions';
const SITE     = 'CX_1001';
const PAGE_SIZE = 25;

// Location IDs to scan — UK covers London (the relevant office for most roles)
const LOCATION_IDS = [
  '300000000289276',  // United Kingdom
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
    `${o.url}\t${date}\tjpmorgan\t${o.title}\tJPMorgan Chase\tadded\t${o.location || ''}`
  ).join('\n') + '\n';
  appendFileSync(SCAN_HISTORY_PATH, lines, 'utf-8');
}

// ── API ───────────────────────────────────────────────────────────

function buildUrl(locationId, offset) {
  // IMPORTANT: build the URL manually — do NOT encode the finder string.
  // The facetsList uses %3B (pre-encoded semicolons) as internal separators.
  const facets = 'LOCATIONS%3BWORK_LOCATIONS%3BWORKPLACE_TYPES%3BTITLES%3BCATEGORIES%3BORGANIZATIONS%3BPOSTING_DATES%3BFLEX_FIELDS';
  let finder = `findReqs;siteNumber=${SITE},facetsList=${facets},limit=${PAGE_SIZE},sortBy=POSTING_DATES_DESC`;
  finder += `,lastSelectedFacet=LOCATIONS,selectedLocationsFacet=${locationId}`;
  if (offset > 0) finder += `,offset=${offset}`;
  const expand = 'requisitionList.workLocation,requisitionList.otherWorkLocations,requisitionList.secondaryLocations';
  return `${API_BASE}?onlyData=true&expand=${expand}&finder=${finder}`;
}

async function fetchPage(locationId, offset) {
  const res = await fetch(buildUrl(locationId, offset), {
    headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const item = data.items?.[0];
  if (!item) throw new Error('No item in response');
  return {
    total: item.TotalJobsCount || 0,
    jobs:  (item.requisitionList || []).map(j => ({
      title:    (j.Title || '').trim(),
      location: (j.PrimaryLocation || '').trim(),
      url:      `${CE_BASE}/hcmUI/CandidateExperience/en/sites/${SITE}/job/${j.Id}`,
    })).filter(j => j.title),
  };
}

async function fetchAllForLocation(locationId) {
  const first = await fetchPage(locationId, 0);
  const allJobs = [...first.jobs];
  const total = first.total;
  const pages = Math.ceil(total / PAGE_SIZE);
  for (let p = 1; p < Math.min(pages, 100); p++) {
    await new Promise(r => setTimeout(r, 300));
    const page = await fetchPage(locationId, p * PAGE_SIZE);
    if (page.jobs.length === 0) break;
    allJobs.push(...page.jobs);
  }
  return { total, jobs: allJobs };
}

// ── Main ─────────────────────────────────────────────────────────

async function main() {
  const filters  = loadFilters();
  const seenUrls = loadSeenUrls();

  const seen = new Set();  // deduplicate across locations
  const allJobs = [];

  for (const locId of LOCATION_IDS) {
    const { total, jobs } = await fetchAllForLocation(locId);
    console.log(`JPMorgan Chase [loc=${locId}]: ${jobs.length} job(s) fetched (${total} total)`);
    for (const j of jobs) {
      if (!seen.has(j.url)) { seen.add(j.url); allJobs.push(j); }
    }
  }

  console.log(`JPMorgan Chase: ${allJobs.length} unique job(s) total`);

  const newOffers = allJobs
    .filter(j => titleMatches(j.title, filters))
    .filter(j => locationMatches(j.location, filters))
    .filter(j => !seenUrls.has(j.url));

  console.log(`JPMorgan Chase: ${newOffers.length} new relevant match(es)`);
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
