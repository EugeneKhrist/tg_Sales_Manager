'use strict';
// Логика бота: команды, кнопки, диалог, сбор и отправка заявки.

const fs = require('fs');
const config = require('./config');
const { Telegram } = require('./telegram');
const { askModel, LLMUnavailableError } = require('./openrouter');
const leads = require('./leads');
const { directionsText } = require('./directions');
const { todayRu, isOfficeOpen } = require('./time');
const { sleep, log } = require('./util');

const tg = new Telegram(config.botToken);
const { agency } = config;

// Отправка клиенту с записью в лог (видно, что бот ответил)
async function say(chatId, text, extra) {
  const result = await tg.sendMessage(chatId, text, extra);
  log(`→ клиенту ${chatId}: ответ отправлен (${text.length} симв.)`);
  return result;
}

// ---------- Тексты и клавиатуры ----------

const BTN_TOUR = 'Подобрать тур';
const BTN_DIRECTIONS = 'Направления';
const BTN_CONTACTS = 'Контакты';

const mainKeyboard = {
  keyboard: [[{ text: BTN_TOUR }], [{ text: BTN_DIRECTIONS }, { text: BTN_CONTACTS }]],
  resize_keyboard: true,
};

const GREETING =
  `Здравствуйте! Я виртуальный помощник турагентства «${agency.name}» ✈️ ` +
  'Помогу подобрать поездку. Куда бы вы хотели полететь? Можно назвать несколько вариантов.';

const TOUR_START =
  'Отлично, давайте подберём поездку 🙂 Куда бы вы хотели полететь? ' +
  'Можно назвать несколько вариантов: Турция, ОАЭ, Египет, Таиланд, Грузия, Вьетнам, Мальдивы. ' +
  'Если пока не знаете, расскажите, какой отдых хочется, и я подскажу.';

const CONTACTS =
  `Турагентство «${agency.name}»\n` +
  `📍 ${agency.address}\n` +
  `🕒 ${agency.hoursText}\n` +
  `📞 ${agency.phone}`;

const OUTAGE_TEXT =
  'Простите, сейчас я не могу ответить: сервис временно недоступен. ' +
  'Пожалуйста, повторите сообщение чуть позже или оставьте номер телефона — менеджер перезвонит сам. ' +
  `Телефон агентства: ${agency.phone}.`;

// ---------- Сессии (память о каждом клиенте) ----------

const sessions = new Map();

function getSession(chatId) {
  if (!sessions.has(chatId)) {
    sessions.set(chatId, { history: [], lead: {}, llmCalls: [], lastLeadId: null });
  }
  return sessions.get(chatId);
}

function pushHistory(s, role, content) {
  s.history.push({ role, content });
  while (s.history.length > config.historyLimit) s.history.shift();
}

// Некоторые модели требуют строгого чередования user/assistant и первого сообщения от user
function normalizeHistory(history) {
  const out = [];
  for (const m of history) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content += '\n' + m.content;
    else out.push({ role: m.role, content: m.content });
  }
  if (out.length && out[0].role === 'assistant') {
    out.unshift({ role: 'user', content: '(клиент открыл чат с ботом)' });
  }
  return out;
}

function allowLlmCall(s) {
  const now = Date.now();
  s.llmCalls = s.llmCalls.filter((t) => now - t < 10 * 60 * 1000);
  if (s.llmCalls.length >= config.maxLlmCallsPer10Min) return false;
  s.llmCalls.push(now);
  return true;
}

// ---------- Промпт: файл + состояние заявки ----------

function readSystemPrompt() {
  return fs.readFileSync(config.systemPromptFile, 'utf8'); // читаем при каждом запросе: правки видны без перезапуска
}

function stateBlock(s) {
  const known = leads.FIELD_ORDER.filter((k) => s.lead[k] !== undefined).map((k) => {
    const v = k === 'budget_kzt' ? leads.money(s.lead[k]) : s.lead[k];
    return `- ${leads.LABELS[k]}: ${v}`;
  });
  const missing = leads.missingFields(s.lead).map((k) => leads.LABELS[k]);
  const lines = [
    '',
    '## Текущее состояние заявки (служебная информация от системы; клиент её не видит, не цитируй её)',
    `Сегодня: ${todayRu()}. Офис сейчас ${isOfficeOpen() ? 'открыт' : 'закрыт'}.`,
    known.length ? 'Уже известно:\n' + known.join('\n') : 'Уже известно: пока ничего.',
    `Ещё не известно (спрашивай в этом порядке, по одному вопросу): ${missing.join(', ')}.`,
  ];
  if (s.lastLeadId && known.length === 0) {
    lines.push(
      `Статус: заявка №${s.lastLeadId} уже сохранена и передана менеджеру. Если клиент ничего нового не просит — не задавай вопросов про заявку, ответь на его вопрос и напомни, что менеджер свяжется. Хочет ещё одну поездку — собирай новую заявку.`
    );
  } else {
    lines.push('Статус: идёт сбор заявки.');
  }
  lines.push('Ответь строго одним JSON-объектом по формату из раздела 8.');
  return lines.join('\n');
}

