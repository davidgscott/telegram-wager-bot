// index.js

import { Telegraf, Markup } from 'telegraf';
import 'dotenv/config';
import fsSync from 'fs';
import { PrismaClient } from '@prisma/client';
import OpenAI from 'openai';

// ---- Prevent accidental double-run (local dev only) ----
// In cloud environments, single-instance is enforced by the platform.
const IS_CLOUD = !!(process.env.RAILWAY_ENVIRONMENT || process.env.RENDER || process.env.FLY_APP_NAME);

if (!IS_CLOUD) {
  const LOCK_FILE = './bot.lock';

  if (fsSync.existsSync(LOCK_FILE)) {
    const pid = Number(fsSync.readFileSync(LOCK_FILE, 'utf8').trim());
    try {
      process.kill(pid, 0); // will throw if not running
    } catch {
      fsSync.unlinkSync(LOCK_FILE);
    }
  }

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

const prisma = new PrismaClient();
const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;
if (!openai) console.warn('WARNING: OPENAI_API_KEY not set — natural language wager parsing disabled.');

// ---- Telegraf Bot Instance ----
const bot = new Telegraf(process.env.BOT_TOKEN);

// ---- In-memory stores ----
const wagers = new Map();
const allTimeScoresByChat = new Map();
const monthlyScoresByChat = new Map();

// Pending natural-language wager conversations (keyed by "chatId:userId")
const pendingWagers = new Map();

// Mapping of supported ticker symbols to CoinGecko IDs
// Common symbols we know without a network call
const SYMBOL_TO_ID = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  DIVI: 'divi',
  SOL: 'solana',
  ADA: 'cardano',
  XRP: 'ripple',
  DOGE: 'dogecoin',
  DOT: 'polkadot',
  AVAX: 'avalanche-2',
  MATIC: 'matic-network',
  LINK: 'chainlink',
  LTC: 'litecoin',
  SHIB: 'shiba-inu',
  UNI: 'uniswap',
  ATOM: 'cosmos',
};

// Cache for dynamically resolved symbols (avoids repeated API calls)
const symbolCache = new Map(Object.entries(SYMBOL_TO_ID));

// Resolve a ticker symbol to a CoinGecko ID.
// Checks static map + cache first, then searches CoinGecko API.
async function resolveAssetId(symbol) {
  const upper = symbol.toUpperCase();
  if (symbolCache.has(upper)) return { assetSymbol: upper, assetId: symbolCache.get(upper) };

  try {
    const url = `https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(upper)}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    // Find the coin whose symbol matches exactly (case-insensitive)
    const match = (data.coins || []).find(c => c.symbol.toUpperCase() === upper);
    if (match) {
      symbolCache.set(upper, match.id);
      return { assetSymbol: upper, assetId: match.id };
    }
  } catch (err) {
    console.error('CoinGecko search failed:', err.message || err);
  }
  return null;
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

// Format a future date as a human-readable relative string like "in about 2 hours"
function formatRelative(date, now = new Date()) {
  const diffMs = date.getTime() - now.getTime();
  if (diffMs <= 0) return 'now';

  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return 'less than a minute';
  if (minutes === 1) return 'about 1 minute';
  if (minutes < 60) return `about ${minutes} minutes`;

  const hours = Math.floor(minutes / 60);
  const remainMins = minutes % 60;
  if (hours < 24) {
    if (remainMins === 0) return `about ${hours} hour${hours > 1 ? 's' : ''}`;
    return `about ${hours}h ${remainMins}m`;
  }

  const days = Math.floor(hours / 24);
  const remainHours = hours % 24;
  if (remainHours === 0) return `about ${days} day${days > 1 ? 's' : ''}`;
  return `about ${days}d ${remainHours}h`;
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


// "Before deadline" operators end with ? — check every tick, resolve early on hit
function isBeforeDeadlineOp(op) {
  return op.endsWith('?');
}
// Get the base comparison operator (strip the ?)
function baseOp(op) {
  return op.endsWith('?') ? op.slice(0, -1) : op;
}
// Human-readable operator label for display
function operatorLabel(op) {
  const labels = {
    '>': 'above', '<': 'below', '>=': 'at or above', '<=': 'at or below',
    '>?': 'above (anytime before deadline)', '<?': 'below (anytime before deadline)',
    '>=?': 'at or above (anytime before deadline)', '<=?': 'at or below (anytime before deadline)',
  };
  return labels[op] || op;
}

// Parse "SYMBOL OPERATOR VALUE" into structured condition
async function parseCondition(raw) {
  const trimmed = raw.trim();
  // e.g. "BTC > 100000" or "DIVI <=? 0.01"
  const match = trimmed.match(/^([A-Za-z0-9]+)\s*(>=\??|<=\??|>\??|<\??)\s*([0-9]+(?:\.[0-9]+)?)$/);
  if (!match) return null;

  const [, symbolRaw, operator, thresholdStr] = match;
  const threshold = Number(thresholdStr);
  if (!Number.isFinite(threshold)) return null;

  const resolved = await resolveAssetId(symbolRaw);
  if (!resolved) return null;

  return { assetSymbol: resolved.assetSymbol, assetId: resolved.assetId, operator, threshold };
}

// Evaluate price against the condition, return true if YES should win
// Before-deadline operators (>?, <?, etc) use the same comparison — timing is handled by the resolver
function evaluateCondition(price, operator, threshold) {
  switch (baseOp(operator)) {
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
    const totalSecs = Math.ceil(remainingMs / 1000);
    const h = Math.floor(totalSecs / 3600);
    const m = Math.floor((totalSecs % 3600) / 60);
    const s = totalSecs % 60;
    const timeStr = h > 0
      ? `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
      : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    statusLine = `Voting closes in ${timeStr}`;
  }

  const conditionLine = `Condition: ${wager.assetSymbol} ${operatorLabel(wager.operator)} $${wager.threshold}`;
  const isBefore = isBeforeDeadlineOp(wager.operator);
  const resolveLine = isBefore
    ? `On or before: ${formatUtc(wager.resolutionTime)} (${formatRelative(wager.resolutionTime, now)})`
    : `By: ${formatUtc(wager.resolutionTime)} (${formatRelative(wager.resolutionTime, now)})`;

  return (
    `Wager #${wager.id}\n` +
    `${conditionLine}\n\n` +
    `${resolveLine}\n` +
    `Voting closes at: ${formatUtc(wager.voteDeadline)}\n\n` +
    `YES: ${wager.yes.size} user(s)\n` +
    `NO: ${wager.no.size} user(s)\n\n` +
    statusLine
  );
}

