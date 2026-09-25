# Что проверяет Cloudflare-интерстишл (разбор на `nopecha.com/demo/cloudflare`)

> Разбор механики, а не обход. Снимок 21.09.2026: челлендж-страница, три
> JS-слоя, живая сессия Camoufox, TLS-отпечаток, скриншот виджета.
> Все числа ниже — из команд в конце документа; артефакты — в `/tmp`
> (`body403.html`, `orch.js`, `chl_api.js`, `rch.html`, `ts_api.js`,
> `cf_run1..7.json`) и PNG, который сохранил тул `screenshot`.

## TL;DR — три главных факта

1. **403 — это не блокировка, а приглашение.** Его отдают и curl без
   заголовков, и curl с браузерными заголовками, и Camoufox: демо-страница
   настроена челленджить всех (`cf-mitigated: challenge`). Отпечаток TLS на
   решение «челленджить или нет» здесь не влияет.
2. **Наша цепочка проходит целиком — ломается вердикт.** В живой сессии
   исполнились все три слоя (orchestrator → `api.js` → iframe виджета),
   страница отправила свой XHR на `/fo/…`, виджет **отрисовался** (см.
   скриншот: тёмная тема, «Verifying… / Stuck? Troubleshoot»). Дальше —
   тишина: `cf_clearance` не выставляется, второй заход снова отдаёт
   интерстишл. «Виджета нет» — артефакт наших DOM-тулов: виджет живёт в
   closed shadow root + кросс-доменном iframe и из page JS не виден, но на
   экране он есть.
3. **Всё измеримое нами уже «правильное», а решает сервер.** TLS у Camoufox
   — настоящий Firefox (`t13d1617h2_…`), JS исполняется, сеть до
   `challenges.cloudflare.com` проходит. Значит отказ приходит из
   серверной модели Cloudflare (поведение/отпечаток), которую из страницы
   не видно и не подделать.

## Что именно отдаёт сервер

**403 (HTTP/2), выжимка из `curl -sI`:**

```
cf-mitigated: challenge
accept-ch / critical-ch: Sec-CH-UA-Bitness, …, UA-Arch, UA-Full-Version, …   (17 hints)
content-security-policy: default-src 'none'; script-src 'nonce-…' 'unsafe-eval'
  https://challenges.cloudflare.com; script-src-attr 'none'; style-src 'unsafe-inline';
  img-src 'self' https://challenges.cloudflare.com; connect-src 'self'
  https://challenges.cloudflare.com; frame-src|child-src 'self'
  https://challenges.cloudflare.com blob:; worker-src blob:;
  form-action http: https:; base-uri 'self'
server-timing: chlray;desc="a3e8c5ae0e2860fb"
set-cookie2: cf_clearance=0; path=/; HttpOnly; Secure; expires=Thu, 01 Jan 1970
```

`set-cookie2` с датой 1970 — сервер **обнуляет** прошлый `cf_clearance`:
«предыдущий пропуск для этого челленджа недействителен». `<meta http-equiv=
"refresh" content="360">` в теле — авто-повтор через 6 минут.

**Тело (5.4 КБ, одна строка):** `<title>Just a moment...</title>`, `noscript`
«Enable JavaScript and cookies to continue» — текст меняется на «Performing
security verification» уже после исполнения JS, то есть наличие этой фразы
в `session_text` = «наш JS отработал». Плюс инлайн-конфиг:

```js
window._cf_chl_opt = {cFPWv:'g', cType:'interactive', cTplV:5, cvId:'3',
  cZone:'nopecha.com', cRay:'…', cITimeS:'1789990590',   // = время из Date:
  cH:'…-1789990590-1.2.1.1-…', md:'…', mdrd:'…',
  cUPMDTk:'/demo/cloudflare?__cf_chl_tk=…', fa:'…__cf_chl_f_tk=…'}
```

Токены имеют вид `b64-ts-1.2.1.1-b64`; `cITimeS` совпал с заголовком `date`
до секунды — то есть в токен вшито время выдачи, а значит проверяется и
**время решения** (ср. строки `timecheckcachedwarning`, `timeExtraParamsMs`).
Тот же инлайн-скрипт создаёт `script src=/cdn-cgi/challenge-platform/h/g/
orchestrate/chl_page/v1?ray=…` и подменяет URL на `__cf_chl_rt_tk`+снимает
его в `a.onload` — так фиксируется факт «страница челленджа реально
загрузилась и скрипт исполнился».

