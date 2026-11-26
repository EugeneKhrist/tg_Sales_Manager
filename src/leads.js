'use strict';
// Заявка: поля, проверка в коде, текст сводки, хранение в leads.json.
// Модель только «достаёт» данные из диалога — а решает, всё ли заполнено, этот код.

const fs = require('fs');
const config = require('./config');
const { formatDateTime } = require('./time');
const { escapeHtml, log } = require('./util');

// Порядок = порядок вопросов клиенту
const FIELD_ORDER = [
  'destination',
  'departure_city',
  'dates',
  'nights',
  'adults',
  'children',
  'children_ages',
  'budget_kzt',
  'preferences',
  'name',
  'phone',
];

const LABELS = {
  destination: 'Направление',
  departure_city: 'Город вылета',
  dates: 'Даты / месяц',
  nights: 'Ночей',
  adults: 'Взрослых',
  children: 'Детей',
  children_ages: 'Возраст детей',
  budget_kzt: 'Бюджет на всех',
  preferences: 'Пожелания',
  name: 'Имя',
  phone: 'Телефон',
};

// Что отвечаем клиенту, если модель вернула неподходящее значение
const INVALID_HINT = {
  nights: 'Подскажите, пожалуйста, количество ночей числом — например, 7 или 10.',
  adults: 'Уточните, пожалуйста, сколько взрослых поедет — числом, например 2.',
  children: 'Уточните, пожалуйста, сколько детей поедет — числом (если детей нет, напишите 0).',
  budget_kzt:
    'Подскажите, пожалуйста, общий бюджет на всех в тенге — числом, например 900 000.',
  name: 'Подскажите, пожалуйста, как к вам обращаться — имя буквами.',
  phone:
    'Похоже, номер указан неполностью. Напишите, пожалуйста, телефон для связи, например +7 701 123 45 67.',
};

const EMPTY_WORDS = new Set([
  '', 'null', 'none', 'undefined', 'n/a', 'na', '-', '—', 'unknown',
  'нет данных', 'не указано', 'не указан', 'не указана', 'неизвестно', 'не известно',
]);

const isEmptyWord = (raw) =>
  typeof raw === 'string' && EMPTY_WORDS.has(raw.trim().toLowerCase());

function cleanStr(v, max = 200) {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s || EMPTY_WORDS.has(s.toLowerCase())) return null;
  return s.slice(0, max);
}

function toNum(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const s = v.replace(/[\s ]/g, '').replace(',', '.');
    if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  }
  return NaN;
}

