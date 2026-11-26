'use strict';

const test = require('node:test');
const assert = require('node:assert');
const leads = require('../src/leads');
const { extractJson } = require('../src/openrouter');

test('normalizePhone приводит номера к +7XXXXXXXXXX', () => {
  assert.strictEqual(leads.normalizePhone('8 (706) 412-04-12'), '+77064120412');
  assert.strictEqual(leads.normalizePhone('+7 706 412 04 12'), '+77064120412');
  assert.strictEqual(leads.normalizePhone('7064120412'), '+77064120412');
  assert.strictEqual(leads.normalizePhone('12345'), null);
  assert.strictEqual(leads.normalizePhone('не скажу'), null);
});

test('mergeFields принимает корректные значения и отклоняет мусор', () => {
  const lead = {};
  const { changed, rejected } = leads.mergeFields(lead, {
    destination: 'Турция',
    nights: '7',
    adults: 2,
    children: 0,
    budget_kzt: '1 000 000',
    phone: '123',
    name: null,
  });
  assert.strictEqual(changed, true);
  assert.deepStrictEqual(rejected, ['phone']);
  assert.strictEqual(lead.nights, 7);
  assert.strictEqual(lead.budget_kzt, 1000000);
  assert.strictEqual(lead.children_ages, 'нет'); // детей нет — возраст заполняется автоматически
  assert.strictEqual(lead.phone, undefined);
});

test('телефон, которого клиент не писал, отклоняется (защита от выдумок модели)', () => {
  const lead = {};
  const r = leads.mergeFields(lead, { phone: '+7 701 111 22 33' }, { userTexts: ['Меня зовут Иван'] });
  assert.deepStrictEqual(r.rejected, ['phone']);
  const ok = leads.mergeFields(lead, { phone: '+7 701 111 22 33' }, { userTexts: ['мой номер 8 701 111 22 33'] });
  assert.deepStrictEqual(ok.rejected, []);
  assert.strictEqual(lead.phone, '+77011112233');
});

test('«null» и «не указано» от модели не считаются данными', () => {
  const lead = {};
  const r = leads.mergeFields(lead, { destination: 'null', dates: 'не указано', name: '' });
  assert.deepStrictEqual(lead, {});
  assert.deepStrictEqual(r.rejected, []);
});

test('missingFields: возраст детей нужен только если дети есть', () => {
  const full = {
    destination: 'Турция', departure_city: 'Астана', dates: 'июнь', nights: 7, adults: 2,
    children: 1, budget_kzt: 900000, preferences: 'всё включено', name: 'Иван', phone: '+77064120412',
  };
  assert.deepStrictEqual(leads.missingFields(full), ['children_ages']);
  leads.mergeFields(full, { children_ages: '5 лет' });
  assert.deepStrictEqual(leads.missingFields(full), []);
  const noKids = { ...full, children: 0 };
  assert.deepStrictEqual(leads.missingFields(noKids), []);
});

test('extractJson понимает обёртку ```json и обычный текст', () => {
  assert.deepStrictEqual(extractJson('```json\n{"reply":"Привет"}\n```').data, { reply: 'Привет' });
  assert.strictEqual(extractJson('Просто текст').plain, true);
  assert.strictEqual(extractJson('{ сломанный json }'), null);
});

test('summaryText и adminMessage содержат ключевые данные', () => {
  const f = {
    destination: 'Турция', departure_city: 'Астана', dates: 'июнь', nights: 7, adults: 2,
    children: 1, children_ages: '5 лет', budget_kzt: 900000, preferences: 'всё включено',
    name: 'Иван <b>', phone: '+77064120412',
  };
  assert.match(leads.summaryText(f), /Турция/);
  const msg = leads.adminMessage({
    id: 1, created_at: new Date().toISOString(), partial: false,
    client: { chat_id: 5, username: 'ivan', first_name: 'Иван' }, fields: f,
  });
  assert.match(msg, /@ivan/);
  assert.match(msg, /Иван &lt;b&gt;/); // HTML экранируется
  assert.match(msg, /\+7 706 412 04 12/);
});