**Слои JS** (все скачиваются обычным GET, без JS):

| Слой | URL | Размер |
|---|---|---|
| orchestrator | `nopecha.com/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1` | 233 010 Б |
| api page | `…/h/g/orchestrate/chl_api/v1` | 219 968 Б |
| виджет (iframe) | `challenges.cloudflare.com/cdn-cgi/challenge-platform/h/g/turnstile/f/av0/rch/<id>/0x4AAAAAAAAjq6WYeRDKmebM/dark/fbE/new/normal?lang=auto` | 247 267 Б |
| turnstile api | `challenges.cloudflare.com/turnstile/v0/g/<hash>/api.js?onload=…&render=explicit` | 86 603 Б |

Внутри — обфускация уровня «VM»: таблицы строк через разделитель (`!`, `;`),
control-flow flattening (`switch(Kp[KX++])` с перетасованными индексами),
поверх — core-js (`Cannot find global object`, `Array.prototype.fill`).
Полезные строки, которые видны без деобфускации: `BigInt`, `BigInt64Array`,
`Blob` + `Worker` + `createObjectURL` (часть счёта идёт в blob-воркере),
`crypto.getRandomValues`, `[native code]`, `getOwnPropertyNames`,
`getPrototypeOf`, `PerformanceObserver`/`entryTypes`, `getVoices`,
`matchMedia('(prefers-color-scheme: dark)')`, `XMLHttpRequest`; коды
`unsupportedbrowser`, `timecheckcachedwarning`, `failure`, `script error`,
`timeout`; cookies `cf_chl_rc_i/_m/_ni`, элемент `cf-chl-ra`; в iframe —
Trusted Types-политика и отладочный хук `__cfDebugTurnstileOutcome`.
Готовый адрес приёма данных: `<zone>/cdn-cgi/challenge-platform/h/fo/
<deploy-id>:<ts>:<token>/<ray>/<session>` (XHR, ~30 КБ ответа).

## Живая сессия Camoufox (Firefox 152 UA, Win32-спуф)

`performance.getEntriesByType('resource')` из страницы — доказательство, что
цепочка прошла все шаги:

```
script  194 ms  79 196 B  /cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1?ray=…
script   92 ms  28 277 B  challenges.cloudflare.com/turnstile/v0/g/…/api.js?onload=…&render=explicit
xhr      88 ms  30 254 B  /cdn-cgi/challenge-platform/h/fo/<id>/<ray>/<token>
iframe  135 ms        —   challenges.cloudflare.com/cdn-cgi/challenge-platform/h/g/turnstile/f/av0/rch/d2y14/0x4AAAAAAAAjq6WYeRDKmebM/dark/…
```

Что видно после этого (через `session_eval`, 12–35 с наблюдения):

* `document.title` = «Just a moment...», тело = «Performing security
  verification», Ray ID, футер — страница **не** уходит дальше;
* `window._cf_chl_opt`, `window.turnstile`, `window._cf_chl_state` —
  **удалены** (скраб собственной поверхности: `winProps=[]`), `document.cookie`
  пуст;
* в DOM остаётся только скрытый `input#cf-chl-widget-<id>_response`
  (`name=cf-turnstile-response`, `value=""`);
* контейнер виджета — `div` 896×68 в точке (392, 304); `elementsFromPoint`
  по его центру возвращает только `DIV`, `snapshot` видит 2 ссылки футера —
  внутрь не пускает closed shadow root + кросс-доменный iframe;
* **скриншот** (`screenshot`, `~/.cache/camoufox-research/shots/
  shot_1789991167550.png`): виджет нарисован, тёмная тема, состояние
  **«Verifying… Stuck? Troubleshoot»** — не чекбокс;
* повторный заход на тот же URL — снова 403 + новый Ray ID ⇒ `cf_clearance`
  не выдан;
* консоль: только Feature-Policy-предупреждения из `api.js` и CSP-ошибки от
  **нашего** `session_eval` (в тексте — `{file: "sandbox eval code"}`, хэш
  заблокированного скрипта меняется вместе с нашим кодом). Собственных
  JS-ошибок страницы нет — клиентский код не падал.

## Сигналы: что меряет · как измерен · спуфится ли · вывод

