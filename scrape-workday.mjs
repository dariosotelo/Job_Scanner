#!/usr/bin/env node
/**
 * scrape-workday.mjs
 * Generic scraper for companies using Workday ATS.
 * Hits the public Workday jobs API — no authentication needed.
 *
 * Add any Workday company to the COMPANIES list below.
 * API pattern: https://{tenant}.{instance}.myworkdayjobs.com/wday/cxs/{tenant}/{board}/jobs
 *
 * Usage:
 *   node scrape-workday.mjs            # real run
 *   node scrape-workday.mjs --dry-run  # preview without writing
 */

import { readFileSync, appendFileSync, existsSync, writeFileSync } from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const dotenv  = require('dotenv');
const yaml    = require('js-yaml');
dotenv.config();

const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const DRY_RUN = process.argv.includes('--dry-run');

// ── Companies using Workday ──────────────────────────────────────
// tenant:   subdomain before .wd{N}.myworkdayjobs.com
// instance: wd1 / wd3 / wd5 (check from the careers URL)
// board:    job board name (appears in the careers URL path)
// name:     display name
const COMPANIES = [
  {
    tenant:   'rothschildandco',
    instance: 'wd3',
    board:    'Rothschildandco_Lateral',
    name:     'Rothschild & Co',
  },
  {
    tenant:   'vontobel',
    instance: 'wd3',
    board:    'Vontobel_External_Career',
    name:     'Vontobel',
  },
  {
    tenant:   'juliusbaer',
    instance: 'wd3',
    board:    'JB_Career_Site_Graduates',
    name:     'Julius Baer',
  },
  {
    tenant:   'juliusbaer',
    instance: 'wd3',
    board:    'Internships',
    name:     'Julius Baer',
  },
  {
    tenant:   'lombardodier',
    instance: 'wd3',
    board:    'Lombard_Odier_Careers',
    name:     'Lombard Odier',
  },
  // Add more as discovered, e.g.:
  // { tenant: 'goldmansachs', instance: 'wd1', board: 'campus', name: 'Goldman Sachs' },
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
    `${o.url}\t${date}\tworkday\t${o.title}\t${o.company}\tadded\t${o.location || ''}`
  ).join('\n') + '\n';
  appendFileSync(SCAN_HISTORY_PATH, lines, 'utf-8');
}

// ── Workday API ──────────────────────────────────────────────────

async function fetchAllJobs(company) {
  const base = `https://${company.tenant}.${company.instance}.myworkdayjobs.com`;
  const apiUrl = `${base}/wday/cxs/${company.tenant}/${company.board}/jobs`;

  const jobs = [];
  let offset = 0;
  let total  = null;
  const limit = 20;  // Workday API rejects requests with limit > 20
  // Note: Workday only returns accurate total on page 1; subsequent pages return 0.
  // We capture total once and use it for all pagination decisions.

  while (true) {
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
      body: JSON.stringify({ appliedFacets: {}, limit, offset, searchText: '' }),
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    const postings = data.jobPostings || [];

    if (total === null) total = data.total || 0;

    for (const p of postings) {
      const url = `${base}/${company.board}${p.externalPath}`;
      jobs.push({
        title:    p.title || '',
        location: p.locationsText || '',
        url,
        company:  company.name,
      });
    }

    offset += limit;
    if (offset >= total || postings.length === 0) break;
  }

  return jobs;
}

// ── Scraper ──────────────────────────────────────────────────────

async function scrapeCompany(company, filters, seenUrls) {
  const jobs = await fetchAllJobs(company);

  console.log(`${company.name}: ${jobs.length} oferta(s) total`);

  const newOffers = jobs
    .filter(j => titleMatches(j.title, filters))
    .filter(j => locationMatches(j.location, filters))
    .filter(j => !seenUrls.has(j.url));

  console.log(`${company.name}: ${newOffers.length} nueva(s) relevante(s)`);
  newOffers.forEach(o => console.log(`  + ${o.title} | ${o.location || 'N/A'}`));

  return newOffers;
}

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
  }

  if (allNew.length > 0 && !DRY_RUN) {
    appendToHistory(allNew);
    console.log(`\nGuardado ${allNew.length} oferta(s) en scan-history.tsv`);
  }

  if (DRY_RUN) console.log('\n(dry run — nada escrito)');
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
