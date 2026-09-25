# EARS — грамматика требований

EARS (Easy Approach to Requirements Syntax) — способ записывать критерии приёмки так, чтобы каждый был
проверяем и не допускал двух толкований. Развита Alistair Mavin и командой в Rolls-Royce для требований
авиационных систем управления; Kiro взял её как стандарт для спек.

## Формула

```
While <предусловие>, when <событие>, the <система> shall <отклик>
```

`While` и `when` — необязательные части. Из того, какая часть заполнена, получаются шесть паттернов.

## Язык

- Ключи EARS и фиксированные фразы остаются **английскими**: `When`, `If`, `While`, `Where`,
  `the <system> shall`, `SHALL CONTINUE TO`.
- Переменные части — на языке спеки (`spec.json.language`): событие, предусловие, отклик.
- Не смешивать: внутри английской конструкции не должно оказаться текста другого языка и наоборот.

## Шесть паттернов

| # | Паттерн | Шаблон | Когда | Пример |
|---|---|---|---|---|
| 1 | **Ubiquitous** | `The <system> shall <response>` | всегда активное свойство | The Password Store shall store passwords only as salted hashes. |
| 2 | **Event-driven** | `When <event>, the <system> shall <response>` | реакция на событие | When a user submits valid credentials, the Auth Service shall create a session. |
| 3 | **State-driven** | `While <precondition>, the <system> shall <response>` | поведение, пока держится состояние | While an account is locked, the Auth Service shall reject login attempts. |
| 4 | **Unwanted behaviour** | `If <trigger>, the <system> shall <response>` | ошибки, отказы, нежелательные ситуации | If the password is wrong three times, the Auth Service shall lock the account for 15 minutes. |
| 5 | **Optional feature** | `Where <feature is included>, the <system> shall <response>` | поведение при включённой опциональной фиче | Where MFA is enabled, the Auth Service shall request a verification code. |
| 6 | **Complex** | `While <precondition>, when <event>, the <system> shall <response>` | комбинация условий | While MFA is enabled, when login succeeds, the Auth Service shall request a verification code. |

Второй вариант Complex — `When <event> and <condition>, the <system> shall <response>`.

## Различия, на которых чаще всего ошибаются

- `When` — **событие** (что-то произошло в момент времени). `While` — **состояние** (держится, пока истинно).
- `If` — **нежелательное** событие или условие. Не путать с `When`: если это нормальный ход работы, нужен `When`.
- `Where` — **опциональная фича**, а не «если включено в конфиге». Речь о комплектации: есть фича — есть
  требование к ней.
- Нет условия вовсе — это Ubiquitous, а не «пропущенный When».

## Варианты условий

- Дизъюнкция: `When <event> or <alternative event>, the <system> shall <response>`.
- Конъюнкция: `When <event> and <condition>, the <system> shall <response>`.
- Профильные формы, встречающиеся в практике:
  - состояние системы: `When the system is in <state>, the <system> shall <behaviour>`
  - производительность: `When <user action>, the <system> shall <respond> within <N> ms`
  - безопасность: `If <authentication condition>, the <system> shall <security response>`

## Правила записи

- `shall` — обязательное поведение, `should` — рекомендованное. Смешивать в одном требовании нельзя.
- **Одно поведение на пункт.** Составные критерии с двумя `shall` разбиваются.
- Активный залог, конкретное подлежащее. Не «система», если система называется `Checkout Service`.
- Никаких «user-friendly», «fast», «robust», «properly»: превращать в наблюдаемое числом или фактом.
- Каждый критерий транслируется в тест-кейс. Не транслируется — это не требование, а пожелание.
- Внешние стандарты указываются ссылкой: «comply with WCAG 2.1 AA».
- Каждое требование должно быть выполнимым **и** опровержимым: можно представить вход, на котором оно падает.

## Подлежащее (subject)

- Программный проект — конкретное имя системы или сервиса: `Checkout Service`, `User Auth Module`.
- Процесс или workflow — ответственная роль: `Support Team`, `Review Process`.
- Непрограммное — подходящий субъект: `Marketing Campaign`, `Documentation`.

## Как выглядят критерии в файле

```md
### Requirement 2: Login

**Objective:** As a registered user, I want to log in, so that I can access my account.

#### Acceptance Criteria

1. When a user submits valid credentials, the Auth Service shall create a session and return the user to the
   previously requested page.
2. If the password is wrong, the Auth Service shall reject the attempt without revealing which field was wrong.
3. While an account is locked, the Auth Service shall reject login attempts and show when the lock expires.
4. When a user submits valid credentials and MFA is enabled, the Auth Service shall request a verification code.
```

В официальных доках Kiro строка EARS иногда разбивается на две строки без `THEN`:

```
WHEN a user submits valid registration data
THE SYSTEM SHALL create a new user account
```

Обе формы допустимы. Выбирать одну на всю спеку.

## Чеклист ревью требований

Прогонять по каждому критерию:

- **Actor** — назван субъект?
- **Trigger / Condition** — верный ключ: `When` для события, `While` для состояния, `If` для нежелательного,
  `Where` для опции?
- **System** — названа система, а не «оно»?
- **Response** — отклик конкретен и наблюдаем?
- **Failure** — покрыт отказ, а не только happy path?
- **Testability** — можно написать тест, который упадёт при нарушении?
- **Scope** — нет ли скрытой второй обязанности в том же пункте?
- **Consistency** — не противоречит ли другим критериям?
- **Traceability** — попадёт ли в задачи и дизайн по номеру?

## Дополнительные проверки документа

- **Числовые ID** у каждого требования: `### Requirement 1`, `### Requirement 2: Login`. Буквенные
  (`Requirement A`) запрещены — на них не построить ссылки `_Requirements: 2.1_`.
- Каждое требование содержит минимум один EARS-критерий.
- Ссылки задач — на подтребования (`2.1`, `3.3`), не на заголовок требования.
- Требования без ссылки из задач — сигнал, что между дизайном и задачами потерялась работа.

Эвристика: **документ требований, в котором нет ни одной строки `If`, почти наверняка недописан** — happy path
расписан, отказы нет.
