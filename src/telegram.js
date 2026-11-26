'use strict';
// Минимальный клиент Telegram Bot API (без сторонних библиотек).

const { sleep } = require('./util');

class Telegram {
  constructor(token) {
    this.base = `https://api.telegram.org/bot${token}/`;
  }

  async call(method, params = {}, timeoutMs = 15000) {
    const res = await fetch(this.base + method, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = await res.json().catch(() => null);
    if (!json) throw new Error(`Telegram ${method}: HTTP ${res.status}`);
    if (!json.ok) {
      const err = new Error(`Telegram ${method}: ${json.error_code} ${json.description}`);
      err.code = json.error_code;
      err.retryAfter = json.parameters?.retry_after;
      throw err;
    }
    return json.result;
  }

  getMe() {
    return this.call('getMe');
  }

  getUpdates(offset) {
    return this.call(
      'getUpdates',
      { offset, timeout: 30, allowed_updates: ['message', 'callback_query'] },
      45000
    );
  }

  // Отправка с разбиением длинных текстов; клавиатура — только у последней части
  async sendMessage(chatId, text, extra = {}) {
    const chunks = [];
    for (let i = 0; i < text.length; i += 4000) chunks.push(text.slice(i, i + 4000));
    let result;
    for (let i = 0; i < chunks.length; i++) {
      const params = { chat_id: chatId, text: chunks[i], ...extra };
      if (i < chunks.length - 1) delete params.reply_markup;
      try {
        result = await this.call('sendMessage', params);
      } catch (e) {
        if (e.code === 429 && e.retryAfter) {
          await sleep((e.retryAfter + 1) * 1000);
          result = await this.call('sendMessage', params);
        } else {
          throw e;
        }
      }
    }
    return result;
  }

  sendTyping(chatId) {
    return this.call('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
  }

  answerCallback(id, text) {
    return this.call('answerCallbackQuery', { callback_query_id: id, text }).catch(() => {});
  }

  removeKeyboard(chatId, messageId) {
    return this.call('editMessageReplyMarkup', {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [] },
    }).catch(() => {});
  }
}

module.exports = { Telegram };
