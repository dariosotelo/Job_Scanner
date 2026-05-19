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

// ── Job classification ────────────────────────────────────────────

const GRADUATE_KEYWORDS = [
  'graduate programme', 'graduate program',
  'graduate analyst', 'graduate associate', 'graduate trainee',
  'graduate talent', 'graduate rotational', 'new graduate', 'new grad',
  'analyst programme', 'analyst program', 'analyst trainee',
  'rotational programme', 'rotational program',
  'campus hire', 'campus recruit',
  'vte',
];

const INTERNSHIP_KEYWORDS = [
  'internship', ' intern ', 'intern,',
  'summer analyst', 'winter analyst', 'spring analyst',
  'off-cycle', 'off cycle',
  'stage ', 'stagiaire', 'praktikant', 'praktikum',
  'working student', 'werkstudent',
  'trainee', 'traineeship',
  'apprentice', 'apprenticeship',
];

function classifyJob(title) {
  const t = ' ' + title.toLowerCase() + ' ';
  if (GRADUATE_KEYWORDS.some(kw => t.includes(kw))) return 'graduate';
  // standalone "graduate" as a word
  if (/\bgraduate\b/.test(t)) return 'graduate';
  if (INTERNSHIP_KEYWORDS.some(kw => t.includes(kw))) return 'internship';
  return 'other';
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
  const graduateJobs   = allJobs.filter(j => classifyJob(j.title) === 'graduate');
  const internshipJobs = allJobs.filter(j => classifyJob(j.title) === 'internship');
  const otherJobs      = allJobs.filter(j => classifyJob(j.title) === 'other');

  const sections = [];

  if (graduateJobs.length > 0) {
    sections.push({
      header: `🎓 <b>${graduateJobs.length} graduate position${graduateJobs.length > 1 ? 's' : ''} — ${date}</b>`,
      jobs: graduateJobs,
    });
  }
  if (internshipJobs.length > 0) {
    sections.push({
      header: `📋 <b>${internshipJobs.length} internship${internshipJobs.length > 1 ? 's' : ''} — ${date}</b>`,
      jobs: internshipJobs,
    });
  }
  if (otherJobs.length > 0) {
    sections.push({
      header: `🔔 <b>${otherJobs.length} other match${otherJobs.length > 1 ? 'es' : ''} — ${date}</b>`,
      jobs: otherJobs,
    });
  }

  // If nothing was classified (shouldn't happen), fall back to one block
  if (sections.length === 0) {
    sections.push({
      header: `🔔 <b>${allJobs.length} new job${allJobs.length > 1 ? 's' : ''} — ${date}</b>`,
      jobs: allJobs,
    });
  }

  const MAX = 3800;
  const messages = [];

  for (const { header, jobs } of sections) {
    const blocks = [...groupByCompany(jobs).entries()].map(([c, js]) => renderCompanyBlock(c, js));
    let current = `${header}\n\n`;
    let first = true;
    for (const block of blocks) {
      const sep = first ? '' : '\n\n';
      if (!first && current.length + sep.length + block.length > MAX) {
        messages.push(current.trimEnd());
        current = `${header} (continued)\n\n${block}`;
        first = false;
        continue;
      }
      current += sep + block;
      first = false;
    }
    messages.push(current.trimEnd());
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

  const gradCount = jobs.filter(j => classifyJob(j.title) === 'graduate').length;
  const internCount = jobs.filter(j => classifyJob(j.title) === 'internship').length;
  console.log(`${jobs.length} new job(s) found (${gradCount} graduate, ${internCount} internship) — building messages...`);

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
