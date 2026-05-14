#!/usr/bin/env node
/**
 * scrape-umantis.mjs
 * Generic scraper for companies using the Umantis ATS (common in Switzerland).
 * Pure HTTP fetch — no Playwright needed, server-renders HTML.
 *
 * Add any Umantis company to the COMPANIES list below.
 * URL pattern: https://{slug}.umantis.com/Jobs/All
 *
 * Usage:
 *   node scrape-umantis.mjs            # real run
 *   node scrape-umantis.mjs --dry-run  # preview without writing
 */

import { readFileSync, appendFileSync, existsSync, writeFileSync } from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const dotenv  = require('dotenv');
const yaml    = require('js-yaml');
dotenv.config();

const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const DRY_RUN = process.argv.includes('--dry-run');

// ── Companies using Umantis ──────────────────────────────────────
// Add new companies here — just slug + display name
const COMPANIES = [
  { slug: 'jsafrasarasin',    name: 'J. Safra Sarasin' },
  { slug: 'recruitingapp-2735', name: 'AXA Switzerland' },  // AXA CH portal
  // Add more as discovered, e.g.:
  // { slug: 'zkb',   name: 'ZKB' },
  // { slug: 'pictet', name: 'Pictet' },
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
    `${o.url}\t${date}\tumantis\t${o.title}\t${o.company}\tadded\t${o.location || ''}`
  ).join('\n') + '\n';
  appendFileSync(SCAN_HISTORY_PATH, lines, 'utf-8');
}

// ── Parser ───────────────────────────────────────────────────────

function parseUmantisHTML(html, baseUrl, companyName) {
  const jobs = [];

  // Match each vacancy block: grab href (with vacancy id), title, and location
  const blockRegex = /href="(\/Vacancies\/\d+\/Description\/\d+)"[^>]*aria-label="([^"]+)"/g;
  const locationRegex = /tableaslist_element_\d+">(?:&nbsp;\|&nbsp;)?([^<|]+,\s*CH[^<]*)</g;

  // Build a map of vacancy-id → location by scanning the full HTML
  const locationMap = {};
  let locMatch;
  const allLocations = [];
  const locScan = /tableaslist_element_\d+">&nbsp;\|&nbsp;([A-Z][^<,]+,\s*CH[^<]*)</g;
  while ((locMatch = locScan.exec(html)) !== null) {
    allLocations.push(locMatch[1].trim());
  }

  let i = 0;
  let match;
  while ((match = blockRegex.exec(html)) !== null) {
    const path  = match[1];
    const title = match[2];
    const url   = `${baseUrl}${path}`;
    const location = allLocations[i] || '';
    i++;
    jobs.push({ title, url, location, company: companyName });
  }

  return jobs;
}

// ── Scraper ──────────────────────────────────────────────────────

async function scrapeCompany(company, filters, seenUrls) {
  const baseUrl = `https://${company.slug}.umantis.com`;
  const listUrl = `${baseUrl}/Jobs/All`;

  const res = await fetch(listUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const html = await res.text();
  const jobs  = parseUmantisHTML(html, baseUrl, company.name);

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
