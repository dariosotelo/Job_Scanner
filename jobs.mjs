#!/usr/bin/env node
/**
 * jobs.mjs — Job Scanner CLI
 *
 * Commands:
 *   node jobs.mjs                    Show new jobs found today
 *   node jobs.mjs --days 7           Show jobs found in the last 7 days
 *   node jobs.mjs --all              Show entire history
 *   node jobs.mjs --scan             All positions ever found, grouped by company
 *   node jobs.mjs --update           New positions not yet reviewed; marks them after display
 *   node jobs.mjs --companies        List all tracked companies and their scan method
 *   node jobs.mjs --filter <keyword> Filter results by keyword (title, company, or location)
 *
 * Examples:
 *   node jobs.mjs --days 3
 *   node jobs.mjs --filter UBS
 *   node jobs.mjs --filter "risk analyst"
 *   node jobs.mjs --all --filter London
 *   node jobs.mjs --scan --filter Zurich
 *   node jobs.mjs --update
 *   node jobs.mjs --companies
 */

import { readFileSync, existsSync, appendFileSync, mkdirSync } from 'fs';
import { createRequire } from 'module';

const _require = createRequire(import.meta.url);
const yaml     = _require('js-yaml');
_require('dotenv').config();

const SCAN_HISTORY_PATH  = 'data/scan-history.tsv';
const ANALYZED_URLS_PATH = 'data/analyzed-urls.txt';
const PORTALS_PATH       = 'portals.yml';

// ── Argument parsing ──────────────────────────────────────────────

const args = process.argv.slice(2);

function getFlag(name) {
  const i = args.indexOf(name);
  return i !== -1;
}

function getFlagValue(name) {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : null;
}

const showCompanies = getFlag('--companies');
const showAll       = getFlag('--all');
const showScan      = getFlag('--scan');
const showUpdate    = getFlag('--update');
const days          = getFlagValue('--days') ? parseInt(getFlagValue('--days')) : null;
const filterKw      = getFlagValue('--filter');

// ── Colours (plain fallback if terminal doesn't support) ──────────

const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  cyan:   '\x1b[36m',
  blue:   '\x1b[34m',
  red:    '\x1b[31m',
  gray:   '\x1b[90m',
};

// ── Companies view ────────────────────────────────────────────────

const METHOD_LABEL = {
  'greenhouse-api': 'Greenhouse API',
  'playwright-ubs': 'Playwright / Taleo',
  'umantis':        'Umantis',
  'workday':        'Workday',
  'postfinance':    'SuccessFactors',
  'prospective':    'prospective.ch',
  'phenom':         'Phenom People',
};

function showCompaniesView() {
  if (!existsSync(PORTALS_PATH)) {
    console.error(`${C.red}portals.yml not found.${C.reset} Run: cp portals.example.yml portals.yml`);
    process.exit(1);
  }

  const config   = yaml.load(readFileSync(PORTALS_PATH, 'utf-8'));
  const companies = config.tracked_companies || [];

  // Group by scan method
  const groups = {};
  for (const c of companies) {
    const method = c.scan_method || (c.api ? 'greenhouse-api' : 'unknown');
    if (!groups[method]) groups[method] = [];
    groups[method].push(c);
  }

  console.log(`\n${C.bold}Tracked Companies (${companies.length} total)${C.reset}\n`);

  for (const [method, list] of Object.entries(groups)) {
    const label = METHOD_LABEL[method] || method;
    console.log(`${C.cyan}${C.bold}${label}${C.reset} ${C.gray}(${list.length})${C.reset}`);
    for (const c of list) {
      const url = c.careers_url ? `  ${C.gray}${c.careers_url}${C.reset}` : '';
      console.log(`  ${C.green}•${C.reset} ${c.name}${url}`);
    }
    console.log();
  }

  // Show active filters
  const loc    = config.location_filter?.allow || [];
  const posKw  = config.title_filter?.positive || [];
  console.log(`${C.bold}Location filter (allow):${C.reset} ${loc.join(', ') || 'all'}`);
  console.log(`${C.bold}Title keywords (${posKw.length}):${C.reset} ${posKw.slice(0, 8).join(', ')}${posKw.length > 8 ? ` ... +${posKw.length - 8} more` : ''}`);
  console.log();
}

// ── Shared helpers ────────────────────────────────────────────────