// Build text for a resolved wager
function buildResolvedText(wager) {
  const conditionLine = `Condition: ${wager.assetSymbol} ${operatorLabel(wager.operator)} $${wager.threshold}`;
  const isBefore = isBeforeDeadlineOp(wager.operator);
  const winnerSide = wager.outcomeYes ? 'YES' : 'NO';
  const deadlineLabel = isBefore ? 'Deadline was' : 'Resolved at';

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
    `${deadlineLabel}: ${formatUtc(wager.resolutionTime)}\n` +
    `Final price: $${wager.finalPrice}\n` +
    `Winning side: ${winnerSide}\n\n` +
    `YES: ${wager.yes.size} user(s)\n` +
    `NO: ${wager.no.size} user(s)\n\n` +
    `Winners (${wager.winners?.length || 0}):\n${winnersText}\n\n` +
    `Losers (${wager.losers?.length || 0}):\n${losersText}\n\n` +
    `Voting is CLOSED.`
  );
}

// Start or restart the countdown timer for a wager 
function startCountdown(wager) {
  
  // Clear any existing timer just in case
  if (wager.countdownIntervalId) {
    clearInterval(wager.countdownIntervalId);
    wager.countdownIntervalId = null;
  }

  const id = wager.id;

  wager.countdownIntervalId = setInterval(async () => {
    const current = new Date();
    const stored = wagers.get(id);

    // If wager disappeared from memory, stop the timer
    if (!stored) {
      clearInterval(wager.countdownIntervalId);
      wager.countdownIntervalId = null;
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
      'Create a wager using plain language:\n' +
      '/wager BTC above 70000 in 2 hours\n' +
      '/wager I think ETH will be under 3000 by tomorrow\n\n' +
      'Or use the strict format:\n' +
      '/wager BTC > 70000 | in 2 hours\n\n' +
      'Supports any coin on CoinGecko (BTC, ETH, SOL, DOGE, etc)\n' +
      'Resolution must be at least 5 minutes from now.\n' +
      'Voting window is 60 seconds after creation.'
  );
});

const leaderboardCooldowns = new Map(); // chatId -> last used timestamp

bot.command('leaderboard', async (ctx) => {
  if (ctx.chat.type === 'private') {
    return ctx.reply('Leaderboards are group-specific. Use /leaderboard in a group chat to see scores.');
  }

  const chatId = ctx.chat.id;
  const now = Date.now();
  const lastUsed = leaderboardCooldowns.get(chatId) || 0;
  const cooldownMs = 30 * 60 * 1000; // 30 minutes
  if (now - lastUsed < cooldownMs) {
    const minsLeft = Math.ceil((cooldownMs - (now - lastUsed)) / 60000);
    return ctx.reply(`/leaderboard can only be used once every 30 minutes. Try again in ${minsLeft} minute(s).`);
  }
  leaderboardCooldowns.set(chatId, now);

  const chatIdStr = String(ctx.chat.id);
  const text = ctx.message.text || '';
  const arg = text.replace(/^\/leaderboard(@\w+)?\s*/, '').trim().toLowerCase();

  const thisMonthKey = getMonthKey(new Date());

  async function fetchTop(scope, monthKey) {
    const where = {
      chatId: chatIdStr,
      scope,
      monthKey: scope === 'all' ? 'ALL' : monthKey,
    };

    const rows = await prisma.leaderboardScore.findMany({
      where,
      orderBy: { powerScore: 'desc' }, // <-- sort by powerScore
      take: 10,
    });

    if (!rows.length) {
      return 'No scores yet. Resolve a wager first.';
    }

    return rows
      .map((row, i) => {
        const ps = row.powerScore ?? 0;
        const wins = row.wins ?? 0;
        const losses = row.losses ?? 0;
        return `${i + 1}. ${row.name} — PS ${ps.toFixed(1)} (W:${wins} L:${losses})`;
      })
      .join('\n');
  }

  try {
    if (arg === 'all') {
      const allTimeText = await fetchTop('all', 'ALL');
      return ctx.reply(
        `🏆 All-time leaderboard (by PowerScore):\n\n${allTimeText}\n\n` +
        `Type /powerscore to see how PowerScore is calculated.`
      );
    }

    if (arg === 'month' || arg === 'thismonth') {
      const monthText = await fetchTop('month', thisMonthKey);
      return ctx.reply(
        `📅 This month (${thisMonthKey}) leaderboard (by PowerScore):\n\n${monthText}\n\n` +
        `Type /powerscore to see how PowerScore is calculated.`
      );
    }

    // Default: show both
    const [allTimeText, monthText] = await Promise.all([
      fetchTop('all', 'ALL'),
      fetchTop('month', thisMonthKey),
    ]);

    return ctx.reply(
      `🏆 All-time leaderboard (by PowerScore):\n\n${allTimeText}\n\n` +
      `📅 This month (${thisMonthKey}) leaderboard (by PowerScore):\n\n${monthText}\n\n` +
      `Type /powerscore to see how PowerScore is calculated.`
    );
  } catch (err) {
    console.error('Failed to load leaderboard from Postgres:', err.message || err);
    return ctx.reply('Sorry, something went wrong loading the leaderboard. Try again in a moment.');
  }
});

// WagerHelp Instructions
bot.command('wagerhelp', async (ctx) => {
  if (ctx.chat.type !== 'private') {
    return ctx.reply('/wagerhelp is only available via DM.');
  }

  ctx.reply(
    'DIVI Wager Bot allows you to create friendly prediction wagers in Telegram groups.\n\n' +
    'Just describe your wager in plain language:\n' +
      '/wager BTC above 70000 in 2 hours\n' +
      '/wager I think ETH will drop below 3000 by tomorrow\n' +
      '/wager DIVI over 0.002 by end of the week\n\n' +
      'The bot will figure out what you mean! If something is unclear, it will ask you.\n\n' +
      'You can also use the strict format:\n' +
      '/wager BTC > 70000 | in 2 hours\n' +
      '/wager ETH < 3000 | 2026-12-31 00:00\n\n' +
      'Supports any coin on CoinGecko (BTC, ETH, SOL, DOGE, etc)\n\n' +
      'Rules:\n' +
      '• Resolution must be at least 5 minutes from now\n' +
      '• Prices come from CoinGecko\n' +
      '• Voting stays open for 60 seconds after creation\n' +
      '• Winners and losers are displayed automatically at resolution\n\n' +
      'Tip: Type /leaderboard to see the top winners 🐐\n' +
      '🏆 Rankings are based on win rate and total wagers — consistency matters.'
  );
});

bot.command('powerscore', (ctx) => {
  ctx.reply(
    'PowerScore is the ranking metric used on the leaderboard.\n\n' +
    'For each user:\n' +
    '• wins = number of correct wagers\n' +
    '• losses = number of incorrect wagers\n' +
    '• total = wins + losses\n' +
    '• winRate = total > 0 ? wins / total : 0\n' +
    '• powerScore = winRate × 100 × √total\n\n' +
    'This rewards both:\n' +
    '• high win rate (accuracy), and\n' +
    '• a meaningful number of wagers (volume).\n\n' +
    'So a user who wins often with many wagers will outrank someone\n' +
    'who has a perfect record on only a few wagers.'
  );
});

// Personal stats (DM only)
bot.command('mystats', async (ctx) => {
  const userId = String(ctx.from.id);
  const isGroup = ctx.chat.type !== 'private';
  // In groups, scope stats to this chat; in DMs, show across all chats
  const chatFilter = isGroup ? { chatId: String(ctx.chat.id) } : {};
  const wagerChatFilter = isGroup ? { chatId: String(ctx.chat.id) } : {};
  const now = new Date();

  try {
    // 1. Leaderboard rankings
    const scores = await prisma.leaderboardScore.findMany({
      where: { userId, scope: 'all', ...chatFilter },
      orderBy: { powerScore: 'desc' },
    });

    let rankingText;
    if (!scores.length) {
      rankingText = 'No rankings yet. Join and resolve some wagers first!';
    } else {
      const lines = [];
      for (const s of scores) {
        const higher = await prisma.leaderboardScore.count({
          where: { chatId: s.chatId, scope: 'all', monthKey: 'ALL', powerScore: { gt: s.powerScore } },
        });
        const rank = higher + 1;
        const winRate = s.total > 0 ? ((s.wins / s.total) * 100).toFixed(0) : '0';
        lines.push(`#${rank} — PS ${s.powerScore.toFixed(1)} | W:${s.wins} L:${s.losses} (${winRate}% win rate)`);
      }
      rankingText = lines.join('\n');
    }

    // 2. Pending/unresolved wagers the user has voted on
    const pendingVotes = await prisma.wagerVote.findMany({
      where: { userId, wager: { resolved: false, ...wagerChatFilter } },
      include: { wager: true },
    });
    const pendingWagersList = pendingVotes
      .filter(v => v.wager && !v.wager.resolved)
      .map(v => {
        const w = v.wager;
        const timeLeft = formatRelative(w.resolutionTime, now);
        return `${w.assetSymbol} ${w.operator} ${w.threshold} — you voted ${v.side.toUpperCase()} — resolves in ${timeLeft}`;
      });

    const pendingText = pendingWagersList.length
      ? pendingWagersList.join('\n')
      : 'No pending wagers.';

    // 3. Recent resolved wagers (last 25)
    const recentVotes = await prisma.wagerVote.findMany({
      where: { userId, wager: { resolved: true, ...wagerChatFilter } },
      include: { wager: true },
      orderBy: { createdAt: 'desc' },
      take: 25,
    });
    const resolvedHistory = recentVotes
      .filter(v => v.wager && v.wager.resolved)
      .map(v => {
        const w = v.wager;
        const won = (w.outcomeYes && v.side === 'yes') || (!w.outcomeYes && v.side === 'no');
        const icon = won ? '✅' : '❌';
        return `${icon} ${w.assetSymbol} ${w.operator} ${w.threshold} — voted ${v.side.toUpperCase()} — price: $${w.finalPrice}`;
      });

    const historyText = resolvedHistory.length
      ? resolvedHistory.join('\n')
      : 'No resolved wagers yet.';

    const reply =
      `📊 Your Stats\n\n` +
      `🏆 Rankings (all-time):\n${rankingText}\n\n` +
      `⏳ Pending Wagers:\n${pendingText}\n\n` +
      `📜 Recent History (last ${resolvedHistory.length || 0}):\n${historyText}`;

    // In group chats, send via DM and confirm in the group
    if (isGroup) {
      try {
        await bot.telegram.sendMessage(ctx.from.id, reply);
        return ctx.reply('Stats sent to your DM!');
      } catch {
        return ctx.reply('I couldn\'t DM you. Please start a chat with me first, then try again.');
      }
    }

    return ctx.reply(reply);
  } catch (err) {
    console.error('Failed to load mystats:', err.message || err);
    return ctx.reply('Something went wrong loading your stats. Try again later.');
  }
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

  // Developer override: allow "--debug" to bypass the minimum resolution time
  const isDebug = withoutCommand.includes('--debug') && ctx.from.id === ADMIN_USER_ID;

  // Remove --debug from the input so parsing stays clean
  const cleanedInput = withoutCommand.replace('--debug', '').trim();

  if (!cleanedInput) {
    return ctx.reply('TICKER above or below PRICE by WHEN?\n\nExample: /wager BTC above 70000 in 2 hours');
  }

  const now = new Date();

  // ---- Step 1: Try strict parsing first (free, instant) ----
  const strictResult = await tryStrictParse(cleanedInput, now, isDebug);
  if (strictResult.success) {
    return await createWager(ctx, strictResult.condition, strictResult.resolutionTime, now);
  }
  // If strict parsing returned an explicit user error (e.g. bad time), show it
  if (strictResult.error) {
    // Don't show strict-format errors — fall through to LLM instead
  }

  // ---- Step 2: Fall back to LLM natural language parsing ----
  const pendingKey = `${ctx.chat.id}:${ctx.from.id}`;

  try {
    const llmMessages = [
      { role: 'user', content: `Current UTC time: ${now.toISOString()}\n\nCreate a wager: ${cleanedInput}` },
    ];

    const result = await parseWagerWithLLM(llmMessages);
    if (!result) {
      return ctx.reply('Sorry, I couldn\'t understand that. Try: /wager BTC > 70000 | in 2 hours');
    }

    if (result.confidence === 'complete') {
      // Validate the extracted fields
      const validation = await validateLLMResult(result, now, isDebug, cleanedInput);
      if (validation.error) {
        return ctx.reply(validation.error);
      }
      return await createWager(ctx, validation.condition, validation.resolutionTime, now);
    }

    if (result.confidence === 'partial') {
      // Store conversation for follow-up
      pendingWagers.set(pendingKey, {
        partialData: result,
        conversationHistory: llmMessages,
        createdAt: now,
        attempts: 1,
      });
      return ctx.reply(result.clarification_message || 'I need a bit more info. What coin, price, and time did you have in mind?');
    }

    // confidence === 'unclear'
    return ctx.reply(
      'I couldn\'t interpret that as a wager.\n\n' +
        'Try something like:\n' +
        '/wager BTC above 70000 in 2 hours\n' +
        '/wager ETH under 3000 by tomorrow'
    );
  } catch (err) {
    console.error('LLM wager parsing failed:', err.message || err);
    return ctx.reply('Sorry, I couldn\'t process that right now. Try the strict format: /wager BTC > 70000 | in 2 hours');
  }
});

// Try the original strict "CONDITION | TIME" format — returns {success, condition, resolutionTime} or {error}
async function tryStrictParse(input, now, isDebug) {
  const parts = input.split('|').map((s) => s.trim());
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { success: false };
  }

  const condition = await parseCondition(parts[0]);
  if (!condition) return { success: false };

  const resolutionTime = parseResolution(parts[1], now);
  if (!resolutionTime || isNaN(resolutionTime.getTime())) return { success: false };

  const diffMs = resolutionTime.getTime() - now.getTime();
  const minResolutionMs = 5 * 60 * 1000;
  if (!isDebug && diffMs < minResolutionMs) {
    return { success: false, error: `Resolution time must be at least 5 minutes from now.` };
  }

  return { success: true, condition, resolutionTime };
}

