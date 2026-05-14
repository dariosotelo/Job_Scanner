#!/usr/bin/env node
/**
 * scrape-lgt.mjs
 * Scrapes LGT Private Bank job listings from their CoreMedia CMS.
 *
 * The public careers page (lgt.com/global-en/career/jobs) uses JavaScript
 * to call a server-side fragment endpoint that returns plain HTML:
 *   GET /global-en/career/jobs/34662!jobSearch?pageNum=N
 *   with Referer: https://www.lgt.com/global-en/career/jobs
 *
 * No browser required — plain fetch + regex.
 *
 * Usage:
 *   node scrape-lgt.mjs            # real run
 *   node scrape-lgt.mjs --dry-run  # preview without writing
 */

import { readFileSync, appendFileSync, existsSync, writeFileSync } from 'fs';
import { createRequire } from 'module';

const _require = createRequire(import.meta.url);
const yaml     = _require('js-yaml');
_require('dotenv').config();

const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const DRY_RUN = process.argv.includes('--dry-run');

const BASE_URL      = 'https://www.lgt.com';
const JOBS_PAGE_URL = `${BASE_URL}/global-en/career/jobs/34662!jobSearch`;

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
    `${o.url}\t${date}\tlgt\t${o.title}\tLGT\tadded\t${o.location || ''}`
  ).join('\n') + '\n';
  appendFileSync(SCAN_HISTORY_PATH, lines, 'utf-8');
}

// ── Fetch & parse ─────────────────────────────────────────────────

function parseJobsFromHtml(html) {
  const jobs = [];

  // Each job: <a class="lgt-link lgt-teaser__title-link" href="URL"><h3>Title</h3></a>
  //           ... <li class="lgt-teaser__location-item">City</li>
  const re = /<a class="lgt-link lgt-teaser__title-link" href="(\/global-en\/career\/jobs\/[^"]+)">([\s\S]*?)<\/a>[\s\S]*?<li class="lgt-teaser__location-item">([\s\S]*?)<\/li>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const href     = m[1];
    const inner    = m[2];
    const location = m[3].trim();
    const title    = (inner.match(/<h3[^>]*>([^<]+)<\/h3>/) || [])[1] || inner.replace(/<[^>]+>/g, '').trim();
    if (!title || !href) continue;
    jobs.push({
      url:      BASE_URL + href,
      title:    title.replace(/&amp;/g, '&').replace(/&#\d+;/g, '').trim(),
      location,
    });
  }

  return jobs;
}

async function fetchPage(pageNum) {
  const res = await fetch(`${JOBS_PAGE_URL}?pageNum=${pageNum}`, {
    headers: {
      'Referer':    `${BASE_URL}/global-en/career/jobs`,
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} on page ${pageNum}`);
  return res.text();
}

async function fetchAllJobs() {
  const jobs = [];
  for (let pageNum = 1; pageNum <= 20; pageNum++) {
    const html     = await fetchPage(pageNum);
    const pageJobs = parseJobsFromHtml(html);
    if (pageJobs.length === 0) break;
    jobs.push(...pageJobs);
  }
  return jobs;
}

// ── Main ─────────────────────────────────────────────────────────

async function main() {
  const filters  = loadFilters();
  const seenUrls = loadSeenUrls();

  const allJobs = await fetchAllJobs();
  console.log(`LGT: ${allJobs.length} job(s) total`);

  const newOffers = allJobs
    .filter(j => titleMatches(j.title, filters))
    .filter(j => locationMatches(j.location, filters))
    .filter(j => !seenUrls.has(j.url));

  console.log(`LGT: ${newOffers.length} new relevant match(es)`);
  newOffers.forEach(o => console.log(`  + ${o.title} | ${o.location || 'N/A'}`));

  if (newOffers.length > 0 && !DRY_RUN) {
    appendToHistory(newOffers);
    console.log(`\nSaved ${newOffers.length} new job(s) to scan-history.tsv`);
  }

  if (DRY_RUN) console.log('\n(dry run — nothing written)');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