function loadHistory() {
  if (!existsSync(SCAN_HISTORY_PATH)) return [];

  const lines = readFileSync(SCAN_HISTORY_PATH, 'utf-8').trim().split('\n');
  return lines.slice(1).map(line => {
    const [url, first_seen, portal, title, company, status, location] = line.split('\t');
    return { url, first_seen, portal, title, company, status, location: location?.trim() || '' };
  }).filter(j => j.url && j.title);
}

function applyKeywordFilter(jobs) {
  if (!filterKw) return jobs;
  const kw = filterKw.toLowerCase();
  return jobs.filter(j =>
    j.title.toLowerCase().includes(kw) ||
    j.company.toLowerCase().includes(kw) ||
    j.location.toLowerCase().includes(kw)
  );
}

function printJobsByDate(jobs) {
  const byDate = {};
  for (const j of jobs) {
    if (!byDate[j.first_seen]) byDate[j.first_seen] = [];
    byDate[j.first_seen].push(j);
  }

  for (const date of Object.keys(byDate).sort().reverse()) {
    const dayJobs = byDate[date];
    console.log(`${C.yellow}${date}${C.reset} ${C.gray}(${dayJobs.length} job${dayJobs.length === 1 ? '' : 's'})${C.reset}`);
    for (const j of dayJobs) {
      const loc    = j.location ? ` ${C.gray}· ${j.location}${C.reset}` : '';
      const portal = j.portal   ? ` ${C.dim}[${j.portal}]${C.reset}` : '';
      console.log(`  ${C.green}+${C.reset} ${C.bold}${j.title}${C.reset}`);
      console.log(`    ${C.blue}${j.company}${C.reset}${loc}${portal}`);
      console.log(`    ${C.gray}${j.url}${C.reset}`);
    }
    console.log();
  }
}

function cutoffDate(daysBack) {
  const d = new Date();
  d.setDate(d.getDate() - daysBack);
  return d.toISOString().slice(0, 10);
}

// ── Jobs history view (today / --days / --all) ────────────────────

function showJobsView() {
  const history = loadHistory();

  if (history.length === 0) {
    console.log(`\n${C.yellow}No scan history found.${C.reset} Run ${C.bold}bash daily-scan.sh${C.reset} first.\n`);
    return;
  }

  let jobs = history;
  let label = '';

  if (showAll) {
    label = 'All time';
  } else if (days) {
    const cutoff = cutoffDate(days);
    jobs  = history.filter(j => j.first_seen >= cutoff);
    label = `Last ${days} day${days === 1 ? '' : 's'}`;
  } else {
    const today = new Date().toISOString().slice(0, 10);
    jobs  = history.filter(j => j.first_seen === today);
    label = `Today (${today})`;
  }

  jobs = applyKeywordFilter(jobs);

  const filterNote = filterKw ? ` matching "${filterKw}"` : '';
  console.log(`\n${C.bold}Jobs found — ${label}${filterNote} (${jobs.length})${C.reset}\n`);

  if (jobs.length === 0) {
    console.log(`${C.gray}  No jobs found for this period.${C.reset}\n`);
    return;
  }

  printJobsByDate(jobs);
}

// ── Scan view (--scan): all positions grouped by company ──────────

function showScanView() {
  const history = loadHistory();

  if (history.length === 0) {
    console.log(`\n${C.yellow}No scan history found.${C.reset} Run ${C.bold}bash daily-scan.sh${C.reset} first.\n`);
    return;
  }

  const jobs = applyKeywordFilter(history);

  const filterNote = filterKw ? ` matching "${filterKw}"` : '';
  console.log(`\n${C.bold}All tracked positions${filterNote} (${jobs.length})${C.reset}\n`);

  if (jobs.length === 0) {
    console.log(`${C.gray}  No positions found.${C.reset}\n`);
    return;
  }

  // Group by company, sorted alphabetically
  const byCompany = {};
  for (const j of jobs) {
    if (!byCompany[j.company]) byCompany[j.company] = [];
    byCompany[j.company].push(j);
  }

  for (const company of Object.keys(byCompany).sort()) {
    const compJobs = byCompany[company];
    console.log(`${C.blue}${C.bold}${company}${C.reset} ${C.gray}(${compJobs.length})${C.reset}`);
    for (const j of compJobs) {
      const loc  = j.location   ? ` ${C.gray}· ${j.location}${C.reset}` : '';
      const date = ` ${C.dim}${j.first_seen}${C.reset}`;
      console.log(`  ${C.green}+${C.reset} ${j.title}${loc}${date}`);
      console.log(`    ${C.gray}${j.url}${C.reset}`);
    }
    console.log();
  }
}

