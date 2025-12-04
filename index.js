// index.js

import { Telegraf, Markup } from 'telegraf';
import 'dotenv/config';
import fs from 'fs/promises';
import fsSync from 'fs';
import { PrismaClient } from '@prisma/client';

// ---- Prevent accidental double-run ----

const LOCK_FILE = './bot.lock';

// If a stale lock exists from a crash, check if pid is alive
if (fsSync.existsSync(LOCK_FILE)) {
  const pid = Number(fsSync.readFileSync(LOCK_FILE, 'utf8').trim());
  try {
    process.kill(pid, 0); // will throw if not running
  } catch {
    // Process is not running → stale lock
    fsSync.unlinkSync(LOCK_FILE);
  }
}


function acquireLock() {
  try {
    fsSync.writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx' });
    process.on('exit', () => {
      try { fsSync.unlinkSync(LOCK_FILE); } catch {}
    });
  } catch {
    console.error('Another bot instance is already running. Exiting.');
    process.exit(1);
  }
}



acquireLock();

const prisma = new PrismaClient();

// ---- Telegraf Bot Instance ----
const bot = new Telegraf(process.env.BOT_TOKEN);

// ---- In-memory stores ----
const wagers = new Map();
const allTimeScoresByChat = new Map();
const monthlyScoresByChat = new Map();

// ---- Persistent Storage Setup ----
const DATA_FILE = './data.json';
const STATE_VERSION = 1;

// Debounced save (prevents I/O spam)
let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      await saveState();
    } catch (e) {
      console.error('saveState failed:', e.message || e);
    }
  }, 1500); // 1.5s debounce window
}

function migrateState(state) {
  if (!state || typeof state !== 'object') {
    return { version: STATE_VERSION, wagers: [], allTime: [], monthly: [] };
  }

  const v = state.version || 0;

  // v0 -> v1 (today: just normalize shape, future: real migrations here)
  if (v < 1) {
    state.wagers = state.wagers || [];
    state.allTime = state.allTime || [];
    state.monthly = state.monthly || [];
  }

  state.version = STATE_VERSION;
  return state;
}

async function saveState() {
  const state = {
    version: STATE_VERSION,
    wagers: [...wagers.entries()].map(([id, w]) => ({
      id,
      data: {
        ...w,
        yes: [...w.yes],
        no: [...w.no],
        participantNames: [...w.participantNames.entries()],
        countdownIntervalId: null, // never persist timer handles
      },
    })),
    allTime: [...allTimeScoresByChat.entries()].map(([chatId, map]) => ({
      chatId,
      scores: [...map.entries()],
    })),
    monthly: [...monthlyScoresByChat.entries()].map(([chatId, months]) => ({
      chatId,
      months: [...months.entries()].map(([monthKey, map]) => ({
        monthKey,
        scores: [...map.entries()],
      })),
    })),
  };

  // Atomic write to avoid corruption on crash
  const tmp = `${DATA_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2));
  await fs.rename(tmp, DATA_FILE);
}

async function loadState() {
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf8');
    let state = JSON.parse(raw);
    state = migrateState(state);

    // Restore wagers
    for (const w of state.wagers || []) {
      const d = w.data;
      wagers.set(w.id, {
        ...d,
        yes: new Set(d.yes),
        no: new Set(d.no),
        participantNames: new Map(d.participantNames),
        countdownIntervalId: null,
        resolutionTime: new Date(d.resolutionTime),
        voteDeadline: new Date(d.voteDeadline),
        createdAt: new Date(d.createdAt),
      });
    }

    // Restore leaderboards
    for (const a of state.allTime || []) {
      allTimeScoresByChat.set(a.chatId, new Map(a.scores));
    }

    for (const m of state.monthly || []) {
      const monthsMap = new Map();
      for (const month of m.months || []) {
        monthsMap.set(month.monthKey, new Map(month.scores));
      }
      monthlyScoresByChat.set(m.chatId, monthsMap);
    }

    console.log('State loaded.');
  } catch {
    console.log('No previous state found. Starting fresh.');
  }
}

/* ----------------- Helpers ----------------- */

function getMonthKey(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`; // e.g., "2025-11"
}

function getAllTimeScores(chatId) {
  if (!allTimeScoresByChat.has(chatId)) {
    allTimeScoresByChat.set(chatId, new Map());
  }
  return allTimeScoresByChat.get(chatId);
}

