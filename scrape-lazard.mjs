#!/usr/bin/env node
/**
 * scrape-lazard.mjs
 * Scrapes Lazard professional openings from the TAL/Oleeo careers board.
 *
 * Board:
 *   https://lazard-careers.tal.net/vx/lang-en-GB/mobile-1/appcentre-ext/brand-4/candidate/jobboard/vacancy/3/adv/
 *
 * Implementation notes:
 * - TAL's HTTP responses can trip undici/fetch parsing, so this scraper uses Node's
 *   lower-level https client instead.
 * - The board currently returns "no active opportunities" from some environments. That
 *   case is handled explicitly so dry-runs remain truthful and stable.
 * - When jobs are present, the list page is used only to discover `/opp/...` detail URLs.
 *   Title and location are parsed from each detail page, which is more stable.
 */

import https from 'https';
import { readFileSync, appendFileSync, existsSync, writeFileSync } from 'fs';
import { createRequire } from 'module';

const _require = createRequire(import.meta.url);
const yaml     = _require('js-yaml');
_require('dotenv').config();

const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const DRY_RUN = process.argv.includes('--dry-run');

const COMPANY_NAME = 'Lazard';
const BASE_URL = 'https://lazard-careers.tal.net';
const BOARD_URL = `${BASE_URL}/vx/lang-en-GB/mobile-1/appcentre-ext/brand-4/candidate/jobboard/vacancy/3/adv/`;
const MAX_PAGES = 20;
const DETAIL_CONCURRENCY = 5;

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
    `${o.url}\t${date}\tlazard\t${o.title}\t${o.company}\tadded\t${o.location || ''}`
  ).join('\n') + '\n';
  appendFileSync(SCAN_HISTORY_PATH, lines, 'utf-8');
}

function decodeHtml(text = '') {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept-Language': 'en-GB,en;q=0.9',
      },
    }, res => {
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        res.resume();
        return;
      }
      let data = '';
      res.on('data', chunk => { data += chunk.toString(); });
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function buildBoardPageUrl(start) {
  return start > 0 ? `${BOARD_URL}?start=${start}` : BOARD_URL;
}

function parseDetailUrls(html) {
  const urls = new Set();
  const re = /href="([^"]*\/opp\/\d+[^"]*)"/g;
  let match;
  while ((match = re.exec(html)) !== null) {
    const raw = match[1].replace(/&amp;/g, '&');
    const url = raw.startsWith('http') ? raw : `${BASE_URL}${raw.startsWith('/') ? '' : '/'}${raw}`;
    urls.add(url);
  }
  return [...urls];
}

function parseField(html, label) {
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    `<span class="hform_lbl_text"\\s*>\\s*${esc}\\s*<\\/span>[\\s\\S]*?<div[^>]*class="form-control-static"[^>]*>[\\s\\S]*?([\\s\\S]*?)<\\/div>`,
    'i'
  );
  const match = html.match(re);
  if (!match) return '';
  return decodeHtml(match[1].replace(/<[^>]+>/g, ' '));
}

function parseJobDetail(html, url) {
  const titleMatch = html.match(/<h1 class="section">\s*([^<]+?)\s*<\/h1>/i);
  const title = titleMatch ? decodeHtml(titleMatch[1]) : '';
  const location = parseField(html, 'Location');
  if (!title) return null;
  return { url, title, location, company: COMPANY_NAME };
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const current = index++;
      results[current] = await fn(items[current], current);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

async function fetchAllDetailUrls() {
  const detailUrls = new Set();

  for (let page = 0; page < MAX_PAGES; page++) {
    const start = page === 0 ? 0 : detailUrls.size;
    const html = await httpGet(buildBoardPageUrl(start));
    const urls = parseDetailUrls(html);

    if (urls.length === 0) {
      if (/no active opportunities/i.test(html)) return [];
      break;
    }

    let added = 0;
    for (const url of urls) {
      if (!detailUrls.has(url)) {
        detailUrls.add(url);
        added++;
      }
    }

    if (added === 0) break;
    if (urls.length < 5) break;
  }

  return [...detailUrls];
}

async function fetchAllJobs() {
  const detailUrls = await fetchAllDetailUrls();
  if (detailUrls.length === 0) return [];

  const jobs = await mapWithConcurrency(detailUrls, DETAIL_CONCURRENCY, async url => {
    const html = await httpGet(url);
    return parseJobDetail(html, url);
  });

  return jobs.filter(Boolean);
}

async function main() {
  const filters  = loadFilters();
  const seenUrls = loadSeenUrls();

  const allJobs = await fetchAllJobs();
  console.log(`Lazard: ${allJobs.length} job(s) total`);

  const newOffers = allJobs
    .filter(j => titleMatches(j.title, filters))
    .filter(j => locationMatches(j.location, filters))
    .filter(j => !seenUrls.has(j.url));

  console.log(`Lazard: ${newOffers.length} new relevant match(es)`);
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
