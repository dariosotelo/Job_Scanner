#!/usr/bin/env node
/**
 * scrape-ubs.mjs
 * Scrapes all UBS graduate/intern job listings by intercepting the
 * MatchedJobs JSON API that the UBS careers SPA calls on search.
 *
 * Usage:
 *   node scrape-ubs.mjs            # real run
 *   node scrape-ubs.mjs --dry-run  # preview without writing
 */

import { readFileSync, appendFileSync, existsSync, writeFileSync } from 'fs';
import { chromium } from 'playwright';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const dotenv  = require('dotenv');
const yaml    = require('js-yaml');
dotenv.config();

const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const DRY_RUN = process.argv.includes('--dry-run');

const UBS_URL = 'https://jobs.ubs.com/TGNewUI/Search/Home/Home?partnerid=25008&siteid=5176#home';

function getJobUrl(reqid) {
  return `https://jobs.ubs.com/TGnewUI/Search/home/HomeWithPreLoad?partnerid=25008&siteid=5176&PageType=JobDetails&jobid=${reqid}`;
}

// ── Filters (mirrors scan.mjs logic) ────────────────────────────

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
    `${o.url}\t${date}\tplaywright-ubs\t${o.title}\tUBS\tadded\t${o.location || ''}`
  ).join('\n') + '\n';
  appendFileSync(SCAN_HISTORY_PATH, lines, 'utf-8');
}

function parseJobs(apiResponse) {
  const rawJobs = apiResponse?.Jobs?.Job || [];
  return rawJobs.map(job => {
    const fields = {};
    (job.Questions || []).forEach(q => { fields[q.QuestionName] = q.Value; });
    return {
      title:    fields.jobtitle || '',
      location: (fields.formtext23 || '').trim(),
      reqid:    fields.reqid,
      url:      getJobUrl(fields.reqid),
    };
  }).filter(j => j.title && j.reqid);
}

// ── Main ─────────────────────────────────────────────────────────

async function scrapeUBS() {
  const filters  = loadFilters();
  const seenUrls = loadSeenUrls();

  const browser = await chromium.launch({ headless: true });
  const page    = await browser.newPage();

  let allJobs = [];

  page.on('response', async resp => {
    if (resp.url().includes('MatchedJobs')) {
      try {
        const data = await resp.json();
        allJobs = parseJobs(data);
      } catch {}
    }
  });

  console.log('Conectando a UBS careers...');
  await page.goto(UBS_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(2000);

  // Click Search with no keyword to get all listings
  await page.click('button.primaryButton, button[type="submit"]').catch(() => {});
  await page.waitForTimeout(5000);

  await browser.close();

  console.log(`UBS: ${allJobs.length} job(s) total`);

  const newOffers = allJobs
    .filter(j => titleMatches(j.title, filters))
    .filter(j => locationMatches(j.location, filters))
    .filter(j => !seenUrls.has(j.url));

  console.log(`UBS: ${newOffers.length} new relevant match(es) after filters`);

  if (newOffers.length > 0) {
    if (!DRY_RUN) {
      appendToHistory(newOffers);
      console.log('Saved to scan-history.tsv');
    }
    newOffers.forEach(o => console.log(`  + ${o.title} | ${o.location || 'N/A'}`));
  }

  if (DRY_RUN) console.log('(dry run — nothing written)');
  return newOffers;
}

scrapeUBS().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
