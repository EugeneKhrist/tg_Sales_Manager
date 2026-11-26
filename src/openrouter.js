'use strict';
// Запросы к OpenRouter. Если модель перегружена или ответила мусором — пробуем следующую.

const config = require('./config');
const { log } = require('./util');

class LLMUnavailableError extends Error {}

// Достаём JSON из ответа модели (она может обернуть его в ```json или добавить лишний текст)
function extractJson(text) {
  const t = String(text)
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a === -1 || b <= a) return { plain: true, text: t };
  try {
    return { plain: false, data: JSON.parse(t.slice(a, b + 1)) };
  } catch {
    return null;
  }
}

async function callModel(model, system, messages) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.openrouterKey}`,
      'Content-Type': 'application/json',
      'X-Title': 'Travel agency Telegram bot',
    },
    body: JSON.stringify({
      model,
      temperature: config.llmTemperature,
      max_tokens: config.llmMaxTokens,
      messages: [{ role: 'system', content: system }, ...messages],
    }),
    signal: AbortSignal.timeout(config.llmTimeoutMs),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`HTTP ${res.status} ${body?.error?.message || ''}`.trim());
  let content = body?.choices?.[0]?.message?.content;
  if (Array.isArray(content)) content = content.map((p) => p?.text || '').join('');
  if (typeof content !== 'string' || !content.trim()) throw new Error('пустой ответ');
  return content;
}

/**
 * Возвращает { reply, fields, model }.
 * Бросает LLMUnavailableError, если не ответила ни одна модель.
 */
async function askModel({ system, messages }) {
  const errors = [];
  for (const model of config.models) {
    try {
      const text = await callModel(model, system, messages);
      const parsed = extractJson(text);
      if (!parsed) throw new Error('невалидный JSON');
      const d = parsed.plain ? { reply: parsed.text } : parsed.data;
      if (typeof d.reply !== 'string' || !d.reply.trim()) throw new Error('нет поля reply');
      return {
        reply: d.reply.trim(),
        fields: d.fields && typeof d.fields === 'object' ? d.fields : {},
        model,
      };
    } catch (e) {
      const reason = e.name === 'TimeoutError' ? 'таймаут' : e.message;
      errors.push(`${model}: ${reason}`);
      log(`модель ${model} не ответила (${reason}) — пробую запасную`);
    }
  }
  throw new LLMUnavailableError(errors.join('; '));
}

module.exports = { askModel, extractJson, LLMUnavailableError };
