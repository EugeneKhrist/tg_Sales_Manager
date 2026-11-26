'use strict';

const config = require('./src/config');
const { log } = require('./src/util');

const missing = [
  ['BOT_TOKEN', config.botToken],
  ['OPENROUTER_API_KEY', config.openrouterKey],
].filter(([, value]) => !value);

if (missing.length) {
  console.error(`В .env не заполнено: ${missing.map(([name]) => name).join(', ')}. См. .env.example`);
  process.exit(1);
}
if (!config.adminChatId) {
  log('ВНИМАНИЕ: ADMIN_CHAT_ID не задан — заявки будут сохраняться в leads.json, но не придут вам в Telegram.');
}

process.on('unhandledRejection', (e) => log('unhandledRejection:', e));
process.on('SIGINT', () => {
  log('Остановка бота');
  process.exit(0);
});

require('./src/bot')
  .start()
  .catch((e) => {
    log('Не удалось запустить бота:', e);
    process.exit(1);
  });