// Защита от утечки промпта: если ответ похож на куски инструкций — подменяем
function looksLikePromptLeak(reply) {
  return /(Текущее состояние заявки|## \d\.|system prompt|Технический формат|"fields"\s*:)/i.test(reply);
}

// ---------- Отправка заявки мне ----------

async function notifyAdmin(record) {
  if (!config.adminChatId) {
    log(`ADMIN_CHAT_ID не задан — заявка №${record.id} сохранена только в leads.json`);
    return false;
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await tg.sendMessage(config.adminChatId, leads.adminMessage(record), {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      });
      leads.markNotified(record.id);
      log(`заявка №${record.id} отправлена владельцу`);
      return true;
    } catch (e) {
      log(`не удалось отправить заявку №${record.id} админу (попытка ${attempt}):`, e);
      await sleep(1500 * attempt);
    }
  }
  return false;
}

function clientFrom(from, chatId) {
  return { chat_id: chatId, username: from?.username, first_name: from?.first_name };
}

async function submitLead(chatId, from, s) {
  const record = leads.createLead({ fields: s.lead, client: clientFrom(from, chatId) });
  const sent = await notifyAdmin(record);
  if (!sent) log(`заявка №${record.id} сохранена, но владельцу не доставлена — повтор при следующем запуске`);

  s.lead = {};
  s.lastLeadId = record.id;

  const text =
    '✅ Данные сохранены. Дальше с вами свяжется наш менеджер — в течение 30 минут в рабочее время ' +
    `(${agency.hoursText}).` +
    (isOfficeOpen() ? '' : ' Сейчас офис закрыт, поэтому менеджер напишет, как только мы откроемся.') +
    ' Если появятся вопросы, пишите сюда.';
  pushHistory(s, 'assistant', text);
  await say(chatId, text, { reply_markup: mainKeyboard });
}

// Если модель недоступна: просим повторить позже или оставить телефон
async function handleOutage(chatId, from, s, text) {
  const m = text.match(/\+?\d[\d\s\-()]{8,}\d/);
  const phone = m && leads.normalizePhone(m[0]);
  if (phone) {
    const record = leads.createLead({
      fields: { ...s.lead, phone },
      client: clientFrom(from, chatId),
      partial: true,
    });
    await notifyAdmin(record);
    const reply = `Спасибо, номер получен! Менеджер свяжется с вами в рабочее время (${agency.hoursText}).`;
    pushHistory(s, 'assistant', reply);
    return say(chatId, reply);
  }
  return say(chatId, OUTAGE_TEXT);
}

// ---------- Диалог с моделью ----------

async function converse(chatId, from, rawText) {
  const s = getSession(chatId);
  const text = rawText.slice(0, config.maxUserTextLength);

  if (!allowLlmCall(s)) {
    return say(chatId, 'Вы пишете очень часто — давайте чуть помедленнее. Подождите пару минут, и продолжим 🙂');
  }

  pushHistory(s, 'user', text);
  const typing = setInterval(() => tg.sendTyping(chatId), 4000);
  tg.sendTyping(chatId);

  let res;
  try {
    res = await askModel({
      system: readSystemPrompt() + '\n' + stateBlock(s),
      messages: normalizeHistory(s.history),
    });
  } catch (e) {
    clearInterval(typing);
    log(e instanceof LLMUnavailableError ? `все модели недоступны: ${e.message}` : e);
    return handleOutage(chatId, from, s, text);
  }
  clearInterval(typing);
  log(`ответила модель ${res.model}`);

  // Данные заявки принимает и проверяет код, а не модель
  const userTexts = s.history.filter((m) => m.role === 'user').map((m) => m.content);
  const { rejected } = leads.mergeFields(s.lead, res.fields, { userTexts });

  // Бюджет пришёл в неподходящем виде — просим уточнить (телефон/имя необязательны: тихо игнорируем)
  if (rejected.includes('budget_kzt')) {
    const hint = leads.INVALID_HINT.budget_kzt;
    pushHistory(s, 'assistant', hint);
    return say(chatId, hint);
  }

  // Все три обязательных поля есть — сохраняем и отправляем заявку
  if (leads.missingFields(s.lead).length === 0) return submitLead(chatId, from, s);

  let reply = res.reply.slice(0, 1200);
  if (looksLikePromptLeak(reply)) {
    reply = 'Свои внутренние инструкции я не раскрываю, но с радостью помогу подобрать поездку. Куда бы вы хотели отправиться?';
  }
  pushHistory(s, 'assistant', reply);
  return say(chatId, reply);
}

