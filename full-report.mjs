#!/usr/bin/env node
/**
 * full-report.mjs
 * Sends a Telegram message with ALL currently matching job openings —
 * not just today's new ones. Reads from data/scan-history.tsv, re-applies
 * the portals.yml title + location filters, and groups results by company.
 *
 * Run this any time you want a complete picture of what's available right now.
 * Does NOT modify scan-history.tsv or notified-urls.txt.
 *
 * Usage:
 *   node full-report.mjs            # send to Telegram
 *   node full-report.mjs --preview  # print to terminal only, no Telegram
 */

import { readFileSync, existsSync } from 'fs';
import { createRequire } from 'module';

const _require = createRequire(import.meta.url);
const yaml     = _require('js-yaml');
_require('dotenv').config();

const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const PREVIEW   = process.argv.includes('--preview');

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

// ── Read history ─────────────────────────────────────────────────

function loadAllMatchingJobs(filters) {
  if (!existsSync(SCAN_HISTORY_PATH)) {
    console.error('No scan-history.tsv found — run bash daily-scan.sh first.');
    process.exit(1);
  }

  const lines = readFileSync(SCAN_HISTORY_PATH, 'utf-8').trim().split('\n').slice(1);
  const seen  = new Set();
  const jobs  = [];

  for (const line of lines) {
    const [url, first_seen, , title, company, , location] = line.split('\t');
    if (!url || !title || !company) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    if (!titleMatches(title, filters)) continue;
    if (!locationMatches(location?.trim() || '', filters)) continue;
    jobs.push({ url, title, company, location: location?.trim() || '', first_seen });
  }

  return jobs;
}

// ── Format & send ────────────────────────────────────────────────

async function sendTelegramMessage(text) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) throw new Error(`Telegram error: ${res.status} — ${await res.text()}`);
}

function formatChunk(jobs, chunkIndex, totalChunks, totalJobs) {
  const header = chunkIndex === 0
    ? `📋 <b>Full job report — ${totalJobs} opening${totalJobs !== 1 ? 's' : ''} matching your filters</b>`
    : `📋 <b>Full job report (continued ${chunkIndex + 1}/${totalChunks})</b>`;

  // Group by company within this chunk
  const byCompany = new Map();
  for (const j of jobs) {
    if (!byCompany.has(j.company)) byCompany.set(j.company, []);
    byCompany.get(j.company).push(j);
  }

  const body = [...byCompany.entries()].map(([company, companyJobs]) => {
    const lines = companyJobs.map(j => {
      const loc = j.location ? ` · ${j.location}` : '';
      return `  • <a href="${j.url}">${j.title}</a>${loc}`;
    }).join('\n');
    return `<b>${company}</b>\n${lines}`;
  }).join('\n\n');

  return `${header}\n\n${body}`;
}

// ── Main ─────────────────────────────────────────────────────────

async function main() {
  const filters = loadFilters();
  const jobs    = loadAllMatchingJobs(filters);

  if (jobs.length === 0) {
    console.log('No matching jobs in scan history. Run bash daily-scan.sh first.');
    return;
  }

  // Sort by company then title
  jobs.sort((a, b) => a.company.localeCompare(b.company) || a.title.localeCompare(b.title));

  console.log(`Found ${jobs.length} matching job(s) across ${new Set(jobs.map(j => j.company)).size} companies.`);

  // Group into chunks — keep chunks under ~3500 chars (Telegram max is 4096)
  const chunks = [];
  let current  = [];
  let currentLen = 0;

  for (const job of jobs) {
    const lineLen = job.title.length + job.company.length + (job.location?.length || 0) + job.url.length + 30;
    if (currentLen + lineLen > 3200 && current.length > 0) {
      chunks.push(current);
      current = [];
      currentLen = 0;
    }
    current.push(job);
    currentLen += lineLen;
  }
  if (current.length > 0) chunks.push(current);

  if (PREVIEW) {
    for (let i = 0; i < chunks.length; i++) {
      console.log('\n' + '─'.repeat(60));
      console.log(formatChunk(chunks[i], i, chunks.length, jobs.length)
        .replace(/<[^>]+>/g, ''));  // strip HTML tags for terminal
    }
    console.log(`\n(${chunks.length} message${chunks.length !== 1 ? 's' : ''} total)`);
    return;
  }

  if (!BOT_TOKEN || !CHAT_ID) {
    console.error('TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set in .env');
    process.exit(1);
  }

  for (let i = 0; i < chunks.length; i++) {
    const text = formatChunk(chunks[i], i, chunks.length, jobs.length);
    await sendTelegramMessage(text);
    console.log(`  Sent message ${i + 1}/${chunks.length}`);
    if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 1000));
  }

  console.log('Done — full report sent.');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
