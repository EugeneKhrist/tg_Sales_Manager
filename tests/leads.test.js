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
    destination: 'Турция, Египет',
    month: 'июль',
    budget_kzt: '1 000 000',
    phone: '123',
    name: null,
  });
  assert.strictEqual(changed, true);
  assert.deepStrictEqual(rejected, ['phone']);
  assert.strictEqual(lead.budget_kzt, 1000000);
  assert.strictEqual(lead.phone, undefined);
});

test('несколько направлений списком превращаются в строку', () => {
  const lead = {};
  leads.mergeFields(lead, { destination: ['Турция', 'ОАЭ', 'Египет'] });
  assert.strictEqual(lead.destination, 'Турция, ОАЭ, Египет');
});

test('бюджет не числом отклоняется и не попадает в заявку', () => {
  const lead = {};
  const r = leads.mergeFields(lead, { budget_kzt: 'побольше' });
  assert.deepStrictEqual(r.rejected, ['budget_kzt']);
  assert.strictEqual(lead.budget_kzt, undefined);
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
  const r = leads.mergeFields(lead, { destination: 'null', month: 'не указано', name: '' });
  assert.deepStrictEqual(lead, {});
  assert.deepStrictEqual(r.rejected, []);
});

test('missingFields: нужны только направление, месяц и бюджет', () => {
  const lead = {};
  assert.deepStrictEqual(leads.missingFields(lead), ['destination', 'month', 'budget_kzt']);
  leads.mergeFields(lead, { destination: 'Турция', month: 'июль' });
  assert.deepStrictEqual(leads.missingFields(lead), ['budget_kzt']);
  leads.mergeFields(lead, { budget_kzt: 900000 });
  assert.deepStrictEqual(leads.missingFields(lead), []); // имя и телефон не обязательны
});

test('notes накапливаются, а не затираются', () => {
  const lead = {};
  leads.mergeFields(lead, { notes: 'двое взрослых и ребёнок 6 лет' });
  leads.mergeFields(lead, { notes: 'отель 5 звёзд' });
  assert.match(lead.notes, /ребёнок 6 лет/);
  assert.match(lead.notes, /5 звёзд/);
});

test('extractJson понимает обёртку ```json и обычный текст', () => {
  assert.deepStrictEqual(extractJson('```json\n{"reply":"Привет"}\n```').data, { reply: 'Привет' });
  assert.strictEqual(extractJson('Просто текст').plain, true);
  assert.strictEqual(extractJson('{ сломанный json }'), null);
});

test('adminMessage содержит ключевые данные и экранирует HTML', () => {
  const msg = leads.adminMessage({
    id: 1,
    created_at: new Date().toISOString(),
    partial: false,
    client: { chat_id: 5, username: 'ivan', first_name: 'Иван <b>' },
    fields: { destination: 'Турция, Египет', month: 'июль', budget_kzt: 900000 },
  });
  assert.match(msg, /Турция, Египет/);
  assert.match(msg, /июль/);
  assert.match(msg, /900.000 ₸/);
  assert.match(msg, /@ivan/);
  assert.match(msg, /Иван &lt;b&gt;/);
});