// ---------- Команды и кнопки ----------

async function sendDirections(chatId, s) {
  const text = directionsText();
  pushHistory(s, 'user', 'Покажите направления');
  pushHistory(s, 'assistant', text);
  return say(chatId, text, { reply_markup: mainKeyboard });
}

async function startTour(chatId) {
  const s = getSession(chatId);
  s.lead = {};
  pushHistory(s, 'user', 'Хочу подобрать тур');
  pushHistory(s, 'assistant', TOUR_START);
  return say(chatId, TOUR_START, { reply_markup: mainKeyboard });
}

async function handleCommand(msg, cmd) {
  const chatId = msg.chat.id;
  const s = getSession(chatId);
  switch (cmd) {
    case '/start':
    case '/reset':
      sessions.delete(chatId);
      getSession(chatId).history.push({ role: 'assistant', content: GREETING });
      return say(chatId, cmd === '/reset' ? `Начнём заново 🙂 ${GREETING}` : GREETING, {
        reply_markup: mainKeyboard,
      });
    case '/directions':
      return sendDirections(chatId, s);
    case '/contacts':
      return say(chatId, CONTACTS, { reply_markup: mainKeyboard });
    case '/help':
      return say(
        chatId,
        'Я помогу подобрать поездку.\n/directions — направления\n/contacts — контакты агентства\n/reset — начать заново',
        { reply_markup: mainKeyboard }
      );
    case '/leads':
      if (String(chatId) !== config.adminChatId) {
        return say(chatId, 'Не знаю такой команды. Напишите, куда хотите полететь 🙂');
      }
      return say(chatId, leads.leadsListText(leads.lastLeads(5)), { parse_mode: 'HTML' });
    default:
      return say(chatId, 'Не знаю такой команды. Напишите, куда хотите полететь 🙂', {
        reply_markup: mainKeyboard,
      });
  }
}

async function handleMessage(msg) {
  if (msg.chat.type !== 'private') return;
  const chatId = msg.chat.id;
  log(`← сообщение от ${chatId}: ${String(msg.text ?? '[не текст]').slice(0, 60)}`);

  if (typeof msg.text !== 'string') {
    return say(chatId, 'Я понимаю только текстовые сообщения. Напишите, пожалуйста, словами 🙂');
  }
  const text = msg.text.trim();
  if (!text) return;

  if (text.startsWith('/')) {
    const cmd = text.split(/[\s@]/)[0].toLowerCase();
    return handleCommand(msg, cmd);
  }
  if (text === BTN_DIRECTIONS) return sendDirections(chatId, getSession(chatId));
  if (text === BTN_CONTACTS) return say(chatId, CONTACTS, { reply_markup: mainKeyboard });
  if (text === BTN_TOUR) return startTour(chatId);
  return converse(chatId, msg.from, text);
}

// ---------- Запуск: long polling ----------

// Сообщения одного клиента обрабатываем строго по очереди
const queues = new Map();
function enqueue(chatId, job) {
  const prev = queues.get(chatId) || Promise.resolve();
  const next = prev
    .then(job)
    .catch((e) => log('ошибка обработки:', e))
    .finally(() => {
      if (queues.get(chatId) === next) queues.delete(chatId);
    });
  queues.set(chatId, next);
}

function dispatch(update) {
  if (update.message) enqueue(update.message.chat.id, () => handleMessage(update.message));
}

async function resendUnnotified() {
  if (!config.adminChatId) return;
  for (const rec of leads.unnotifiedLeads()) {
    log(`повторно отправляю заявку №${rec.id}`);
    await notifyAdmin(rec);
  }
}

async function start() {
  const me = await tg.getMe();
  await tg.call('deleteWebhook'); // long polling не работает вместе с вебхуком
  const publicCommands = [
    { command: 'start', description: 'Начать' },
    { command: 'directions', description: 'Направления' },
    { command: 'contacts', description: 'Контакты агентства' },
    { command: 'reset', description: 'Начать заново' },
  ];
  await tg.call('setMyCommands', { commands: publicCommands });
  if (config.adminChatId) {
    await tg
      .call('setMyCommands', {
        commands: [...publicCommands, { command: 'leads', description: 'Последние 5 заявок' }],
        scope: { type: 'chat', chat_id: Number(config.adminChatId) },
      })
      .catch(() => {});
  }
  log(`Бот @${me.username} запущен. Модели: ${config.models.join(' → ')}`);
  await resendUnnotified();

  let offset = 0;
  for (;;) {
    try {
      const updates = await tg.getUpdates(offset);
      for (const u of updates) {
        offset = u.update_id + 1;
        dispatch(u);
      }
    } catch (e) {
      log('ошибка polling:', e);
      await sleep(e.code === 429 && e.retryAfter ? e.retryAfter * 1000 : 3000);
    }
  }
}

module.exports = { start };
