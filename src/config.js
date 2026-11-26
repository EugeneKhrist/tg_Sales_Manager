'use strict';
// Настройки проекта. Ключи берутся ТОЛЬКО из .env (или из переменных окружения).

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// Мини-загрузчик .env (без внешних библиотек). Уже заданные переменные не перезаписывает.
function loadEnvFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let value = m[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

loadEnvFile(path.join(ROOT, '.env'));

// Основная модель + запасные: если основная перегружена, бот идёт по списку дальше.
const DEFAULT_MODELS = [
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'nvidia/nemotron-3.5-super-vl:free',
  'google/gemma-4-31b-it:free',
];

const config = {
  root: ROOT,
  botToken: (process.env.BOT_TOKEN || '').trim(),
  openrouterKey: (process.env.OPENROUTER_API_KEY || '').trim(),
  adminChatId: (process.env.ADMIN_CHAT_ID || '').trim(),

  models: process.env.MODELS
    ? process.env.MODELS.split(',').map((s) => s.trim()).filter(Boolean)
    : DEFAULT_MODELS,
  llmTimeoutMs: 45000,
  llmMaxTokens: 800,
  llmTemperature: 0.4,

  historyLimit: 15, // сколько последних сообщений помнит бот
  maxUserTextLength: 1000,
  maxLlmCallsPer10Min: 25, // защита бесплатного лимита OpenRouter от спама

  systemPromptFile: path.join(ROOT, 'system_prompt.md'),
  leadsFile: path.join(ROOT, 'leads.json'),

  agency: {
    name: 'Поехали с нами',
    city: 'Экибастуз',
    address: 'г. Экибастуз, ул. Ауэзова, 18, офис 4',
    phone: '+7 706 412 04 12',
    hoursText: 'Пн–Сб 10:00–19:00, воскресенье — выходной',
    timezone: 'Asia/Almaty',
    openDays: [1, 2, 3, 4, 5, 6], // 1 = понедельник ... 7 = воскресенье
    openHour: 10,
    closeHour: 19,
  },
};

module.exports = config;