function getMonthlyScores(chatId, monthKey) {
  if (!monthlyScoresByChat.has(chatId)) {
    monthlyScoresByChat.set(chatId, new Map());
  }
  const monthsMap = monthlyScoresByChat.get(chatId);
  if (!monthsMap.has(monthKey)) {
    monthsMap.set(monthKey, new Map());
  }
  return monthsMap.get(monthKey);
}

function addPointsToScores(scoresMap, userId, name, delta) {
  const current = scoresMap.get(userId) || { name, points: 0 };
  current.name = name; // keep latest name/username
  current.points += delta;
  scoresMap.set(userId, current);
}

function getDisplayName(from) {
  if (from.username) return '@' + from.username;
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ');
  return name || `User ${from.id}`;
}

async function updateLeaderboardRow({
  chatId,
  userId,
  name,
  scope,    // 'all' or 'month'
  monthKey, // 'YYYY-MM' for month; ignored for 'all'
  winDelta = 0,
  lossDelta = 0,
}) {
  // If nothing changed, skip the DB hit
  if (winDelta === 0 && lossDelta === 0) return;

  const compositeKey = { 
    chatId: String(chatId),
    userId: String(userId),
    scope,
    monthKey: scope === 'all' ? 'ALL' : monthKey,
  };

  try {
    const existing = await prisma.leaderboardScore.findUnique({
      where: {
        chat_user_scope_month_unique: compositeKey,
      },
    });

    let wins = existing?.wins ?? 0;
    let losses = existing?.losses ?? 0;

    wins += winDelta;
    losses += lossDelta;

    const total = wins + losses;
    const winRate = total > 0 ? wins / total : 0;
    const powerScore = total > 0 ? winRate * 100 * Math.sqrt(total) : 0;

    if (existing) {
      await prisma.leaderboardScore.update({
        where: {
          chat_user_scope_month_unique: compositeKey,
        },
        data: {
          name,
          wins,
          losses,
          total,
          powerScore,
        },
      });
    } else {
      await prisma.leaderboardScore.create({
        data: {
          ...compositeKey,
          name,
          wins,
          losses,
          total,
          powerScore,
        },
      });
    }
  } catch (err) {
    console.error('Failed to update leaderboard row:', err.message || err);
  }
}


// Replace with YOUR Telegram user ID:
const ADMIN_USER_ID = 396039580;

// Format Date in UTC as "YYYY-MM-DD HH:MM UTC"
function formatUtc(date) {
  const iso = date.toISOString();
  const [ymd, hms] = iso.split('T');
  const [hh, mm] = hms.split(':');
  return `${ymd} ${hh}:${mm} UTC`;
}

// Parse absolute UTC OR relative ("in 2 hours", "in 30m", etc.)
function parseResolution(raw, now = new Date()) {
  const trimmed = raw.trim();

  // ----- 1) Absolute UTC: YYYY-MM-DD HH:MM -----
  const abs = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/);
  if (abs) {
    const [, year, month, day, hour, minute] = abs;
    return new Date(Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute)
    ));
  }

  // ----- 2) Relative pattern: "in 2 hours", "in 90m", "in 3 days" -----
  const rel = trimmed.match(/^in\s+(\d+)\s*(hours?|hrs?|h|minutes?|mins?|m|days?|d)$/i);
  if (rel) {
    const amount = Number(rel[1]);
    const unit = rel[2].toLowerCase();

    const result = new Date(now);

    if (unit.startsWith('h')) {
      result.setUTCHours(result.getUTCHours() + amount);
    } else if (unit.startsWith('m')) {
      result.setUTCMinutes(result.getUTCMinutes() + amount);
    } else if (unit.startsWith('d')) {
      result.setUTCDate(result.getUTCDate() + amount);
    }

    return result;
  }

  // No match
  return null;
}