// Validate and convert LLM extraction result into condition + resolutionTime
// rawInput: optional user text — if it contains "before", force the ? operator suffix
async function validateLLMResult(result, now, isDebug, rawInput = '') {
  const { symbol, threshold, resolution_time } = result;
  let { operator } = result;

  // If user said "before" or "on or before" but LLM didn't use a ? operator, fix it
  if (rawInput && /\bbefore\b/i.test(rawInput) && operator && !operator.endsWith('?')) {
    operator = operator + '?';
  }

  if (!symbol || !operator || threshold == null || !resolution_time) {
    return { error: 'Missing required wager fields. Please try again.' };
  }

  const resolved = await resolveAssetId(symbol);
  if (!resolved) {
    return { error: `Could not find "${symbol}" on CoinGecko. Check the ticker symbol and try again.` };
  }
  const assetId = resolved.assetId;

  // Parse resolution time — try relative ("2 hours"), then our strict format, then ISO timestamp
  let resolutionTime = parseResolution(`in ${resolution_time}`, now);
  if (!resolutionTime || isNaN(resolutionTime.getTime())) {
    resolutionTime = parseResolution(resolution_time, now);
  }
  if (!resolutionTime || isNaN(resolutionTime.getTime())) {
    // Try parsing as ISO timestamp (e.g. "2026-03-25T07:31:03.442Z")
    const isoAttempt = new Date(resolution_time);
    if (!isNaN(isoAttempt.getTime())) {
      resolutionTime = isoAttempt;
    }
  }
  if (!resolutionTime || isNaN(resolutionTime.getTime())) {
    return { error: `I couldn't understand the time "${resolution_time}". Try something like "in 2 hours" or "2026-03-25 14:00".` };
  }

  const diffMs = resolutionTime.getTime() - now.getTime();
  const minResolutionMs = 5 * 60 * 1000;
  if (!isDebug && diffMs < minResolutionMs) {
    return { error: 'Resolution time must be at least 5 minutes from now.' };
  }

  return {
    condition: { assetSymbol: resolved.assetSymbol, assetId, operator, threshold },
    resolutionTime,
  };
}

