#!/usr/bin/env node
/**
 * notify-telegram.mjs
 * Reads new job entries from data/scan-history.tsv and sends a Telegram
 * message for any jobs added today that haven't been notified yet.
 *
 * Can be called two ways:
 *   node notify-telegram.mjs              # reads from scan-history.tsv
 *   node notify-telegram.mjs --jobs '[…]' # receives JSON array directly from scan.mjs wrapper
 *
 * Requires in .env:
 *   TELEGRAM_BOT_TOKEN=your_bot_token
 *   TELEGRAM_CHAT_ID=your_chat_id
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const dotenv = require('dotenv');
dotenv.config();

const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const NOTIFIED_PATH     = 'data/notified-urls.txt';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

// ── Entry-level detection ─────────────────────────────────────────

const ENTRY_LEVEL_KEYWORDS = [
  'internship', 'intern,', ' intern ', 'intern$',
  'summer analyst', 'winter analyst', 'spring analyst',
  'off-cycle', 'off cycle',
  'graduate programme', 'graduate program',
  'graduate analyst', 'graduate associate', 'graduate trainee',
  'graduate talent', 'graduate rotational', 'new graduate',
  'analyst programme', 'analyst program', 'analyst trainee',
  'junior analyst', 'junior quant', 'junior researcher', 'junior associate',
  'entry level', 'entry-level',
  'new grad',
  'trainee', 'traineeship',
  'apprentice', 'apprenticeship',
  'working student', 'werkstudent',
  'campus hire', 'campus recruit',
  'rotational programme', 'rotational program',
];

function isEntryLevel(title) {
  const t = title.toLowerCase();
  return ENTRY_LEVEL_KEYWORDS.some(kw => t.includes(kw.replace('$', '')));
}

// ── Helpers ──────────────────────────────────────────────────────

function today() {
  return new Date().toISOString().slice(0, 10);
}

function loadNotifiedUrls() {
  if (!existsSync(NOTIFIED_PATH)) return new Set();
  return new Set(readFileSync(NOTIFIED_PATH, 'utf-8').trim().split('\n').filter(Boolean));
}

function saveNotifiedUrls(urls) {
  const existing = loadNotifiedUrls();
  for (const u of urls) existing.add(u);
  writeFileSync(NOTIFIED_PATH, [...existing].join('\n') + '\n', 'utf-8');
}

function readTodaysNewJobs() {
  if (!existsSync(SCAN_HISTORY_PATH)) return [];

  const notified = loadNotifiedUrls();
  const date = today();
  const jobs = [];

  const lines = readFileSync(SCAN_HISTORY_PATH, 'utf-8').trim().split('\n');
  for (const line of lines.slice(1)) {
    const [url, first_seen, , title, company, , location] = line.split('\t');
    if (first_seen === date && url && title && company && !notified.has(url)) {
      jobs.push({ url, title, company, location: location?.trim() || '' });
    }
  }

  return jobs;
}

async function sendTelegramMessage(text) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Telegram API error: ${res.status} — ${err}`);
  }

  return res.json();
}

// ── Formatting ────────────────────────────────────────────────────

function groupByCompany(jobs) {
  const map = new Map();
  for (const j of jobs) {
    if (!map.has(j.company)) map.set(j.company, []);
    map.get(j.company).push(j);
  }
  return map;
}

function renderJobLine(j) {
  const loc = j.location ? ` · ${j.location}` : '';
  return `  • <a href="${j.url}">${j.title}</a>${loc}`;
}

function renderCompanyBlock(company, jobs) {
  return `<b>${company}</b>\n${jobs.map(renderJobLine).join('\n')}`;
}

function buildMessages(allJobs, date) {
  const entryJobs = allJobs.filter(j => isEntryLevel(j.title));

  // Section 1 header
  const sec1Header = allJobs.length === 1
    ? `🔔 <b>New job posting — ${date}</b>`
    : `🔔 <b>${allJobs.length} new job postings — ${date}</b>`;

  // Section 2 header (only if there are entry-level matches)
  const sec2Header = entryJobs.length > 0
    ? `🎓 <b>Graduate &amp; internship positions (${entryJobs.length})</b>`
    : null;

  // Build company blocks for each section
  const byCompany1 = groupByCompany(allJobs);
  const blocks1 = [...byCompany1.entries()].map(([c, js]) => renderCompanyBlock(c, js));

  const byCompany2 = groupByCompany(entryJobs);
  const blocks2 = sec2Header
    ? [...byCompany2.entries()].map(([c, js]) => renderCompanyBlock(c, js))
    : [];

  // Chunk everything so no single message exceeds ~3800 chars (buffer for headers)
  const MAX = 3800;
  const messages = [];

  function flush(headerLine, bodyBlocks, isFirstChunk) {
    let current = isFirstChunk ? `${headerLine}\n\n` : `${headerLine} (continued)\n\n`;
    let first = true;
    for (const block of bodyBlocks) {
      const sep = first ? '' : '\n\n';
      if (!first && current.length + sep.length + block.length > MAX) {
        messages.push(current.trimEnd());
        current = `${headerLine} (continued)\n\n${block}`;
        first = false;
        continue;
      }
      current += sep + block;
      first = false;
    }
    if (current.trim().length > headerLine.length + 15) {
      messages.push(current.trimEnd());
    }
  }

  flush(sec1Header, blocks1, true);

  if (sec2Header && blocks2.length > 0) {
    flush(sec2Header, blocks2, true);
  }

  return messages;
}

// ── Main ─────────────────────────────────────────────────────────

async function main() {
  if (!BOT_TOKEN || BOT_TOKEN === 'your_bot_token_here') {
    console.error('Error: TELEGRAM_BOT_TOKEN not set in .env');
    process.exit(1);
  }
  if (!CHAT_ID || CHAT_ID === 'your_chat_id_here') {
    console.error('Error: TELEGRAM_CHAT_ID not set in .env');
    process.exit(1);
  }

  const jobs = readTodaysNewJobs();

  if (jobs.length === 0) {
    console.log(`No new jobs today (${today()}). No message sent.`);
    return;
  }

  const entryCount = jobs.filter(j => isEntryLevel(j.title)).length;
  console.log(`${jobs.length} new job(s) found (${entryCount} entry-level) — building messages...`);

  const messages = buildMessages(jobs, today());

  for (let i = 0; i < messages.length; i++) {
    await sendTelegramMessage(messages[i]);
    console.log(`  Sent message ${i + 1}/${messages.length}`);
    if (i < messages.length - 1) await new Promise(r => setTimeout(r, 1000));
  }

  saveNotifiedUrls(jobs.map(j => j.url));
  console.log('Done.');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
