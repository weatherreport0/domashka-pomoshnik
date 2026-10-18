// Спрашивает адрес API, API-ключ и пароль сайта (ключ и пароль — скрытым вводом) и обновляет функцию в Yandex Cloud.
// Пустой ответ — оставить текущее значение.
//   node scripts/set-secrets-yandex.mjs
// Значения не печатаются и никуда не сохраняются на этом компьютере.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function askHidden(question, hidden = true) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let muted = false;
    rl._writeToOutput = (s) => { if (!muted) process.stdout.write(s); };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer.trim());
    });
    muted = hidden;
  });
}

const baseUrl = await askHidden('Адрес OpenAI-совместимого API (например https://api.openai.com/v1), Enter — не менять: ', false);
const key = await askHidden('Вставьте API-ключ (символы не отображаются), Enter — не менять: ');
const password = await askHidden('Введите пароль для входа на сайт, Enter — не менять: ');
const values = { OPENAI_BASE_URL: baseUrl, OPENAI_API_KEY: key, SITE_PASSWORD: password };
if (Object.values(values).some((v) => v.includes(','))) {
  console.log('Значения не должны содержать запятых — ничего не изменено.');
  process.exit(1);
}
const env = { ...process.env };
for (const [name, value] of Object.entries(values)) if (value) env[name] = value;

console.log('\nОбновляю функцию в Yandex Cloud…');
execFileSync(process.execPath, [path.join(root, 'scripts', 'deploy-yandex.mjs')], { stdio: 'inherit', env });
