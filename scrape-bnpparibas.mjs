#!/usr/bin/env node
/**
 * scrape-bnpparibas.mjs
 * Scrapes BNP Paribas job listings from two WordPress REST API portals:
 *
 *   UK early-career:   https://careers.bnpparibas.co.uk/wp-json/wp/v2/gbjf_job_post
 *   Switzerland:       https://www.bnpparibas.ch/wp-json/wp/v2/jobs
 *
 * Notes:
 * - The main group.bnpparibas portal is blocked by Akamai — not scrapeable.
 * - France (bnpparibas.fr) is also Akamai-blocked; no accessible French portal found.
 * - UK board: `city` field gives clean location; all postings are early-career.
 * - Switzerland board: no city field — location defaults to "Switzerland, CH".
 *   Most job titles use German (Praktikant/in = intern/trainee).
 * - Both boards are ~11–16 jobs and fit on a single page.
 *
 * Usage:
 *   node scrape-bnpparibas.mjs            # real run
 *   node scrape-bnpparibas.mjs --dry-run  # preview without writing
 */

import { readFileSync, appendFileSync, existsSync, writeFileSync } from 'fs';
import { createRequire } from 'module';

const _require = createRequire(import.meta.url);
const yaml     = _require('js-yaml');
_require('dotenv').config();

const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const DRY_RUN = process.argv.includes('--dry-run');

const PORTALS = [
  {
    name:       'BNP Paribas UK',
    url:        'https://careers.bnpparibas.co.uk/wp-json/wp/v2/gbjf_job_post?per_page=100',
    getLocation: j => (j.city || '').trim(),
  },
  {
    name:       'BNP Paribas Switzerland',
    url:        'https://www.bnpparibas.ch/wp-json/wp/v2/jobs?per_page=100',
    getLocation: () => 'Switzerland, CH',
  },
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
    `${o.url}\t${date}\tbnpparibas\t${o.title}\tBNP Paribas\tadded\t${o.location || ''}`
  ).join('\n') + '\n';
  appendFileSync(SCAN_HISTORY_PATH, lines, 'utf-8');
}

function decodeHtml(str) {
  return str
    .replace(/&#8211;/g, '–')
    .replace(/&#8212;/g, '—')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── API ───────────────────────────────────────────────────────────

async function fetchPortal(portal) {
  const res = await fetch(portal.url, {
    headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();

  return data.map(j => ({
    title:    decodeHtml(j.title?.rendered || ''),
    location: portal.getLocation(j),
    url:      j.link || '',
    portal:   portal.name,
  })).filter(j => j.title && j.url);
}

// ── Main ─────────────────────────────────────────────────────────

async function main() {
  const filters  = loadFilters();
  const seenUrls = loadSeenUrls();

  const allJobs = [];
  for (const portal of PORTALS) {
    try {
      const jobs = await fetchPortal(portal);
      console.log(`${portal.name}: ${jobs.length} job(s) fetched`);
      allJobs.push(...jobs);
    } catch (err) {
      console.error(`  ✗ ${portal.name}: ${err.message}`);
    }
  }

  const newOffers = allJobs
    .filter(j => titleMatches(j.title, filters))
    .filter(j => locationMatches(j.location, filters))
    .filter(j => !seenUrls.has(j.url));

  console.log(`BNP Paribas: ${newOffers.length} new relevant match(es)`);
  newOffers.forEach(o => console.log(`  + ${o.title} | ${o.location || 'N/A'} (${o.portal})`));

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