// Parse "SYMBOL OPERATOR VALUE" into structured condition
function parseCondition(raw) {
  const trimmed = raw.trim();
  // e.g. "BTC > 100000" or "DIVI <= 0.01"
  const match = trimmed.match(/^([A-Za-z0-9]+)\s*(>=|<=|>|<)\s*([0-9]+(?:\.[0-9]+)?)$/);
  if (!match) return null;

  const [, symbolRaw, operator, thresholdStr] = match;
  const threshold = Number(thresholdStr);
  if (!Number.isFinite(threshold)) return null;

  const assetSymbol = symbolRaw.toUpperCase();

  // Mapping for CoinGecko
  const symbolToId = {
    BTC: 'bitcoin',
    ETH: 'ethereum',
    DIVI: 'divi',
  };

  const assetId = symbolToId[assetSymbol] || null;

  return { assetSymbol, assetId, operator, threshold };
}

// Evaluate price against the condition, return true if YES should win
function evaluateCondition(price, operator, threshold) {
  switch (operator) {
    case '>':
      return price > threshold;
    case '<':
      return price < threshold;
    case '>=':
      return price >= threshold;
    case '<=':
      return price <= threshold;
    default:
      return false;
  }
}

// Build the display text for an open wager (with countdown / closed note)
function buildWagerText(wager, now = new Date()) {
  const remainingMs = wager.voteDeadline.getTime() - now.getTime();
  let statusLine;

  if (remainingMs <= 0) {
    statusLine = 'Voting is CLOSED.';
  } else {
    const remainingSeconds = Math.ceil(remainingMs / 1000);
    statusLine = `Voting closes in ${remainingSeconds} second(s).`;
  }

  const conditionLine = `Condition: ${wager.assetSymbol} ${wager.operator} ${wager.threshold} USD`;

  return (
    `Wager #${wager.id}\n` +
    `${conditionLine}\n\n` +
    `Resolves at: ${formatUtc(wager.resolutionTime)}\n` +
    `Voting closes at: ${formatUtc(wager.voteDeadline)}\n\n` +
    `YES: ${wager.yes.size} user(s)\n` +
    `NO: ${wager.no.size} user(s)\n\n` +
    statusLine
  );
}

// Build text for a resolved wager
function buildResolvedText(wager) {
  const conditionLine = `Condition: ${wager.assetSymbol} ${wager.operator} ${wager.threshold} USD`;
  const winnerSide = wager.outcomeYes ? 'YES' : 'NO';

  const winnersText =
    wager.winners && wager.winners.length
      ? wager.winners.join('\n')
      : 'No winners 😬';

  const losersText =
    wager.losers && wager.losers.length
      ? wager.losers.join('\n')
      : 'No losers 😌';

  return (
    `Wager #${wager.id} (RESOLVED)\n` +
    `${conditionLine}\n\n` +
    `Resolves at: ${formatUtc(wager.resolutionTime)}\n` +
    `Final price: ${wager.finalPrice} USD\n` +
    `Winning side: ${winnerSide}\n\n` +
    `YES: ${wager.yes.size} user(s)\n` +
    `NO: ${wager.no.size} user(s)\n\n` +
    `Winners (${wager.winners?.length || 0}):\n${winnersText}\n\n` +
    `Losers (${wager.losers?.length || 0}):\n${losersText}\n\n` +
    `Voting is CLOSED.`
  );
}

