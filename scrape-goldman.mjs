#!/usr/bin/env node
/**
 * scrape-goldman.mjs
 * Scrapes Goldman Sachs listings from the public Higher GraphQL endpoint.
 *
 * The public careers site at https://higher.gs.com/results hydrates from:
 *   POST https://api-higher.gs.com/gateway/api/v1/graphql
 * with the roleSearch GraphQL query.
 *
 * Usage:
 *   node scrape-goldman.mjs            # real run
 *   node scrape-goldman.mjs --dry-run  # preview without writing
 */

import { readFileSync, appendFileSync, existsSync, writeFileSync } from 'fs';
import { createRequire } from 'module';

const _require = createRequire(import.meta.url);
const yaml     = _require('js-yaml');
_require('dotenv').config();

const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const DRY_RUN = process.argv.includes('--dry-run');

const COMPANY_NAME = 'Goldman Sachs';
const CAREERS_BASE = 'https://higher.gs.com';
const GRAPHQL_URL  = 'https://api-higher.gs.com/gateway/api/v1/graphql';
const PAGE_SIZE    = 20;

const GET_ROLES_QUERY = `
  query GetRoles($searchQueryInput: RoleSearchQueryInput!) {
    roleSearch(searchQueryInput: $searchQueryInput) {
      totalCount
      items {
        roleId
        corporateTitle
        jobTitle
        jobFunction
        locations {
          primary
          state
          country
          city
        }
        status
        division
        skills
        jobType {
          code
          description
        }
        externalSource {
          sourceId
        }
      }
    }
  }
`;

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
    `${o.url}\t${date}\tgoldman\t${o.title}\t${o.company}\tadded\t${o.location || ''}`
  ).join('\n') + '\n';
  appendFileSync(SCAN_HISTORY_PATH, lines, 'utf-8');
}

function formatLocation(locations = []) {
  const primary = locations.find(l => l.primary) || locations[0];
  if (!primary) return '';

  const parts = [];
  for (const value of [primary.city, primary.state, primary.country]) {
    const cleaned = (value || '').trim();
    if (cleaned && !parts.includes(cleaned)) parts.push(cleaned);
  }
  return parts.join(', ');
}

function normalizeRole(item) {
  const sourceId = item.externalSource?.sourceId || item.roleId?.split('_')[0] || '';
  if (!sourceId) return null;

  return {
    title: item.jobTitle || '',
    location: formatLocation(item.locations),
    url: `${CAREERS_BASE}/roles/${sourceId}`,
    company: COMPANY_NAME,
    status: item.status || '',
  };
}

async function fetchRolePage(pageNumber) {
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Origin': CAREERS_BASE,
      'Referer': `${CAREERS_BASE}/results`,
    },
    body: JSON.stringify({
      operationName: 'GetRoles',
      variables: {
        searchQueryInput: {
          page: { pageSize: PAGE_SIZE, pageNumber },
          sort: { sortStrategy: 'RELEVANCE', sortOrder: 'DESC' },
          filters: [],
          experiences: ['EARLY_CAREER', 'PROFESSIONAL'],
          searchTerm: '',
        },
      },
      query: GET_ROLES_QUERY,
    }),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status} on page ${pageNumber}`);

  const json = await res.json();
  const payload = json?.data?.roleSearch;
  if (!payload || !Array.isArray(payload.items)) {
    throw new Error(`Unexpected GraphQL response on page ${pageNumber}`);
  }

  return payload;
}

async function fetchAllRoles() {
  const jobs = [];
  let pageNumber = 0;
  let totalCount = null;

  while (true) {
    const payload = await fetchRolePage(pageNumber);
    if (totalCount === null) totalCount = payload.totalCount || 0;

    const pageJobs = payload.items
      .map(normalizeRole)
      .filter(Boolean)
      .filter(job => job.status === 'POSTED');

    jobs.push(...pageJobs);

    if (payload.items.length === 0 || jobs.length >= totalCount) break;
    pageNumber += 1;
  }

  return jobs;
}

async function main() {
  const filters  = loadFilters();
  const seenUrls = loadSeenUrls();

  const allJobs = await fetchAllRoles();
  console.log(`Goldman Sachs: ${allJobs.length} job(s) total`);

  const newOffers = allJobs
    .filter(j => titleMatches(j.title, filters))
    .filter(j => locationMatches(j.location, filters))
    .filter(j => !seenUrls.has(j.url));

  console.log(`Goldman Sachs: ${newOffers.length} new relevant match(es)`);
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