// ---- LLM-powered natural language wager parsing ----

const WAGER_EXTRACT_TOOL = {
  type: 'function',
  function: {
    name: 'extract_wager',
    description: 'Extract structured wager parameters from natural language input.',
    parameters: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'The cryptocurrency ticker symbol (e.g. BTC, ETH, SOL, DOGE, ADA, etc). Use the standard ticker, uppercased.',
        },
        operator: {
          type: 'string',
          enum: ['>', '<', '>=', '<=', '>?', '<?', '>=?', '<=?'],
          description: 'The comparison operator. Use >? <? >=? <=? when the user wants the condition checked anytime BEFORE a deadline (e.g. "hits 70k before Friday", "above 70k by tomorrow", "at 70k on or before Friday"). Use > < >= <= for standard at-deadline checks.',
        },
        threshold: {
          type: 'number',
          description: 'The target price in USD.',
        },
        resolution_time: {
          type: 'string',
          description: 'When to check the price. Return as either a relative duration like "2 hours" or "30 minutes" or "3 days", OR an absolute UTC time like "2026-03-25 14:00". Always convert to UTC.',
        },
        confidence: {
          type: 'string',
          enum: ['complete', 'partial', 'unclear'],
          description: '"complete" if all 4 fields are present and clear, "partial" if some are missing, "unclear" if the message is not a wager.',
        },
        missing_fields: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of fields that could not be determined.',
        },
        clarification_message: {
          type: 'string',
          description: 'A friendly question to ask the user for any missing information. Keep it short and conversational.',
        },
      },
      required: ['confidence'],
    },
  },
};