// Fetch current USD price from CoinGecko for a given coin ID (e.g. 'bitcoin')
async function getCurrentPriceUsd(coinId) {
  if (!coinId) throw new Error('No coinId configured for this symbol');

  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(
    coinId
  )}&vs_currencies=usd`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Price API error: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  if (!data[coinId] || typeof data[coinId].usd !== 'number') {
    throw new Error('Unexpected price data shape from CoinGecko');
  }

  return data[coinId].usd;
}

/* ----------------- Bot handlers ----------------- */

bot.start((ctx) => {
  ctx.reply(
    'Hey! I help groups create friendly prediction wagers (no real money).\n\n' +
      'Create a wager like:\n' +
      '/wager BTC > 100000 | 2025-12-31 00:00\n' +
      '- Times are in UTC\n' +
      '- Resolution must be at least 1 hour from now\n' +
      '- Voting window is 60 seconds after creation'
  );
});

bot.command('leaderboard', (ctx) => {
  const chatId = ctx.chat.id;
  const text = ctx.message.text || '';
  const arg = text.replace(/^\/leaderboard(@\w+)?\s*/, '').trim().toLowerCase();

  const allTimeScores = getAllTimeScores(chatId);
  const thisMonthKey = getMonthKey(new Date());
  const thisMonthScores = getMonthlyScores(chatId, thisMonthKey);

  function renderTop(scoresMap) {
    const sorted = [...scoresMap.entries()]
      .map(([uid, data]) => ({ uid, ...data }))
      .sort((a, b) => b.points - a.points)
      .slice(0, 10);

    if (sorted.length === 0) return 'No scores yet. Resolve a wager first.';

    return sorted
      .map((u, i) => `${i + 1}. ${u.name} — ${u.points} pts`)
      .join('\n');
  }

  if (arg === 'all') {
    return ctx.reply(`🏆 All-time leaderboard:\n\n${renderTop(allTimeScores)}`);
  }

  if (arg === 'month' || arg === 'thismonth') {
    return ctx.reply(`📅 This month (${thisMonthKey}) leaderboard:\n\n${renderTop(thisMonthScores)}`);
  }

  // Default: show both
  ctx.reply(
    `🏆 All-time leaderboard:\n\n${renderTop(allTimeScores)}\n\n` +
    `📅 This month (${thisMonthKey}) leaderboard:\n\n${renderTop(thisMonthScores)}`
  );
});

// WagerHelp Instructions
bot.command('wagerhelp', (ctx) => {
  ctx.reply(
    'DIVI Wager Bot allows you to create friendly prediction wagers in Telegram groups.\n\n' +
    'How to create a wager:\n\n' +
      'Basic format:\n' +
      '/wager SYMBOL OPERATOR VALUE | TIME\n\n' +
      'Examples:\n' +
      '/wager DIVI > 0.002 | 2025-12-31 00:00\n' +
      '/wager BTC >= 90000 | in 2 hours\n' +
      '/wager ETH < 3000 | in 90 minutes\n\n' +
      'Operators allowed:\n' +
      '>   <   >=   <=\n\n' +
      'Time formats supported:\n' +
      '• Absolute UTC:  YYYY-MM-DD HH:MM\n' +
      '   Example:  2025-12-31 00:00\n' +
      '• Relative:  in <number><unit>\n' +
      '   Examples:\n' +
      '   in 2 hours\n' +
      '   in 45 minutes\n' +
      '   in 90m\n' +
      '   in 2 days\n\n' +
      'Relative units supported:\n' +
      '• minutes: m, min, mins, minute, minutes\n' +
      '• hours: h, hr, hrs, hour, hours\n' +
      '• days: d, day, days\n\n' +
      'Rules:\n' +
      '• Resolution must be at least 1 hour from now\n' +
      '• Prices for wager resolution come from CoinGecko\n' +
      '• Voting stays open for 60 seconds after creation\n' +
      '• Winners and losers are displayed automatically at resolution\n\n' +
      'Tip: Type /Leaderboard to see the top winners 🐐.\n' +
      '🏆 Winners receive +10 pts per win.'
  );
});

// Admin-only manual resolver trigger
bot.command('debugresolve', async (ctx) => {
  if (ctx.from.id !== ADMIN_USER_ID) {
    return ctx.reply('This command is for the admin only.');
  }

  ctx.reply('Running resolver now…');
  await resolveDueWagers();
  ctx.reply('Resolver run complete.');
});

// /wager SYMBOL OPERATOR VALUE | YYYY-MM-DD HH:MM (UTC)
bot.command('wager', async (ctx) => {
  const text = ctx.message.text || '';
  const withoutCommand = text.replace(/^\/wager(@\w+)?\s*/, '').trim();

  // Developer override: allow "--debug" to bypass 1 hour rule
  const isDebug = withoutCommand.includes('--debug') && ctx.from.id === ADMIN_USER_ID;

  // Remove --debug from the input so parsing stays clean
  const cleanedInput = withoutCommand.replace('--debug', '').trim();


  if (!cleanedInput) {
    return ctx.reply(
      'How to create a wager:\n\n' +
        'Basic format:\n' +
        '/wager SYMBOL OPERATOR VALUE | TIME\n\n' +
        'Examples:\n' +
        '/wager DIVI > 0.002 | 2025-12-31 00:00\n' +
        '/wager BTC >= 90000 | in 2 hours\n' +
        '/wager ETH < 3000 | in 90 minutes\n\n' +
        'Rules:\n' +
        '• Resolution must be at least 1 hour from now\n' +
        '• Prices for wager resolution come from CoinGecko\n' +
        '• Voting stays open for 60 seconds after creation\n\n' +
        'Tip: You can also type /wagerhelp for the full instructions.'
    );
  }

  // Split into condition and resolution time
  const [rawCondition, rawResolution] = cleanedInput.split('|').map((s) => s.trim());

  if (!rawCondition || !rawResolution) {
    return ctx.reply(
      'Please use the format:\n' +
        '/wager SYMBOL OPERATOR VALUE | YYYY-MM-DD HH:MM\n\n' +
        'Example:\n' +
        '/wager BTC > 100000 | 2025-12-31 00:00'
    );
  }

  const condition = parseCondition(rawCondition);
  if (!condition) {
    return ctx.reply(
      'Could not parse the condition.\n' +
        'Use: SYMBOL OPERATOR VALUE\n' +
        'Examples:\n' +
        'BTC > 100000\n' +
        'DIVI > 0.01\n' +
        'ETH <= 2000\n\n' +
        'Operators allowed: >, <, >=, <='
    );
  }

    // ---- resolution time parsing (absolute or relative) ----
  const now = new Date(); // move this ABOVE parsing

  const resolutionTime = parseResolution(rawResolution, now); // pass now in
  if (!resolutionTime || isNaN(resolutionTime.getTime())) {
    return ctx.reply(
      'Could not parse the resolution time.\n' +
        'Use either:\n' +
        '- Absolute UTC: YYYY-MM-DD HH:MM\n' +
        '- Relative: in <number><unit>\n\n' +
        'Examples:\n' +
        '2025-12-31 00:00\n' +
        'in 2 hours\n' +
        'in 7 days\n' +
        'in 90m'
    );
  }

  const diffMs = resolutionTime.getTime() - now.getTime();

  // Enforce minimum 1 hour from now (except in debug mode)
  const oneHourMs = 60 * 60 * 1000;
  if (!isDebug && diffMs < oneHourMs) {
    const mins = Math.floor(diffMs / 60000);
    return ctx.reply(
      'Resolution time must be at least 1 hour from now.\n' +
        `You provided a time that is only about ${mins} minute(s) away.`
    );
  }
  // ---- end resolution parsing ----


  // Voting window: 60 seconds from creation
  const voteDeadline = new Date(now.getTime() + 60 * 1000);

  // Simple unique ID for the wager
  const id = Date.now().toString();

  // Create wager in memory (with structured condition)
  const wager = {
    id,
    text: rawCondition,
    assetSymbol: condition.assetSymbol,
    assetId: condition.assetId,
    operator: condition.operator,
    threshold: condition.threshold,
    yes: new Set(),
    no: new Set(),
    participantNames: new Map(), // userId -> display name / @username
    chatId: ctx.chat.id,
    messageId: null,
    createdAt: now,
    resolutionTime,
    voteDeadline,
    countdownIntervalId: null,
    resolved: false,
    finalPrice: null,
    outcomeYes: null, // true => YES wins, false => NO wins
  };

  wagers.set(id, wager);
  scheduleSave(); // JSON backup (for now)

  // ---- Persist wager to Postgres (best-effort) ----
  try {
    await prisma.wager.create({
      data: {
        id,
        chatId: String(ctx.chat.id),
        messageId: null,
        text: rawCondition,
        assetSymbol: condition.assetSymbol,
        assetId: condition.assetId,
        operator: condition.operator,
        threshold: condition.threshold,
        createdAt: now,
        voteDeadline,
        resolutionTime,
        resolved: false,
        finalPrice: null,
        outcomeYes: null,
      },
    });
  } catch (err) {
    console.error('Failed to persist wager to Postgres:', err.message || err);
  }


  // Send initial Telegram message
  const initialText = buildWagerText(wager, now);

  const message = await ctx.reply(
    initialText,
    Markup.inlineKeyboard([
      [
        Markup.button.callback('👍 YES', `join:yes:${id}`),
        Markup.button.callback('👎 NO', `join:no:${id}`),
      ],
    ])
  );

  // Store messageId in memory + JSON + DB
  wager.messageId = message.message_id;
  scheduleSave(); // messageID matters after restart

  // ---- Update messageId in DB once we know it ----
  try {
    await prisma.wager.update({
      where: { id },
      data: { messageId: message.message_id },
    });
  } catch (err) {
    console.error('Failed to update wager.messageId in Postgres:', err.message || err);
  }


  // Countdown updater (5s ticks) – ONLY place that edits the message
  wager.countdownIntervalId = setInterval(async () => {
    const current = new Date();
    const stored = wagers.get(id);
    if (!stored) {
      clearInterval(wager.countdownIntervalId);
      return;
    }

    const remainingMs = stored.voteDeadline.getTime() - current.getTime();
    const done = remainingMs <= 0;
    const newText = buildWagerText(stored, current);

    try {
      await bot.telegram.editMessageText(
        stored.chatId,
        stored.messageId,
        undefined,
        newText,
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: '👍 YES', callback_data: `join:yes:${id}` },
                { text: '👎 NO', callback_data: `join:no:${id}` },
              ],
            ],
          },
        }
      );
    } catch (err) {
      console.error('Failed to edit message:', err.description || err.message);
      if (
        err.response &&
        (err.response.error_code === 400 || err.response.error_code === 403)
      ) {
        clearInterval(stored.countdownIntervalId);
        stored.countdownIntervalId = null;
      }
    }

    if (done) {
      clearInterval(stored.countdownIntervalId);
      stored.countdownIntervalId = null;
    }
  }, 5000); // 5s to avoid rate limits
});

// Handle button clicks
bot.on('callback_query', async (ctx) => {
  const data = ctx.callbackQuery.data || '';
  const parts = data.split(':');

  if (parts[0] !== 'join') {
    return ctx.answerCbQuery();
  }

  const side = parts[1]; // 'yes' or 'no'
  const id = parts[2];

  const wager = wagers.get(id);
  if (!wager) {
    return ctx.answerCbQuery('This wager no longer exists.', { show_alert: true });
  }

  const now = new Date();

  // Enforce 60-second voting window
  if (now > wager.voteDeadline) {
    return ctx.answerCbQuery('Voting has closed for this wager.', { show_alert: true });
  }

  const userId = ctx.from.id;
  const name = getDisplayName(ctx.from);
  wager.participantNames.set(userId, name);


  // Remove user from both sides, then add to chosen side
  wager.yes.delete(userId);
  wager.no.delete(userId);

  if (side === 'yes') {
    wager.yes.add(userId);
  } else if (side === 'no') {
    wager.no.add(userId);
  } else {
    return ctx.answerCbQuery('Unknown option.', { show_alert: true });
  }

  scheduleSave(); // persist vote + participant name

  // ---- Persist vote to Postgres (one row per user per wager) ----
  try {
    await prisma.wagerVote.upsert({
      where: {
        wagerId_userId: {
          wagerId: id,
          userId: String(userId),
        },
      },
      update: {
        side,
        name,
      },
      create: {
        wagerId: id,
        userId: String(userId),
        name,
        side,
      },
    });
  } catch (err) {
    console.error('Failed to persist wager vote to Postgres:', err.message || err);
  }



  // No message edit here – countdown loop will pick up new counts
  await ctx.answerCbQuery(`You joined ${side.toUpperCase()}`);
});

/* ----------------- Auto-resolution loop ----------------- */

// Resolve wagers when resolutionTime has passed
async function resolveDueWagers() {
  const now = new Date();
  console.log('Resolver tick at', now.toISOString());

  for (const [id, wager] of wagers.entries()) {
    if (wager.resolved) continue;
    if (now < wager.resolutionTime) continue;
    if (!wager.assetId) {
      console.log('Skipping wager (no assetId):', id);
      continue;
    }

    try {
      console.log('Attempting to resolve wager', id, 'for', wager.assetSymbol);

      const price = await getCurrentPriceUsd(wager.assetId);
      console.log('Got price for', wager.assetSymbol, ':', price);

      const yesWins = evaluateCondition(price, wager.operator, wager.threshold);

      wager.resolved = true;
      wager.finalPrice = price;
      wager.outcomeYes = yesWins;

      // Build winners/losers lists using stored names (with emojis)
      const winnersSet = yesWins ? wager.yes : wager.no;
      const losersSet  = yesWins ? wager.no  : wager.yes;

      wager.winners = [...winnersSet].map(uid => {
        const name = wager.participantNames.get(uid) || `User ${uid}`;
        return `🏆 ${name}`;
      });

      wager.losers = [...losersSet].map(uid => {
        const name = wager.participantNames.get(uid) || `User ${uid}`;
        return `😞 ${name}`;
      });

      // Sort alphabetically for stable output
      wager.winners.sort((a, b) => a.localeCompare(b));
      wager.losers.sort((a, b) => a.localeCompare(b));

      // ---- Leaderboard scoring ----
      const monthKey = getMonthKey(wager.resolutionTime);
      const allTimeScores = getAllTimeScores(wager.chatId);
      const monthlyScores = getMonthlyScores(wager.chatId, monthKey);

      // Winners: +10 in-memory, +1 win in DB
      for (const uid of winnersSet) {
        const name = wager.participantNames.get(uid) || `User ${uid}`;

        // existing in-memory scoring (keeps /leaderboard working for now)
        addPointsToScores(allTimeScores, uid, name, 10);
        addPointsToScores(monthlyScores, uid, name, 10);

        // all-time row
        await updateLeaderboardRow({
          chatId: wager.chatId,
          userId: uid,
          name,
          scope: 'all',
          monthKey: null,
          winDelta: 1,
          lossDelta: 0,
        });

        // monthly row
        await updateLeaderboardRow({
          chatId: wager.chatId,
          userId: uid,
          name,
          scope: 'month',
          monthKey,
          winDelta: 1,
          lossDelta: 0,
        });
      }

      // Losers: +0 in-memory, +1 loss in DB
      for (const uid of losersSet) {
        const name = wager.participantNames.get(uid) || `User ${uid}`;

        // still keep them in the in-memory table
        addPointsToScores(allTimeScores, uid, name, 0);
        addPointsToScores(monthlyScores, uid, name, 0);

        // all-time row
        await updateLeaderboardRow({
          chatId: wager.chatId,
          userId: uid,
          name,
          scope: 'all',
          monthKey: null,
          winDelta: 0,
          lossDelta: 1,
        });

        // monthly row
        await updateLeaderboardRow({
          chatId: wager.chatId,
          userId: uid,
          name,
          scope: 'month',
          monthKey,
          winDelta: 0,
          lossDelta: 1,
        });
      }
      // ---- end scoring ----

      const resultText = buildResolvedText(wager);
      scheduleSave(); // persist resolved wager + leaderboard updates

      // ---- Persist resolution to Postgres (best-effort) ----
      try {
        await prisma.wager.update({
          where: { id },
          data: {
            resolved: true,
            finalPrice: price,
            outcomeYes: yesWins,
          },
        });
      } catch (err) {
        console.error('Failed to persist wager resolution to Postgres:', err.message || err);
      }



      // First try to edit the original wager message
      let edited = false;
      try {
        console.log(
          'Editing original message',
          'chatId:',
          wager.chatId,
          'messageId:',
          wager.messageId
        );

        await bot.telegram.editMessageText(
          wager.chatId,
          wager.messageId,
          undefined,
          resultText,
          {
            reply_markup: {
              inline_keyboard: [], // remove YES/NO buttons
            },
          }
        );

        edited = true;
        console.log('Successfully edited original message for wager', id);
      } catch (editErr) {
        console.error(
          'Failed to edit original message for wager',
          id,
          editErr.description || editErr.message
        );
      }

      // Fallback: if edit failed for any reason, send a new resolution message
      if (!edited) {
        await bot.telegram.sendMessage(
          wager.chatId,
          `Wager #${wager.id} resolved.\n\n` + resultText
        );
        console.log('Sent separate resolution message for wager', id);
      }

      console.log('Resolved wager', id, 'YES wins?', yesWins);
    } catch (err) {
      console.error('Failed to resolve wager', id, err.message || err);
    }
  }
}

/* ----------------- Launch bot ----------------- */

// Run resolver every 60 seconds
setInterval(resolveDueWagers, 60 * 1000);

await loadState();

// Startup Banner
console.log('Bot starting. PID:', process.pid, 'at', new Date().toISOString());

bot.launch();

console.log('Boot catch-up run at', new Date().toISOString());
resolveDueWagers(); // one-time catch-up on startup

process.once('SIGINT', async () => {
  await prisma.$disconnect();
  bot.stop('SIGINT');
});

process.once('SIGTERM', async () => {
  await prisma.$disconnect();
  bot.stop('SIGTERM');
});

