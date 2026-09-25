---
name: sysprompt
description: Диагностика и обслуживание плагина sysprompt (/prompt) для opencode — проверка статуса загрузки, рестарт сервиса после правок, проверка что текст уходит в системную роль, очистка буфера.
---

# sysprompt ops

Каталог проекта не хардкодится: он вычисляется из симлинка скилла — `readlink -f ~/.agents/skills/sysprompt`
даёт `opencode/skill` внутри проекта, сам проект двумя уровнями выше:

    PROJECT="$(dirname "$(dirname "$(readlink -f ~/.agents/skills/sysprompt)")")"

Если симлинка нет — спросить путь у человека, не угадывать.
Таргет `opencode/dev` ставится через `./install.sh`: симлинки в `~/.config/opencode/plugins`,
`~/.config/opencode/commands`, `~/.agents/skills/sysprompt`.

Таргеты: `opencode-dev`, `omp`, `pi`, `all` (pi и omp делят `PI_CODING_AGENT_DIR`, но каталоги разные: `~/.pi/agent` и `~/.omp/agent`).

На Windows (Git Bash/MSYS) `install.sh` отказывается ставить — там `ln -s` даёт копии; установка
идёт через `pwsh -File install.ps1` (файлы: симлинк → hardlink → копия с предупреждением;
чужой файл на месте ссылки откладывается в `<имя>.bak-<штамп>`; каталог скилла: симлинк или
junction; в конце установщик проверяет, что каждый адрес указывает на файл проекта). Тот же
скрипт работает и на Linux/macOS-pwsh. Проверка установщиков — `bats tests/install.bats`.

## Статус плагина

    opencode2 api v2.plugin.list

Ищи `{"id":"sysprompt","state":{"status":"active"}}`. Если `failed` — читай `state.error`.

## Главная грабля: хот-релоада плагинов нет

Команды opencode перечитывает с диска на лету, плагины — нет: модуль импортируется один раз и
кэшируется. После любой правки файла плагина нужен `opencode2 service restart`. Смена пути через
симлинк тоже подхватывается только рестартом.

## Проверка, что текст реально в системной роли

Зонд ставить только в отдельной песочнице, не в `~/.config/opencode` — иначе зальёшь живой сервис:

```js
export default {
  id: "sysprobe",
  setup: async (context) => {
    await context.session.hook("http.request", async (input) => {
      const body = await input.request.clone().text()
      const json = JSON.parse(body)
      const system = json.messages.filter((message) => message.role === "system")
      console.error("PROBE", "roles=" + json.messages.map((m) => m.role).join(","), JSON.stringify(system).includes("<system-reminder>"))
    })
  },
}
```

Затем: `cd песочница && opencode2 serve --port 40999 --print-logs`, создать сессию через API,
послать команду prompt, посмотреть тело запроса в логе. Ожидаемо: `role=system` содержит
`<system-reminder>` с текстом, `role=user` — тот же текст без тегов.

## Грабли

- Буфер живёт в памяти серверного процесса; рестарт его обнуляет.
- После `/prompt clear` текст из истории не исчезает и может продолжать влиять на модель.
- Модель видит текст дважды (user + system) — это по SPEC, не баг.
