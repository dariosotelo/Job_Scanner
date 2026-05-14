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
      disable_web_page_preview: false,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Telegram API error: ${res.status} — ${err}`);
  }

  return res.json();
}

function formatMessage(jobs) {
  const date = today();
  const count = jobs.length;
  const header = count === 1
    ? `🔔 <b>New job posting — ${date}</b>`
    : `🔔 <b>${count} new job postings — ${date}</b>`;

  const body = jobs.map(j => {
    const loc = j.location ? ` · ${j.location}` : '';
    return `• <a href="${j.url}">${j.title}</a>\n  <i>${j.company}${loc}</i>`;
  }).join('\n\n');

  const footer = `\n\nRun <code>/career-ops pipeline</code> to evaluate.`;

  return `${header}\n\n${body}${footer}`;
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
    console.log(`Toy'que to' tranquilo — no salió na' nuevo hoy (${today()}). Sin mensaje.`);
    return;
  }

  console.log(`Salieron ${jobs.length} vaina(s) nueva(s) — mandando mensaje a Telegram...`);

  const CHUNK_SIZE = 10;
  const allUrls = jobs.map(j => j.url);

  for (let i = 0; i < jobs.length; i += CHUNK_SIZE) {
    const chunk = jobs.slice(i, i + CHUNK_SIZE);
    await sendTelegramMessage(formatMessage(chunk));
    console.log(`  Enviado batch ${Math.floor(i / CHUNK_SIZE) + 1} (${chunk.length} oferta(s))`);
  }

  saveNotifiedUrls(allUrls);
  console.log('¡Listo bróder!');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
