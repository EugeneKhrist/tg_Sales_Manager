'use strict';

const config = require('./config');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Лог без секретов: любые токены/ключи из конфига вырезаются из текста.
function redact(text) {
  let s = String(text);
  for (const secret of [config.botToken, config.openrouterKey]) {
    if (secret) s = s.split(secret).join('***');
  }
  return s;
}

function log(...args) {
  const time = new Date().toISOString();
  console.log(`[${time}]`, ...args.map((a) => redact(a instanceof Error ? a.message : a)));
}

module.exports = { sleep, escapeHtml, redact, log };