const WAGER_SYSTEM_PROMPT = `You are a helper for a Telegram crypto wager bot. Users want to create price prediction wagers.

Any cryptocurrency available on CoinGecko is supported. Use standard ticker symbols (e.g. BTC, ETH, SOL, DOGE, ADA, XRP, AVAX, LINK, DIVI, etc).
Common aliases: "bitcoin" = BTC, "ethereum"/"ether" = ETH, "solana" = SOL, "dogecoin" = DOGE, etc.

Operator mapping:
Standard (check at deadline):
- "above", "over", "more than", "higher than", "greater than" → ">"
- "below", "under", "less than", "lower than" → "<"
- "at least", "no less than" → ">="
- "at most", "no more than" → "<="

Before-deadline (check every minute, resolve early if condition is hit):
- "above X before Y", "hits X before Y" → ">?"
- "below X before Y", "drops to X before Y" → "<?"
- "at least X before Y" → ">=?"
- "at most X before Y" → "<=?"

IMPORTANT: Only use the ? operators when the user explicitly says "before" as a TIME qualifier.
- "before" in a TIME context (e.g. "before tomorrow", "before 2pm", "on or before Friday") → use ? operator
- "before" is the ONLY word that triggers ? operators. "by", "at", "on", "in" use STANDARD operators.

CRITICAL: "on or before" is a TIME phrase meaning "anytime before the deadline" → use ? operator.
Do NOT confuse time qualifiers with price qualifiers:
- "below 70000" = price condition (operator <)
- "before tomorrow" = time condition (adds ? to the operator)
- "below 70000 on or before tomorrow" = operator "<?" with resolution_time "tomorrow"
- "below 70000 by tomorrow" = operator "<" with resolution_time "tomorrow"

Time handling:
- The current UTC time will be provided. Use it to resolve relative times like "tomorrow", "next friday", "in 2 hours".
- Always return resolution_time in UTC.
- "tomorrow 10am" with no timezone specified should be treated as UTC.
- If a timezone is mentioned (e.g. "10am EST"), convert to UTC.

Your job:
1. Extract: symbol, operator, threshold (price), and resolution_time.
2. If all 4 are clear, set confidence to "complete".
3. If some are missing, set confidence to "partial" and write a short clarification_message asking for the missing info.
4. If the message doesn't seem like a wager at all, set confidence to "unclear".

Always call the extract_wager function with your best extraction.`;

async function parseWagerWithLLM(messages) {
  if (!openai) throw new Error('Natural language parsing unavailable (no API key).');
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: WAGER_SYSTEM_PROMPT },
      ...messages,
    ],
    tools: [WAGER_EXTRACT_TOOL],
    tool_choice: { type: 'function', function: { name: 'extract_wager' } },
    temperature: 0,
  });

  const toolCall = response.choices[0]?.message?.tool_calls?.[0];
  if (!toolCall) return null;

  try {
    return JSON.parse(toolCall.function.arguments);
  } catch {
    return null;
  }
}

