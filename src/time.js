'use strict';

const config = require('./config');

const WEEKDAYS = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

// «26.11.2026, 18:45» во времени агентства
function formatDateTime(date = new Date()) {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: config.agency.timezone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

// «четверг, 26 ноября 2026 г.»
function todayRu(date = new Date()) {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: config.agency.timezone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(date);
}

// Открыт ли офис прямо сейчас
function isOfficeOpen(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: config.agency.timezone,
      weekday: 'short',
      hour: 'numeric',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value])
  );
  const day = WEEKDAYS[parts.weekday];
  const hour = Number(parts.hour);
  const { openDays, openHour, closeHour } = config.agency;
  return openDays.includes(day) && hour >= openHour && hour < closeHour;
}

module.exports = { formatDateTime, todayRu, isOfficeOpen };