| Сигнал | Как измерен | Спуфится? | Вывод |
|---|---|---|---|
| TLS JA3/JA4 | `tls.browserleaks.com/json` из curl / urllib / Camoufox | да (Camoufox уже отдаёт Firefox-JA4 `t13d1617h2_…`, curl — `t13d3513h2_…`, urllib — `t13d1813h1_…`) | **не причина**: интерстишл получают все трое. Для urllib — сильная улика (h1 + OpenSSL-набор), но решает его не здесь |
| UA-CH (`accept-ch`/`critical-ch`) | `curl -sI` | да | CF просит 17 `Sec-CH-UA-*`/`UA-*`; Firefox их не шлёт — это норма для его UA, не улика |
| Токены `_cf_chl_opt` / `__cf_chl_*` | дамп тела | **нет** (подписаны сервером, вшито время выдачи) | подделка = отказ; это сессия челленджа, а не «поле для спуфа» |
| Исполнение JS | `resources`, `console` | — | цепочка прошла целиком; клиентская часть не блокируется |
| Обфускация/VM бандлов | статический разбор строк | нет | 230 КБ на слой; понять «правильный ответ» чтением нельзя, его считает сервер |
| Целостность built-ins | строки `[native code]`, `getOwnPropertyNames`, `getPrototypeOf` | частично | ловит тампер (инъекции), а не «другой движок» |
| Тайминги счёта | `PerformanceObserver`, `timecheckcachedwarning`, `cITimeS` vs `date` | **нет** (модель на сервере) | «слишком быстро = кэш/подделка»; поведенческий сигнал, не отпечаток |
| Blob-воркер | `Blob`+`Worker`+`createObjectURL` в бандле | нет | часть проверок вынесена из главного потока — из page JS её не перехватить |
| WebGL-рендерер | `session_eval` → `ANGLE (Intel, Intel(R) HD Graphics Direct3D11 vs_5_0 ps_5_0), or similar` | да, но **сейчас неверно** | «, or similar» — строка из пресетов Camoufox; настоящий ANGLE так не пишет → улика (например, для сверки с базой GPU) |
| `navigator.buildID` | `session_eval` → `20181001000000` | да, но **сейчас неверно** | константа против UA Firefox 152 — внутреннее несоответствие версий |
| Вердикт Turnstile | perf-entry iframe + скриншот | — | iframe грузится, вердикт не приходит; внутрь не видно (closed shadow + cross-origin) |
| Интерактивность | `session_click` | — | виджет в «Verifying…»: кликать нечего (клик по центру контейнера (840,338) — мимо виджета, он занимает ~первые 300 px) |

## Где ломается цепочка

* **Гипотеза «TLS/JA4 urllib»** — не подтверждается как причина отказа:
  ровно тот же 403-интерстишл получает Camoufox с настоящим Firefox-TLS.
  Верна только как объяснение *отдельного* факта из `landmines.md` №2
  (urllib против браузерного `ctx.request`).
* **Гипотеза «нет JS-исполнения»** — опровергнута: `chl_page`, `api.js`,
  `/fo/`-XHR и iframe виджета есть в `resources`, виджет нарисован.
* **Гипотеза «проверка поведения/движка движком»** — согласуется с фактами:
  клиент отправляет данные (обфусцированный воркер, тайминги, целостность
  built-ins), а **решение считает сервер**; наружу видно только «Verifying…»
  без финала. Именно поэтому «доделать клиент» нельзя: нечего «правильно
  ответить» — ответа в бандле нет.

Итог: цепочка не ломается на нашей стороне. Она **не завершается на
серверной оценке**: вердикт Turnstile не приходит → `cf_clearance` не
выставляется → каждый заход заново получает интерстишл.

## Что даст следующий шаг (честная оценка)

* **Клик по Turnstile в живой сессии** — *сейчас не проверяемо нашими
  тулами*: у `session_click` нет координат, виджет в closed shadow root,
  `snapshot` его не видит. Плюс наблюдаемое состояние — «Verifying…», а не
  чекбокс, то есть клика никто и не ждёт. Чтобы получить содержательный
  ответ, тулу нужен **координатный клик + `screenshot` в цикле** (левая
  часть бокса, CSS ≈ x 400–420, y 335). Даст различие «интерактивность vs
  вердикт» только если виджет вернётся в состояние с чекбоксом.
