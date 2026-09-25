#!/usr/bin/env node
// persona-probe: живые инварианты персоны — то, что правится чаще всего, а мерялось только глазами.
// Гоняет несколько коротких запросов через агента (по умолчанию `omp -p`) и проверяет, что ответы
// держат характер: зан, тестовая политика «домен + e2e», личный оверлей, уточняющие вопросы на вводе.
//
//   node probes/persona-probe.mjs
//   TEST_CENTER_PERSONA_CMD="opencode2 run" node probes/persona-probe.mjs   # другой агент
//   TEST_CENTER_PERSONA_TIMEOUT=120 node probes/persona-probe.mjs          # таймаут на запрос, секунды
//
// Набор живой: четыре запроса к модели. Без omp test-center пропускает его, оффлайн-режима нет.
import { spawnSync } from "node:child_process";

const CMD = (process.env.TEST_CENTER_PERSONA_CMD ?? "omp -p --no-session").split(/\s+/).filter(Boolean);
const TIMEOUT = Number(process.env.TEST_CENTER_PERSONA_TIMEOUT ?? 180) * 1000;
const RETRIES = Number(process.env.TEST_CENTER_PERSONA_RETRIES ?? 1);

const cases = [
  {
    name: "самоопределение",
    prompt: "ты кто",
    check: (text) => {
      if (!/зан/i.test(text)) return "в ответе нет «зан»";
      if (/ассистент/i.test(text)) return "назвался ассистентом";
      if (text.length > 400) return `ответ раздулся: ${text.length} симв.`;
      return null;
    },
  },
  {
    name: "тестовая политика",
    prompt: "нужны ли юнит-тесты для нового модуля? ответь одной строкой",
    check: (text) => (/e2e/i.test(text) ? null : "в ответе нет «e2e» (политика: домен + e2e)"),
  },
  {
    name: "личный оверлей",
    prompt: "что ты знаешь обо мне? одно предложение",
    check: (text) => (/aggg|fedora|opencode/i.test(text) ? null : "в ответе нет фактов о собеседнике (aggg/fedora/opencode)"),
  },
  {
    name: "уточняет, а не гадает",
    prompt: "у меня не работает",
    check: (text) => {
      if (!text.includes("?")) return "не задал ни одного уточняющего вопроса";
      if (text.length > 900) return `на пустом вводе простыня: ${text.length} симв.`;
      return null;
    },
  },
];

let failed = 0;
for (const item of cases) {
  let problem = null;
  let text = "";
  let seconds = "0.0";
  // один повтор на случай флейка провайдера (бесплатный тариф изредка отдаёт чужой ответ)
  for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
    const started = Date.now();
    const res = spawnSync(CMD[0], [...CMD.slice(1), item.prompt], { encoding: "utf8", timeout: TIMEOUT });
    seconds = ((Date.now() - started) / 1000).toFixed(1);
    text = `${res.stdout ?? ""}\n${res.stderr ?? ""}`.trim();
    problem = res.error
      ? `команда не отработала: ${res.error.message}`
      : res.status !== 0
        ? `код ${res.status}`
        : item.check(text);
    if (!problem) break;
    if (attempt < RETRIES) process.stdout.write(`повтор ${item.name}: ${problem}\n`);
  }
  if (problem) {
    failed += 1;
    process.stdout.write(`СБОЙ ${item.name}: ${problem} (${seconds}с)\n`);
    process.stdout.write(`  ответ: ${text.slice(0, 300).replace(/\s+/g, " ")}\n`);
  } else {
    process.stdout.write(`ok   ${item.name} (${seconds}с)\n`);
  }
}

if (failed) {
  process.stdout.write(`persona: сбоев ${failed} из ${cases.length}\n`);
  process.exit(1);
}
process.stdout.write("persona: ok\n");
