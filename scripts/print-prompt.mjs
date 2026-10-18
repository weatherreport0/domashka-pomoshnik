// Печатает системный промпт для выбранного класса в виде markdown-документа.
//   node scripts/print-prompt.mjs 4 > docs/system-prompt-4-klass.md
import { systemPrompt } from '../api/_prompt.js';

const grade = Number(process.argv[2]) || 4;
process.stdout.write(`# Системный промпт: пример для ${grade} класса

Это точный текст, который модель получает первым сообщением (role: system), когда в шапке выбран **${grade} класс**.
Он собирается функцией \`systemPrompt(grade)\` в [\`api/_prompt.js\`](../api/_prompt.js): общая часть одинакова для всех классов,
а строки про программу и про возраст ребёнка подставляются из таблиц \`GRADE_NOTES\` и \`EXPLAIN_NOTES\`.

Пересобрать файл: \`node scripts/print-prompt.mjs ${grade} > docs/system-prompt-${grade}-klass.md\`.

~~~markdown
${systemPrompt(grade)}
~~~
`);