* **Headful через виртуальный дисплей (Xvfb)** — снимет расхождения
  headless: реальный размер окна/фокуса, `requestAnimationFrame`-тайминги,
  живой ввод мышью. Ожидание: уберёт часть «поведенческих» вопросов, но не
  подменит серверную модель; проверять — тем же скриншотом и вторым заходом
  за `cf_clearance`.
* **Резидентные/мобильные прокси** — единственный сигнал, который мы вообще
  не видим изнутри (репутация IP/ASN). На демо-странице эффект проверить
  нельзя: она челленджит всех by design, нужен сайт со «managed»-режимом.
* **Что НЕ поможет:** дальнейшая подмена `navigator.*` (Camoufox уже
  подменяет: `webdriver:false`, plugins=5, `oscpu`, экран); подмена JA4
  (уже Firefox-NSS); деобфускация бандла ради «правильного» ответа (ответа
  там нет — считает сервер); синтетические события (`dispatchEvent`,
  `isTrusted=false` — игнорируются); отключение CSP/инъекции в страницу
  (ломает собственную цепочку челленджа и ничего не даёт).

## Открытые вопросы (что осталось непонятным)

1. **Вердикт iframe.** Что приходит в ответ на `/fo/…` (30 КБ) и почему нет
   финала — из page JS не видно: closed shadow root + кросс-домен. Нужен
   сетевой уровень, который пишет запросы **из iframe** (CDP/BiDi или
   прокси), — тул `session_network` тут не помог (`KeyError: 'network' (починено 21.09 — `session_network` отдаёт статусы)`,
   см. ниже).
2. **«Verifying…» без клика против `cType:'interactive'`.** Наблюдали
   спиннер, чекбокса не было ни на 12-й, ни на 35-й секунде. Auto-verify
   «managed»-ветки это или застрявшая проверка — без внутренностей iframe
   не различить.
3. **Какие поведенческие величины сервер считает достаточными** (движения
   мыши, RAF, стабильность таймингов) — модель закрыта, из клиента не
   наблюдается.
4. **Роль резидентного IP** — вне нашей видимости (см. выше).

## Наблюдения по инструментам (не по Cloudflare)

* `session_network` падает на этой странице: `KeyError: 'network' (починено 21.09 — `session_network` отдаёт статусы)` —
  `camoufox_session_ext.session_network` обращается к `w["network"]`, а
  `_WATCH[id(page)]` создаётся другим свидетелем только с ключом `console`.
  `session_block` спасает лишь отчасти (`setdefault` не добавит ключ в уже
  существующий словарь).
* На странице со строгим CSP наши `page.evaluate`-хелперы (`_wait_content`,
  `session_eval`) добавляют в консоль CSP-ошибки «sandbox eval code» —
  `session_eval` при этом работает (CSP разрешает `'unsafe-eval'`).
* «Виджета нет» в DOM-тулах ≠ «виджета нет на экране»: мерить надо
  `screenshot`, а не `querySelectorAll`.

## Как воспроизвести

```bash
cd /tmp && curl -sI -m 25 https://nopecha.com/demo/cloudflare           # 403 + cf-mitigated: challenge
curl -s -m 25 -D h.txt -o body403.html https://nopecha.com/demo/cloudflare   # инлайн-конфиг + noscript
curl -s -o orch.js   "https://nopecha.com/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1?ray=<ray>"
curl -s -o chl_api.js "https://nopecha.com/cdn-cgi/challenge-platform/h/g/orchestrate/chl_api/v1?ray=<ray>"
curl -s -o rch.html  "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/g/turnstile/f/av0/rch/d2y14/0x4AAAAAAAAjq6WYeRDKmebM/dark/fbE/new/normal?lang=auto"
curl -s https://tls.browserleaks.com/json                                # JA4/JA3 нашей HTTP-полосы (curl)
```

Живая сессия — через stdio-драйвер MCP: `<venv>/bin/python scripts/mcp_drive.py
<repo> '<план>'`, план `session_start → session_eval('performance…') →
snapshot → screenshot → session_click → session_status`. Все выводы выше —
из прогонов `/tmp/cf_run1..7` (по 7–50 с каждый): 1–5 — страница, сеть и
DOM; 6 — `snapshot`/`screenshot`; 7 — TLS-отпечаток самого Camoufox.