// ── Telegram ──────────────────────────────────────────────────────

async function sendTelegram(jobs) {
  const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

  if (!BOT_TOKEN || BOT_TOKEN === 'your_bot_token_here' ||
      !CHAT_ID   || CHAT_ID   === 'your_chat_id_here') {
    console.log(`${C.gray}  (Telegram not configured — skipping notification)${C.reset}`);
    return;
  }

  const date  = new Date().toISOString().slice(0, 10);
  const CHUNK = 10;

  for (let i = 0; i < jobs.length; i += CHUNK) {
    const chunk  = jobs.slice(i, i + CHUNK);
    const header = i === 0
      ? (jobs.length === 1
          ? `🔔 <b>1 new position — ${date}</b>`
          : `🔔 <b>${jobs.length} new positions — ${date}</b>`)
      : `🔔 <b>continued (${i + 1}–${Math.min(i + CHUNK, jobs.length)} of ${jobs.length})</b>`;

    const body = chunk.map(j => {
      const loc = j.location ? ` · ${j.location}` : '';
      return `• <a href="${j.url}">${j.title}</a>\n  <i>${j.company}${loc}</i>`;
    }).join('\n\n');

    const text = `${header}\n\n${body}`;

    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error(`${C.red}Telegram error: ${res.status} — ${err}${C.reset}`);
      return;
    }
  }

  console.log(`${C.green}Sent ${jobs.length} position${jobs.length === 1 ? '' : 's'} to Telegram.${C.reset}\n`);
}

// ── Update view (--update): unreviewed positions, then mark them ──

function loadAnalyzedUrls() {
  if (!existsSync(ANALYZED_URLS_PATH)) return new Set();
  return new Set(
    readFileSync(ANALYZED_URLS_PATH, 'utf-8').trim().split('\n').filter(Boolean)
  );
}

function markAsAnalyzed(jobs) {
  mkdirSync('data', { recursive: true });
  const lines = jobs.map(j => j.url).join('\n') + '\n';
  appendFileSync(ANALYZED_URLS_PATH, lines, 'utf-8');
}

async function showUpdateView() {
  const history  = loadHistory();
  const analyzed = loadAnalyzedUrls();

  if (history.length === 0) {
    console.log(`\n${C.yellow}No scan history found.${C.reset} Run ${C.bold}bash daily-scan.sh${C.reset} first.\n`);
    return;
  }

  const unreviewed = history.filter(j => !analyzed.has(j.url));
  const jobs       = applyKeywordFilter(unreviewed);

  const filterNote = filterKw ? ` matching "${filterKw}"` : '';
  console.log(`\n${C.bold}New positions to review${filterNote} (${jobs.length} of ${unreviewed.length} unreviewed)${C.reset}\n`);

  if (jobs.length === 0) {
    console.log(`${C.gray}  No new positions since last update.${C.reset}\n`);
    return;
  }

  printJobsByDate(jobs);

  // Mark all unreviewed (not just filtered subset) as analyzed after display
  if (!filterKw) {
    markAsAnalyzed(unreviewed);
    console.log(`${C.dim}Marked ${unreviewed.length} position${unreviewed.length === 1 ? '' : 's'} as reviewed.${C.reset}\n`);
    await sendTelegram(unreviewed);
  } else {
    console.log(`${C.dim}Filter active — positions not marked as reviewed. Run without --filter to mark.${C.reset}\n`);
  }
}

// ── Entry point ───────────────────────────────────────────────────

function printHelp() {
  console.log(`
${C.bold}Usage:${C.reset}
  node jobs.mjs                     New jobs found today
  node jobs.mjs --days <n>          Jobs found in the last n days
  node jobs.mjs --all               Full history
  node jobs.mjs --scan              All positions grouped by company
  node jobs.mjs --update            Unreviewed positions (marks them after display)
  node jobs.mjs --companies         List all tracked companies
  node jobs.mjs --filter <keyword>  Filter by title, company, or location

${C.bold}Examples:${C.reset}
  node jobs.mjs --days 7
  node jobs.mjs --filter "risk"
  node jobs.mjs --filter UBS
  node jobs.mjs --all --filter London
  node jobs.mjs --scan --filter Zurich
  node jobs.mjs --update
  node jobs.mjs --companies
`);
}

if (getFlag('--help') || getFlag('-h')) {
  printHelp();
} else if (showCompanies) {
  showCompaniesView();
} else if (showScan) {
  showScanView();
} else if (showUpdate) {
  await showUpdateView();
} else {
  showJobsView();
}