function intInRange(v, min, max) {
  const n = toNum(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

// +7XXXXXXXXXX или null
function normalizePhone(v) {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const raw = String(v).trim();
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 11 && (digits[0] === '7' || digits[0] === '8')) return '+7' + digits.slice(1);
  if (digits.length === 10) return '+7' + digits;
  if (raw.startsWith('+') && digits.length >= 11 && digits.length <= 15) return '+' + digits;
  return null;
}

function formatPhone(p) {
  const m = /^\+7(\d{3})(\d{3})(\d{2})(\d{2})$/.exec(p || '');
  return m ? `+7 ${m[1]} ${m[2]} ${m[3]} ${m[4]}` : p || '—';
}

const NORMALIZERS = {
  destination: (v) => cleanStr(v, 60),
  departure_city: (v) => cleanStr(v, 60),
  dates: (v) => cleanStr(v, 60),
  nights: (v) => intInRange(v, 1, 60),
  adults: (v) => intInRange(v, 1, 20),
  children: (v) => intInRange(v, 0, 10),
  children_ages: (v) => cleanStr(v, 80),
  budget_kzt: (v) => {
    const n = toNum(v);
    return Number.isFinite(n) && n >= 10000 && n <= 1e9 ? Math.round(n) : null;
  },
  preferences: (v) => cleanStr(v, 300),
  name: (v) => {
    const s = cleanStr(v, 60);
    return s && /\p{L}{2,}/u.test(s) ? s : null;
  },
  phone: normalizePhone,
};

// Защита от «выдуманного» телефона: цифры номера должны встречаться в сообщениях клиента.
function phoneInTexts(phone, texts) {
  const last10 = phone.replace(/\D/g, '').slice(-10);
  return texts.some((t) => String(t).replace(/\D/g, '').includes(last10));
}

/**
 * Добавляет в заявку новые значения от модели (только проверенные).
 * Возвращает { changed, rejected } — менялись ли данные и какие поля не прошли проверку.
 */
function mergeFields(lead, incoming, { userTexts } = {}) {
  const rejected = [];
  let changed = false;
  if (!incoming || typeof incoming !== 'object') return { changed, rejected };

  for (const key of FIELD_ORDER) {
    const raw = incoming[key];
    if (raw === null || raw === undefined) continue;
    const value = NORMALIZERS[key](raw);
    if (value === null) {
      if (!isEmptyWord(raw)) rejected.push(key);
      continue;
    }
    if (key === 'phone' && userTexts && !phoneInTexts(value, userTexts)) {
      rejected.push(key);
      continue;
    }
    if (lead[key] !== value) {
      lead[key] = value;
      changed = true;
    }
  }

  // Согласованность «дети ↔ возраст детей»
  if (lead.children === 0) lead.children_ages = 'нет';
  else if (lead.children > 0 && lead.children_ages === 'нет') delete lead.children_ages;

  return { changed, rejected };
}

// Какие обязательные поля ещё не заполнены (в порядке вопросов)
function missingFields(lead) {
  return FIELD_ORDER.filter((key) => {
    if (key === 'children_ages' && !(lead.children > 0)) return false;
    return lead[key] === undefined || lead[key] === null;
  });
}

const money = (n) => `${Number(n).toLocaleString('ru-RU')} ₸`;

function groupText(f) {
  const kids = f.children > 0 ? `${f.children} реб. (${f.children_ages})` : 'без детей';
  return `${f.adults ?? '—'} взр., ${kids}`;
}

// Сводка для клиента (обычный текст)
function summaryText(f) {
  return [
    'Давайте сверим заявку:',
    `🌍 Направление: ${f.destination}`,
    `🛫 Вылет из: ${f.departure_city}`,
    `📅 Даты: ${f.dates}, ночей: ${f.nights}`,
    `👨‍👩‍👧 Состав: ${groupText(f)}`,
    `💰 Бюджет на всех: ${money(f.budget_kzt)}`,
    `🎯 Пожелания: ${f.preferences}`,
    `👤 Имя: ${f.name}`,
    `📞 Телефон: ${formatPhone(f.phone)}`,
    '',
    'Всё верно? Если да — отправляю заявку менеджеру.',
  ].join('\n');
}

// ---------- Хранение (leads.json) ----------

function readLeads() {
  try {
    const data = JSON.parse(fs.readFileSync(config.leadsFile, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch (e) {
    if (e.code !== 'ENOENT') {
      log('leads.json повреждён, сохраняю копию и начинаю новый файл:', e.message);
      try {
        fs.renameSync(config.leadsFile, `${config.leadsFile}.corrupt-${Date.now()}`);
      } catch {
        /* ignore */
      }
    }
    return [];
  }
}

function writeLeads(list) {
  const tmp = `${config.leadsFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
  fs.renameSync(tmp, config.leadsFile); // атомарно: файл не останется «наполовину записанным»
}

function createLead({ fields, client, partial = false }) {
  const list = readLeads();
  const record = {
    id: list.reduce((max, l) => Math.max(max, l.id || 0), 0) + 1,
    created_at: new Date().toISOString(),
    partial,
    notified: false,
    client: {
      chat_id: client.chat_id,
      username: client.username || null,
      first_name: client.first_name || null,
    },
    fields: { ...fields },
  };
  list.push(record);
  writeLeads(list);
  return record;
}

function markNotified(id) {
  const list = readLeads();
  const rec = list.find((l) => l.id === id);
  if (rec) {
    rec.notified = true;
    writeLeads(list);
  }
}

const unnotifiedLeads = () => readLeads().filter((l) => !l.notified);
const lastLeads = (n) => readLeads().slice(-n).reverse();

// ---------- Сообщения мне (админу), HTML ----------

function clientLine(c) {
  const who = c.username ? `@${escapeHtml(c.username)}` : 'без username';
  const name = c.first_name ? `${escapeHtml(c.first_name)} · ` : '';
  return `${name}${who} · <a href="tg://user?id=${c.chat_id}">открыть чат</a>`;
}

function adminMessage(rec) {
  const f = rec.fields;
  const title = rec.partial
    ? `⚠️ <b>Частичная заявка №${rec.id}</b> (бот не смог дособрать данные — перезвоните клиенту)`
    : `🆕 <b>Новая заявка №${rec.id}</b>`;
  const e = (v) => (v === undefined || v === null || v === '' ? '—' : escapeHtml(v));
  return [
    title,
    `🕒 ${formatDateTime(new Date(rec.created_at))}`,
    '',
    `🌍 Направление: ${e(f.destination)}`,
    `🛫 Вылет из: ${e(f.departure_city)}`,
    `📅 Даты: ${e(f.dates)} · ночей: ${e(f.nights)}`,
    `👨‍👩‍👧 Состав: ${escapeHtml(groupText(f))}`,
    `💰 Бюджет на всех: ${f.budget_kzt ? escapeHtml(money(f.budget_kzt)) : '—'}`,
    `🎯 Пожелания: ${e(f.preferences)}`,
    `👤 Имя: ${e(f.name)}`,
    `📞 Телефон: ${escapeHtml(formatPhone(f.phone))}`,
    '',
    `✉️ Telegram клиента: ${clientLine(rec.client)}`,
  ].join('\n');
}

// Короткий список для команды /leads
function leadsListText(list) {
  if (!list.length) return 'Заявок пока нет.';
  const blocks = list.map((rec) => {
    const f = rec.fields;
    const user = rec.client.username ? `@${escapeHtml(rec.client.username)}` : 'без username';
    const flag = rec.partial ? ' ⚠️ частичная' : '';
    return [
      `<b>№${rec.id}</b> · ${formatDateTime(new Date(rec.created_at))}${flag}`,
      `${escapeHtml(f.name || '—')} · ${escapeHtml(formatPhone(f.phone))} · ${user}`,
      `${escapeHtml(f.destination || '—')} из ${escapeHtml(f.departure_city || '—')}, ${escapeHtml(f.dates || '—')}, ${escapeHtml(f.nights || '—')} н.`,
      `${escapeHtml(groupText(f))} · ${f.budget_kzt ? escapeHtml(money(f.budget_kzt)) : '—'}`,
    ].join('\n');
  });
  return `<b>Последние заявки (${list.length})</b>\n\n` + blocks.join('\n\n');
}

module.exports = {
  FIELD_ORDER,
  LABELS,
  INVALID_HINT,
  normalizePhone,
  formatPhone,
  mergeFields,
  missingFields,
  summaryText,
  createLead,
  markNotified,
  unnotifiedLeads,
  lastLeads,
  adminMessage,
  leadsListText,
  money,
};
