# prompt-station

Станция прошивок системных промтов: кладёт персону в клиентов — `omp`, `pi`, `opencode`.
Прошивки живут одним каталогом (`personas/` рядом со станцией), копий не разводится.

## Куда кладётся

- `omp` — `<agent dir>/APPEND_SYSTEM.md` (дополняет правила харнесса) или `SYSTEM.md` (заменяет);
- `pi` — то же, механика унаследована;
- `opencode` — `<config dir>/AGENTS.md`; жёсткой замены промта у него нет, только добавление.

`<agent dir>` — `$PI_CODING_AGENT_DIR` или `~/.omp/agent` / `~/.pi/agent`; `<config dir>` —
`$XDG_CONFIG_HOME/opencode` или `~/.config/opencode`. Абсолютные пути диска никуда не пишутся:
содержимое копируется в клиентский каталог.

## Установка

    "$STATION"/bin/prompt-station.sh flash duck            # во все три клиента
    "$STATION"/bin/prompt-station.sh flash duck --client omp --target system
    "$STATION"/bin/prompt-station.sh status

Windows — `pwsh -File bin/prompt-station.ps1 flash duck` или двойной щелчок `bin/prompt-station.cmd`.
После прошивки клиентам нужен перезапуск (omp/pi читают файлы на старте сессии, opencode — сервиса).

## Смена на ходу

База — файл прошивки (читается на старте), живая смена — расширение:

    bin/prompt-station.sh install-ext
    # в сессии: /persona duck | /persona (список) | /persona off

инжект идёт системным сообщением на каждом запросе (omp/pi — `before_provider_request`,
opencode — хук `context`), персона держится по session id. opencode подхватывает плагин после
`opencode2 service restart`.

## Проверка

    bin/prompt-station.sh status     # прошито: <имя> или пусто, код 1 если где-то пусто;
                                     # плюс расширения persona/sysprompt у трёх клиентов и строка про их конфликт
    bin/prompt-station.sh verify duck
    bats tests/station.bats          # 23 теста, дом и каталог прошивок подменяются

## Грабли

- `revert` возвращает только то, что лежит в `.bak` (его делает `flash`); если файла раньше не было —
  файл удаляется целиком.
- Проектный `AGENTS.md` сильнее глобального: глобальная прошивка его не отменяет, тексты складываются.
- Смена прошивки — это правка файла, а не флаг: что зашито сейчас, показывает только `status`.
