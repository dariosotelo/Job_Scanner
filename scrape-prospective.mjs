#!/usr/bin/env node
/**
 * scrape-prospective.mjs
 * Generic scraper for companies using the prospective.ch career platform.
 * Server-rendered HTML — uses Node's built-in http2 module (server requires HTTP/2).
 *
 * Add any prospective.ch company to the COMPANIES list below.
 * Pagination offset auto-detected from sendPagination() calls in the HTML.
 *
 * Usage:
 *   node scrape-prospective.mjs            # real run
 *   node scrape-prospective.mjs --dry-run  # preview without writing
 */

import http2 from 'http2';
import { readFileSync, appendFileSync, existsSync, writeFileSync } from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const dotenv  = require('dotenv');
const yaml    = require('js-yaml');
dotenv.config();

const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const DRY_RUN = process.argv.includes('--dry-run');

// ── Companies using prospective.ch ───────────────────────────────
// url:  POST target — include required query params (lang, r, etc.)
// name: display name
const COMPANIES = [
  { url: 'https://jobs.helvetia.com/ch/?lang=en&r=1', name: 'Helvetia' },
  { url: 'https://jobs.generali.ch/?lang=en',         name: 'Generali Switzerland' },
  // Add more prospective.ch companies, e.g.:
  // { url: 'https://jobs.example.com/ch/?lang=en', name: 'Example' },
];

// ── HTTP/2 POST helper ────────────────────────────────────────────
// prospective.ch returns 503 on HTTP/1.1 POST — must use HTTP/2

function postH2(urlStr, body) {
  return new Promise((resolve, reject) => {
    const url    = new URL(urlStr);
    const client = http2.connect(url.origin);
    client.on('error', reject);

    const req = client.request({
      ':method':       'POST',
      ':path':         url.pathname + url.search,
      ':authority':    url.host,
      'content-type':  'application/x-www-form-urlencoded',
      'content-length': Buffer.byteLength(body).toString(),
      'user-agent':    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'accept':        'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.5',
      'referer':       urlStr,
    });

    let status = 200;
    const chunks = [];
    req.on('response', h => { status = h[':status'] || 200; });
    req.on('data',  chunk => { chunks.push(Buffer.from(chunk)); });
    req.on('end',   () => {
      client.close();
      if (status !== 200) return reject(new Error(`HTTP ${status}`));
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', err => { client.close(); reject(err); });

    req.write(body);
    req.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

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
    `${o.url}\t${date}\tprospective\t${o.title}\t${o.company}\tadded\t${o.location || ''}`
  ).join('\n') + '\n';
  appendFileSync(SCAN_HISTORY_PATH, lines, 'utf-8');
}

// ── Parser ────────────────────────────────────────────────────────

function parseJobs(html, companyName) {
  const jobs  = [];

  // Format 1: Helvetia/Generali — <a href=".../job-vacancies/..." title="Title">
  const blockRegex = /<a\s+[^>]*href="(https:\/\/[^"]*\/job-vacancies\/[^"]+)"[^>]*title="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let match;
  while ((match = blockRegex.exec(html)) !== null) {
    const url   = match[1];
    const title = match[2];
    const inner = match[3];
    const pMatches = [...inner.matchAll(/<p>([\s\S]*?)<\/p>/g)];
    let location = '';
    if (pMatches.length >= 2) {
      location = pMatches[1][1].replace(/<[^>]+>/g, '').trim()
        .split('\n').map(l => l.trim()).filter(Boolean).join(', ');
    }
    jobs.push({ title, url, location, company: companyName });
  }

  // Format 2: Swiss Life AM — <a class="job" href="URL">...<h2>Title</h2>...<span><img>Location</span>
  const swissRegex = /<a\s+class="job"\s+href="(https:\/\/[^"]+)"[^>]*>[\s\S]*?<h2>([^<]+)<\/h2>[\s\S]*?<span>[^<]*<img[^>]+>([^<]+)<\/span>/g;
  while ((match = swissRegex.exec(html)) !== null) {
    jobs.push({
      title:    match[2].trim(),
      url:      match[1],
      location: match[3].trim(),
      company:  companyName,
    });
  }

  // Deduplicate by URL (some pages render the job list twice)
  const seen = new Set();
  return jobs.filter(j => {
    if (seen.has(j.url)) return false;
    seen.add(j.url);
    return true;
  });
}

// ── Scraper ───────────────────────────────────────────────────────

async function scrapeCompany(company, filters, seenUrls) {
  const allJobs = [];
  let offset    = 0;
  let hasMore   = true;

  while (hasMore) {
    const html = await postH2(company.url, `query=&offset=${offset}`);
    allJobs.push(...parseJobs(html, company.name));

    // Auto-detect next offset from pagination links (page size varies per company)
    const nextOffsets = [...html.matchAll(/sendPagination\((\d+)\)/g)]
      .map(m => parseInt(m[1]))
      .filter(n => n > offset)
      .sort((a, b) => a - b);

    hasMore = nextOffsets.length > 0;
    if (hasMore) {
      offset = nextOffsets[0];
      await sleep(1200); // avoid rate limiting between pages
    }
  }

  console.log(`${company.name}: ${allJobs.length} job(s) total`);

  const newOffers = allJobs
    .filter(j => titleMatches(j.title, filters))
    .filter(j => locationMatches(j.location, filters))
    .filter(j => !seenUrls.has(j.url));

  console.log(`${company.name}: ${newOffers.length} new relevant match(es)`);
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
    await sleep(2000); // pause between companies
  }

  if (allNew.length > 0 && !DRY_RUN) {
    appendToHistory(allNew);
    console.log(`\nSaved ${allNew.length} new job(s) to scan-history.tsv`);
  }

  if (DRY_RUN) console.log('\n(dry run — nothing written)');
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
