#!/usr/bin/env node
/**
 * scrape-successfactors.mjs
 * Playwright scraper for JS-rendered careers pages.
 * Currently supports two layouts:
 *
 *   SF Classic (career012): SAP SuccessFactors, table-based
 *     Required fields: { code, host, name }
 *     code = ?company= value from URL, host = career{N}.successfactors.eu
 *
 *   LGT (CoreMedia CMS): URL-paginated article list
 *     Required fields: { layout: 'lgt', paginationBase, name }
 *     paginationBase = URL without ?pageNum=N suffix
 *
 * Usage:
 *   node scrape-successfactors.mjs            # real run
 *   node scrape-successfactors.mjs --dry-run  # preview without writing
 */

import { readFileSync, appendFileSync, existsSync, writeFileSync } from 'fs';
import { chromium } from 'playwright';
import { createRequire } from 'module';

const _require = createRequire(import.meta.url);
const yaml     = _require('js-yaml');
_require('dotenv').config();

const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const DRY_RUN = process.argv.includes('--dry-run');

const COMPANIES = [
  // ── SAP SuccessFactors (SF Classic, career012 layout) ────────────
  // code: the ?company= value from their careers URL
  // host: the successfactors subdomain (career012, career5, etc.)
  {
    code: 'banquepict',
    host: 'career012.successfactors.eu',
    name: 'Pictet',
  },
  // Add more SF companies here, e.g.:
  // { code: 'COMPANYCODE', host: 'career5.successfactors.eu', name: 'Company Name' },
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
    `${o.url}\t${date}\tsuccessfactors\t${o.title}\t${o.company}\tadded\t${o.location || ''}`
  ).join('\n') + '\n';
  appendFileSync(SCAN_HISTORY_PATH, lines, 'utf-8');
}

// ── DOM extraction ────────────────────────────────────────────────

async function extractJobsFromPage(page, company) {
  return await page.evaluate(({ host, code }) => {
    const jobs = [];

    // ── Strategy 1: SF Classic (career012) ───────────────────────
    // <tr class="jobResultItem">
    //   <td><a class="jobTitle" href="...career_job_req_id=123...">Title</a></td>
    //   <td><span class="facetTxt">Location:City, Country</span></td>
    document.querySelectorAll('tr.jobResultItem').forEach(row => {
      const a = row.querySelector('a.jobTitle');
      if (!a) return;
      const title = a.textContent.trim();
      const href  = a.getAttribute('href') || '';
      const m     = href.match(/career_job_req_id=(\d+)/);
      if (!m) return;
      const jobId    = m[1];
      const facet    = row.querySelector('span.facetTxt');
      const location = facet ? facet.textContent.replace(/^Location:\s*/i, '').trim() : '';
      const url = `https://${host}/career?company=${code}&career_ns=job_application&career_job_req_id=${jobId}`;
      jobs.push({ title, location, url });
    });

    if (jobs.length > 0) return jobs;

    // ── Strategy 2: SF Modern (career5, list layout) ─────────────
    // <a class="jobTitle" data-job-id="123">Title</a>
    document.querySelectorAll('[data-job-id]').forEach(el => {
      const jobId     = el.getAttribute('data-job-id') || el.getAttribute('data-jobid');
      const title     = el.textContent.trim();
      const container = el.closest('li, [class*="job-item"], [class*="jobItem"]');
      const locEl     = container?.querySelector('[class*="location"], [class*="Location"]');
      const location  = locEl ? locEl.textContent.trim() : '';
      const url = `https://${host}/career?company=${code}&career_ns=job_application&career_job_req_id=${jobId}`;
      if (title && jobId) jobs.push({ title, location, url });
    });

    return jobs;
  }, { host: company.host, code: company.code });
}

// ── Pagination ────────────────────────────────────────────────────

async function clickNextPage(page) {
  const nextSelectors = [
    'a[title="Next Page"]',
    'a[aria-label="Next Page"]',
    'a[title="Next"]',
    'a[title="next"]',
    'a:has-text("Next")',
    'button:has-text("Next")',
    '[class*="pagination"] a:last-child',
    'a[rel="next"]',
  ];

  for (const sel of nextSelectors) {
    try {
      const btn = await page.$(sel);
      if (btn) {
        const disabled = await btn.getAttribute('disabled') || await btn.getAttribute('aria-disabled');
        if (disabled === 'true' || disabled === 'disabled') return false;
        await btn.click();
        await page.waitForTimeout(2000);
        return true;
      }
    } catch {}
  }
  return false;
}

// ── Scraper ──────────────────────────────────────────────────────

async function scrapeCompany(company, filters, seenUrls, browser) {
  const page    = await browser.newPage();
  const allJobs = [];

  const searchUrl = `https://${company.host}/career?company=${company.code}&career_ns=job_listing_summary&navBarLevel=JOB_SEARCH`;
  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForSelector(
    'table.careersTable, td.colTitle, [data-job-id], .jobListItem, tr.jobResultItem',
    { timeout: 15_000 }
  ).catch(() => {});
  await page.waitForTimeout(1500);

  let pageNum = 1;
  while (true) {
    const pageJobs = await extractJobsFromPage(page, company);
    allJobs.push(...pageJobs);
    if (pageJobs.length === 0) break;
    const hasNext = await clickNextPage(page);
    if (!hasNext) break;
    if (++pageNum > 20) break;
  }

  await page.close();

  console.log(`${company.name}: ${allJobs.length} job(s) total (${pageNum} page${pageNum > 1 ? 's' : ''})`);

  const newOffers = allJobs
    .filter(j => titleMatches(j.title, filters))
    .filter(j => locationMatches(j.location, filters))
    .filter(j => !seenUrls.has(j.url))
    .map(j => ({ ...j, company: company.name }));

  console.log(`${company.name}: ${newOffers.length} new relevant match(es)`);
  newOffers.forEach(o => console.log(`  + ${o.title} | ${o.location || 'N/A'}`));

  return newOffers;
}

// ── Main ─────────────────────────────────────────────────────────

async function main() {
  const filters  = loadFilters();
  const seenUrls = loadSeenUrls();
  const allNew   = [];

  const browser = await chromium.launch({ headless: true });

  for (const company of COMPANIES) {
    try {
      const offers = await scrapeCompany(company, filters, seenUrls, browser);
      allNew.push(...offers);
    } catch (err) {
      console.error(`  ✗ ${company.name}: ${err.message}`);
    }
  }

  await browser.close();

  if (allNew.length > 0 && !DRY_RUN) {
    appendToHistory(allNew);
    console.log(`\nSaved ${allNew.length} new job(s) to scan-history.tsv`);
  }

  if (DRY_RUN) console.log('\n(dry run — nothing written)');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
