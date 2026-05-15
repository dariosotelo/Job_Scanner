#!/usr/bin/env node
/**
 * scrape-schroders.mjs
 * Scrapes Schroders job listings via the Oracle HCM Candidate Experience REST API.
 *
 * Oracle HCM CE endpoint:
 *   GET https://ekbq.fa.em2.oraclecloud.com/hcmRestApi/resources/latest/recruitingCEJobRequisitions
 *
 * Schroders has ~37 global jobs on this board — small enough to fetch all pages
 * without any server-side location filter and apply portals.yml rules client-side.
 * Switzerland (Zurich, Geneva) and UK (London) offices are both present.
 *
 * Implementation notes (same as scrape-jpmorgan.mjs):
 * - The finder string MUST be a raw string — do NOT URLSearchParams-encode it.
 * - Pagination uses offset=N inside the finder string.
 * - Job URL: https://ekbq.fa.em2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_2/job/{Id}
 *
 * Usage:
 *   node scrape-schroders.mjs            # real run
 *   node scrape-schroders.mjs --dry-run  # preview without writing
 */

import { readFileSync, appendFileSync, existsSync, writeFileSync } from 'fs';
import { createRequire } from 'module';

const _require = createRequire(import.meta.url);
const yaml     = _require('js-yaml');
_require('dotenv').config();

const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const DRY_RUN = process.argv.includes('--dry-run');

const CE_BASE   = 'https://ekbq.fa.em2.oraclecloud.com';
const API_BASE  = CE_BASE + '/hcmRestApi/resources/latest/recruitingCEJobRequisitions';
const SITE      = 'CX_2';
const PAGE_SIZE = 25;

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
    `${o.url}\t${date}\tschroders\t${o.title}\tSchroders\tadded\t${o.location || ''}`
  ).join('\n') + '\n';
  appendFileSync(SCAN_HISTORY_PATH, lines, 'utf-8');
}

// ── API ───────────────────────────────────────────────────────────

function buildUrl(offset) {
  const facets = 'LOCATIONS%3BTITLES%3BCATEGORIES%3BORGANIZATIONS%3BPOSTING_DATES';
  let finder = `findReqs;siteNumber=${SITE},facetsList=${facets},limit=${PAGE_SIZE},sortBy=POSTING_DATES_DESC`;
  if (offset > 0) finder += `,offset=${offset}`;
  const expand = 'requisitionList.workLocation,requisitionList.secondaryLocations';
  return `${API_BASE}?onlyData=true&expand=${expand}&finder=${finder}`;
}

async function fetchAllJobs() {
  const res = await fetch(buildUrl(0), {
    headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const item = data.items?.[0];
  if (!item) throw new Error('No item in response');

  const total = item.TotalJobsCount || 0;
  const allJobs = (item.requisitionList || []).map(j => ({
    title:    (j.Title || '').trim(),
    location: (j.PrimaryLocation || '').trim(),
    url:      `${CE_BASE}/hcmUI/CandidateExperience/en/sites/${SITE}/job/${j.Id}`,
  })).filter(j => j.title);

  const pages = Math.ceil(total / PAGE_SIZE);
  for (let p = 1; p < Math.min(pages, 50); p++) {
    await new Promise(r => setTimeout(r, 300));
    const r2 = await fetch(buildUrl(p * PAGE_SIZE), {
      headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
    });
    if (!r2.ok) break;
    const d2 = await r2.json();
    const page = (d2.items?.[0]?.requisitionList || []).map(j => ({
      title:    (j.Title || '').trim(),
      location: (j.PrimaryLocation || '').trim(),
      url:      `${CE_BASE}/hcmUI/CandidateExperience/en/sites/${SITE}/job/${j.Id}`,
    })).filter(j => j.title);
    if (page.length === 0) break;
    allJobs.push(...page);
  }

  return { total, jobs: allJobs };
}

// ── Main ─────────────────────────────────────────────────────────

async function main() {
  const filters  = loadFilters();
  const seenUrls = loadSeenUrls();

  const { total, jobs: allJobs } = await fetchAllJobs();
  console.log(`Schroders: ${allJobs.length} job(s) fetched (${total} total)`);

  const newOffers = allJobs
    .filter(j => titleMatches(j.title, filters))
    .filter(j => locationMatches(j.location, filters))
    .filter(j => !seenUrls.has(j.url));

  console.log(`Schroders: ${newOffers.length} new relevant match(es)`);
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