// Shared wager creation logic — used by both strict parser and LLM parser
async function createWager(ctx, condition, resolutionTime, now = new Date()) {
  // Voting window: 10% of time to resolution, min 60s, max 24h
  const timeToResolutionMs = resolutionTime.getTime() - now.getTime();
  const votingWindowMs = Math.min(Math.max(timeToResolutionMs * 0.1, 60_000), 24 * 60 * 60_000);
  const voteDeadline = new Date(now.getTime() + votingWindowMs);

  // Simple unique ID for the wager
  const id = Date.now().toString();

  const conditionText = `${condition.assetSymbol} ${condition.operator} ${condition.threshold}`;

  // Create wager in memory (with structured condition)
  const wager = {
    id,
    text: conditionText,
    assetSymbol: condition.assetSymbol,
    assetId: condition.assetId,
    operator: condition.operator,
    threshold: condition.threshold,
    yes: new Set(),
    no: new Set(),
    participantNames: new Map(),
    chatId: ctx.chat.id,
    messageId: null,
    createdAt: now,
    resolutionTime,
    voteDeadline,
    countdownIntervalId: null,
    resolved: false,
    finalPrice: null,
    outcomeYes: null,
  };

  wagers.set(id, wager);

  // ---- Persist wager to Postgres (best-effort) ----
  try {
    await prisma.wager.create({
      data: {
        id,
        chatId: String(ctx.chat.id),
        messageId: null,
        text: conditionText,
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

  // Store messageId in memory + DB
  wager.messageId = message.message_id;

  try {
    await prisma.wager.update({
      where: { id },
      data: { messageId: message.message_id },
    });
  } catch (err) {
    console.error('Failed to update wager.messageId in Postgres:', err.message || err);
  }

  // Start the countdown updater for this wager
  startCountdown(wager);
}

async function rebuildActiveWagersFromDb({ graceHours = 24 } = {}) {
  const now = new Date();
  const graceStart = new Date(now.getTime() - graceHours * 60 * 60 * 1000);

  console.log(
    `Rebuilding active wagers from DB (resolved = false, resolutionTime >= ${graceStart.toISOString()})`
  );

  // Clear any existing in-memory wagers
  wagers.clear();

  let dbWagers;
  try {
    dbWagers = await prisma.wager.findMany({
      where: {
        resolved: false,
        resolutionTime: { gte: graceStart },
      },
    });
  } catch (err) {
    console.error(
      'Failed to load unresolved wagers from Postgres:',
      err.message || err
    );
    return;
  }

  if (dbWagers.length === 0) {
    console.log('No unresolved wagers found in DB for rebuild.');
    return;
  }

  // Load all votes for these wagers in a single query
  const wagerIds = dbWagers.map((w) => w.id);

  let dbVotes;
  try {
    dbVotes = await prisma.wagerVote.findMany({
      where: {
        wagerId: { in: wagerIds },
      },
    });
  } catch (err) {
    console.error(
      'Failed to load wager votes from Postgres:',
      err.message || err
    );
    dbVotes = [];
  }

  const votesByWagerId = new Map();
  for (const v of dbVotes) {
    if (!votesByWagerId.has(v.wagerId)) {
      votesByWagerId.set(v.wagerId, []);
    }
    votesByWagerId.get(v.wagerId).push(v);
  }

  for (const dbW of dbWagers) {
    const yes = new Set();
    const no = new Set();
    const participantNames = new Map();

    const votesForThis = votesByWagerId.get(dbW.id) || [];

    for (const v of votesForThis) {
      // Convert userId back to number if possible, to match your existing in-memory usage
      const userIdNum = Number(v.userId);
      const uid = Number.isNaN(userIdNum) ? v.userId : userIdNum;

      if (v.side === 'yes') {
        yes.add(uid);
      } else if (v.side === 'no') {
        no.add(uid);
      }

      if (v.name) {
        participantNames.set(uid, v.name);
      }
    }

    const wager = {
      id: dbW.id,
      text: dbW.text,
      assetSymbol: dbW.assetSymbol,
      assetId: dbW.assetId,
      operator: dbW.operator,
      threshold: dbW.threshold,
      yes,
      no,
      participantNames,
      chatId: Number(dbW.chatId) || dbW.chatId,
      messageId: dbW.messageId,
      createdAt: dbW.createdAt,
      resolutionTime: dbW.resolutionTime,
      voteDeadline: dbW.voteDeadline,
      countdownIntervalId: null,
      resolved: dbW.resolved,
      finalPrice: dbW.finalPrice,
      outcomeYes: dbW.outcomeYes,
      // winners/losers will be filled at resolution time
      winners: [],
      losers: [],
    };

    wagers.set(wager.id, wager);

    // If voting is still open, restart the countdown
    if (now < wager.voteDeadline) {
      startCountdown(wager);
    }
  }

  console.log(`Rebuilt ${wagers.size} active wagers from DB.`);
}

async function rebuildLeaderboardsFromDb() {
  console.log('Rebuilding leaderboards from DB...');

  // Clear in-memory leaderboards
  allTimeScoresByChat.clear();
  monthlyScoresByChat.clear();

  let rows;
  try {
    rows = await prisma.leaderboardScore.findMany();
  } catch (err) {
    console.error(
      'Failed to load leaderboard scores from Postgres:',
      err.message || err
    );
    return;
  }

  if (!rows.length) {
    console.log('No leaderboard rows found in DB.');
    return;
  }

  for (const row of rows) {
    const chatKey = Number(row.chatId) || row.chatId;
    const userKey = Number(row.userId) || row.userId;
    const points = (row.wins || 0) * 10; // matches +10 per win in memory

    if (row.scope === 'all') {
      if (!allTimeScoresByChat.has(chatKey)) {
        allTimeScoresByChat.set(chatKey, new Map());
      }
      const chatMap = allTimeScoresByChat.get(chatKey);
      const existing = chatMap.get(userKey) || { name: row.name, points: 0 };

      // If multiple rows exist for same user (shouldn't, but just in case), sum points
      const newPoints = (existing.points || 0) + points;
      chatMap.set(userKey, { name: row.name, points: newPoints });
    } else if (row.scope === 'month') {
      const monthKey = row.monthKey;
      if (!monthlyScoresByChat.has(chatKey)) {
        monthlyScoresByChat.set(chatKey, new Map());
      }
      const monthsMap = monthlyScoresByChat.get(chatKey);
      if (!monthsMap.has(monthKey)) {
        monthsMap.set(monthKey, new Map());
      }
      const scoresMap = monthsMap.get(monthKey);
      const existing = scoresMap.get(userKey) || { name: row.name, points: 0 };
      const newPoints = (existing.points || 0) + points;
      scoresMap.set(userKey, { name: row.name, points: newPoints });
    }
  }

  console.log(
    `Rebuilt leaderboards for ${allTimeScoresByChat.size} chat(s) from DB.`
  );
}

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

// ---- Follow-up handler for pending natural-language wagers ----
bot.on('text', async (ctx) => {
  // Only handle non-command messages from users with a pending wager conversation
  const text = ctx.message.text || '';
  if (text.startsWith('/')) return; // ignore commands

  const pendingKey = `${ctx.chat.id}:${ctx.from.id}`;
  const pending = pendingWagers.get(pendingKey);
  if (!pending) return; // no pending conversation — ignore

  const now = new Date();

  // Limit follow-up attempts to prevent abuse
  if (pending.attempts >= 3) {
    pendingWagers.delete(pendingKey);
    return ctx.reply(
      'I\'m having trouble understanding. Let\'s start over.\n' +
        'Try: /wager BTC > 70000 | in 2 hours'
    );
  }

  try {
    // Add the follow-up message to conversation history
    pending.conversationHistory.push({ role: 'user', content: `Current UTC time: ${now.toISOString()}\n\n${text}` });
    pending.attempts++;

    const result = await parseWagerWithLLM(pending.conversationHistory);
    if (!result) {
      return ctx.reply('I still couldn\'t understand. Try: /wager BTC > 70000 | in 2 hours');
    }

    if (result.confidence === 'complete') {
      pendingWagers.delete(pendingKey);
      const validation = await validateLLMResult(result, now, false, text);
      if (validation.error) {
        return ctx.reply(validation.error);
      }
      return await createWager(ctx, validation.condition, validation.resolutionTime, now);
    }

    if (result.confidence === 'partial') {
      pending.partialData = result;
      return ctx.reply(result.clarification_message || 'I still need more info. What coin, price target, and deadline?');
    }

    // unclear
    pendingWagers.delete(pendingKey);
    return ctx.reply('I couldn\'t interpret that as a wager. Try: /wager BTC > 70000 | in 2 hours');
  } catch (err) {
    console.error('LLM follow-up failed:', err.message || err);
    pendingWagers.delete(pendingKey);
    return ctx.reply('Something went wrong. Try: /wager BTC > 70000 | in 2 hours');
  }
});

// Clean up stale pending wager conversations every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, pending] of pendingWagers.entries()) {
    if (now - pending.createdAt.getTime() > 5 * 60 * 1000) {
      pendingWagers.delete(key);
    }
  }
}, 5 * 60 * 1000);

/* ----------------- Auto-resolution loop ----------------- */

// Resolve wagers (DB-first)
// Standard wagers: resolve at resolutionTime
// Before-deadline wagers (operator ends with ?): check every tick, resolve early if condition met
async function resolveDueWagers() {
  const now = new Date();
  console.log('Resolver tick at', now.toISOString());

  let unresolvedWagers;
  try {
    unresolvedWagers = await prisma.wager.findMany({
      where: { resolved: false },
      include: { votes: true },
    });
  } catch (err) {
    console.error('Failed to load wagers from Postgres:', err.message || err);
    return;
  }

  // Split into: standard wagers past deadline, and before-deadline wagers to check now
  const toResolve = []; // will hold { dbW, forceOutcome? } objects

  for (const dbW of unresolvedWagers) {
    if (!dbW.assetId) continue;

    if (isBeforeDeadlineOp(dbW.operator)) {
      // Before-deadline: check every tick (but only after voting closes)
      if (now >= dbW.voteDeadline) {
        if (now >= dbW.resolutionTime) {
          // Deadline passed without hitting — NO wins
          toResolve.push({ dbW, forceOutcome: false });
        } else {
          // Still active — check price now
          toResolve.push({ dbW, checkEarly: true });
        }
      }
    } else {
      // Standard wager: only resolve once deadline passes
      if (now >= dbW.resolutionTime) {
        toResolve.push({ dbW });
      }
    }
  }

  if (!toResolve.length) {
    console.log('No wagers to process.');
    return;
  }

  // Group by assetId to batch price lookups
  const priceCache = new Map();

  for (const { dbW, forceOutcome, checkEarly } of toResolve) {
    const chatId = Number(dbW.chatId) || dbW.chatId;

    // Rebuild yes/no sets and participant names from DB votes
    const yesSet = new Set();
    const noSet = new Set();
    const participantNames = new Map();

    for (const v of dbW.votes) {
      const userIdNum = Number(v.userId);
      const uid = Number.isNaN(userIdNum) ? v.userId : userIdNum;
      if (v.side === 'yes') yesSet.add(uid);
      else if (v.side === 'no') noSet.add(uid);
      if (v.name) participantNames.set(uid, v.name);
    }

    try {
      // Get price (cached per assetId per tick)
      if (!priceCache.has(dbW.assetId)) {
        const price = await getCurrentPriceUsd(dbW.assetId);
        priceCache.set(dbW.assetId, price);
        console.log('Got price for', dbW.assetSymbol, ':', price);
      }
      const price = priceCache.get(dbW.assetId);

      let yesWins;
      if (forceOutcome !== undefined) {
        // Deadline passed on before-deadline wager — condition was never met
        yesWins = forceOutcome;
        console.log('Before-deadline wager', dbW.id, 'expired — NO wins');
      } else if (checkEarly) {
        // Before-deadline wager still active — check if condition is met now
        const conditionMet = evaluateCondition(price, dbW.operator, dbW.threshold);
        if (!conditionMet) {
          // Not hit yet — skip, check again next tick
          continue;
        }
        yesWins = true;
        console.log('Before-deadline wager', dbW.id, 'hit early! YES wins at', price);
      } else {
        // Standard wager — evaluate at deadline
        yesWins = evaluateCondition(price, dbW.operator, dbW.threshold);
        console.log('Resolving standard wager', dbW.id, 'for', dbW.assetSymbol);
      }

      // Use in-memory wager if present, otherwise build a local object
      const memWager = wagers.get(dbW.id);
      const wager = memWager || {
        id: dbW.id,
        text: dbW.text,
        assetSymbol: dbW.assetSymbol,
        assetId: dbW.assetId,
        operator: dbW.operator,
        threshold: dbW.threshold,
        yes: yesSet,
        no: noSet,
        participantNames,
        chatId,
        messageId: dbW.messageId,
        createdAt: dbW.createdAt,
        resolutionTime: dbW.resolutionTime,
        voteDeadline: dbW.voteDeadline,
        countdownIntervalId: null,
        resolved: false,
        finalPrice: null,
        outcomeYes: null,
        winners: [],
        losers: [],
      };

      // Sync core fields
      wager.yes = yesSet;
      wager.no = noSet;
      wager.participantNames = participantNames;
      wager.resolved = true;
      wager.finalPrice = price;
      wager.outcomeYes = yesWins;

      if (memWager && memWager !== wager) {
        memWager.yes = yesSet;
        memWager.no = noSet;
        memWager.participantNames = participantNames;
        memWager.resolved = true;
        memWager.finalPrice = price;
        memWager.outcomeYes = yesWins;
        if (memWager.countdownIntervalId) {
          clearInterval(memWager.countdownIntervalId);
          memWager.countdownIntervalId = null;
        }
      }

      // Build winners/losers lists
      const winnersSet = yesWins ? yesSet : noSet;
      const losersSet  = yesWins ? noSet  : yesSet;

      wager.winners = [...winnersSet].map((uid) => {
        const name = participantNames.get(uid) || `User ${uid}`;
        return `🏆 ${name}`;
      });
      wager.losers = [...losersSet].map((uid) => {
        const name = participantNames.get(uid) || `User ${uid}`;
        return `😞 ${name}`;
      });
      wager.winners.sort((a, b) => a.localeCompare(b));
      wager.losers.sort((a, b) => a.localeCompare(b));

      // ---- Leaderboard scoring ----
      const monthKey = getMonthKey(dbW.resolutionTime);
      const allTimeScores = getAllTimeScores(chatId);
      const monthlyScores = getMonthlyScores(chatId, monthKey);

      for (const uid of winnersSet) {
        const name = participantNames.get(uid) || `User ${uid}`;
        addPointsToScores(allTimeScores, uid, name, 10);
        addPointsToScores(monthlyScores, uid, name, 10);
        await updateLeaderboardRow({ chatId, userId: uid, name, scope: 'all', monthKey: null, winDelta: 1, lossDelta: 0 });
        await updateLeaderboardRow({ chatId, userId: uid, name, scope: 'month', monthKey, winDelta: 1, lossDelta: 0 });
      }

      for (const uid of losersSet) {
        const name = participantNames.get(uid) || `User ${uid}`;
        addPointsToScores(allTimeScores, uid, name, 0);
        addPointsToScores(monthlyScores, uid, name, 0);
        await updateLeaderboardRow({ chatId, userId: uid, name, scope: 'all', monthKey: null, winDelta: 0, lossDelta: 1 });
        await updateLeaderboardRow({ chatId, userId: uid, name, scope: 'month', monthKey, winDelta: 0, lossDelta: 1 });
      }

      const resultText = buildResolvedText(wager);

      // Persist resolution to Postgres
      try {
        await prisma.wager.update({
          where: { id: dbW.id },
          data: { resolved: true, finalPrice: price, outcomeYes: yesWins },
        });
      } catch (err) {
        console.error('Failed to persist wager resolution:', err.message || err);
      }

      // Edit original message or send new one
      let edited = false;
      if (dbW.messageId != null) {
        try {
          await bot.telegram.editMessageText(chatId, dbW.messageId, undefined, resultText, {
            reply_markup: { inline_keyboard: [] },
          });
          edited = true;
          console.log('Edited message for wager', dbW.id);
        } catch (editErr) {
          console.error('Failed to edit message for wager', dbW.id, editErr.description || editErr.message);
        }
      }
      if (!edited) {
        await bot.telegram.sendMessage(chatId, `Wager #${dbW.id} resolved.\n\n` + resultText);
        console.log('Sent resolution message for wager', dbW.id);
      }

      console.log('Resolved wager', dbW.id, 'YES wins?', yesWins);
    } catch (err) {
      console.error('Failed to resolve wager', dbW.id, err.message || err);
    }
  }
}


/* ----------------- Launch bot ----------------- */

// Rebuild in-memory active wagers from Postgres (last 24h unresolved)
await rebuildActiveWagersFromDb({ graceHours: 24 });

// Rebuild leaderboards from Postgres
await rebuildLeaderboardsFromDb();

// Startup Banner
console.log('Bot starting. PID:', process.pid, 'at', new Date().toISOString());

bot.launch();

// One-time catch-up on startup for any overdue wagers
console.log('Boot catch-up run at', new Date().toISOString());
await resolveDueWagers();

// Run resolver every 60 seconds
setInterval(resolveDueWagers, 60 * 1000);



process.once('SIGINT', async () => {
  await prisma.$disconnect();
  bot.stop('SIGINT');
});

process.once('SIGTERM', async () => {
  await prisma.$disconnect();
  bot.stop('SIGTERM');
});

