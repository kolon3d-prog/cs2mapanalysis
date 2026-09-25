# Чего не хватает для отладки и реверса — разбор MCP-набора

Дата разбора: 23.09.2026. Машина: Fedora 44, ядро 7.2.6-cachyos (BTF есть), sudo без пароля,
`ptrace_scope=0`, три клиента (omp, pi, opencode).

**Статус: вкатано.** Разбор превратился в дело 23.09.2026: семь записей лежат в `catalog/`
(`gdb`, `frida-mcp`, `bpftrace`, `wireshark-mcp`, `mitmproxy-mcp`, `lldb`, `radare2`), рантаймы
собирают близнецы `bin/debug-setup.sh` (Linux/macOS) и `bin/debug-setup.ps1` (Windows), записи стоят
во всех трёх клиентах, `mcp-station verify` по ним — **21/21 connected**. Приложения А и Б оставлены
как история решения: боевые записи теперь в `catalog/`, а не в черновиках.
Матрица платформ — `mcp-station/README.md`, раздел «Платформы отладочных записей».

## Короткий ответ

Сейчас набор умеет отлаживать **только браузер** (`chrome-devtools`, `playwright`, `camoufox`,
`stealth-browser`). Всё, что ниже уровня JS в странице, — нативная программа, живой процесс,
ядро, бинарь, пакеты в сети, дампы — не закрыто ничем.

| задача | чем закрывается | статус |
|---|---|---|
| отладка нативной программы: точки останова, шаг, переменные | `gdb` (mcp-gdb, signal-slot) | в каталоге, 17 тулов, verify ✓ |
| attach к живому процессу изнутри (ptrace) | `gdb.gdb_attach` | проверено живьём: attach к `sleep`, backtrace, регистры, `print`, terminate |
| официальный отладчик LLVM по MCP | `lldb` + мост `bin/lldb-mcp-bridge.sh` | в каталоге, 2 тула, verify ✓ |
| инъекция кода, хуки функций, дамп памяти процесса | `frida-mcp` | в каталоге, 13 тулов, verify ✓ |
| ядро, системные вызовы, kprobe/uprobe | `bpftrace` (bpftrace-mcp-server + bpftrace) | в каталоге, 4 тула, verify ✓ (234 события `execve` за 3 с) |
| пакеты в сети (.pcap, живой захват) | `wireshark-mcp` + tshark | в каталоге, 52 тула (полный профиль), verify ✓ |
| перехват HTTP(S), реверс API, реплей | `mitmproxy-mcp` | в каталоге, 25 тулов, verify ✓ |
| статический реверс бинаря (ELF/PE) | `radare2` (r2mcp) на upstream r2 6.2.3 | в каталоге, 32 тула, verify ✓ |
| дампы/ядро Windows | `mcp-windbg` (PyPI 1.3.0, 1586★) | кандидат, проверяется только на Windows |
| форензика памяти, дампы процессов | `volatility-mcp` и др. | кандидат, не проверялся |
| контейнеры (docker/podman/k8s) изнутри | `inspektor-gadget/ig-mcp-server` | кандидат, не проверялся |

Полный список кандидатов с числами — в разделе «Кандидаты без живой проверки».

## Почему эти серверы, а не другие

Смотрели на три вещи: свежесть (push), популярность (звёзды) и модель тулов. Модель бывает «один
мощный тул» (LLDB: `command` умеет всё, что умеет отладчик; bpftrace: `exec_program` принимает любую
программу) и «много мелких» (gdb 17, wireshark 52, radare2 42). Малое число тулов у официальных
серверов — это дизайн, а не бедность: экономится контекст клиента, а мощность — в командном языке.

| инструмент | выбрано | альтернативы (звёзды / свежесть) | почему так |
|---|---|---|---|
| gdb | `mcp-gdb` (signal-slot) — 159★, 2026-07, 17 тулов | `datobena/gdb-mcp` 3★ (стоял первым), `Ipiano/gdb-mcp` 48★/22 тула, `pansila/mcp_server_gdb` 68★, `MDB-MCP` 74★ (GDB+LLDB) | повышен: старый был 3★ и 7 тулов; у нового 17, свежесть и живой attach; `npx` = одна форма на три ОС |
| lldb | официальный `lldb-mcp` (LLVM), 2 тула в 22.x, 4 в 23 | `lisa.py` 758★ (2025-03, заброшен), `FYTJ/lldb-mcp-server` 40 тулов (4★), `0xeb/lldb-agent` 20★ | вендор: любые команды одним тулом; альтернативы слабые по поддержке |
| frida | `dnakov/frida-mcp` — 435★, 13 тулов | `kahlo-mcp` 134★ (Android), `zhizhuodemao/frida-mcp` 121★ | самый известный и полный по процессам и памяти |
| wireshark | `bx33661/Wireshark-MCP` — 261★, 52 тула, 2026-09 | `0xKoda/WireMCP` 584★ (2025-07, заброшен), `khuynh22/mcp-wireshark` 58★/14 тулов | больше тулов и живая поддержка; профиль переключён с core (32) на полный (52) |
| bpftrace | `eunomia-bpf/MCPtrace` — 73★ | сравнимых нет | единственный зрелый; 4 тула = любая bpftrace-программа |
| radare2 | официальный `radareorg/radare2-mcp` — 307★ | `rizin-mcp` 3★ | официальный, активен, 32–42 тула |
| mitmproxy | `snapspecter/mitmproxy-mcp` — 122★, 2026-09 | сравнимых нет | активен, заточен под реверс API |

## Что есть в каталоге сейчас

**Веб и браузер:** `chrome-devtools`, `playwright`, `stealth-browser`, `camoufox` — это про
страницу и трафик самой вкладки, не про процессы и бинари.

**Ресёрч и данные:** `firecrawl`, `tavily`, `exa`, `serper`, `lazyweb`, `inspo`, `jev`.

**Набор и знание:** `skills-hub`, `basic-memory`, `wiki`.

Ни одной записи про `ptrace`, gdb/lldb, Frida, eBPF, дизассемблер, tshark или mitmproxy.

## Проверено живьём (чем и как)

Все проверки — через пробу набора `test-center/probes/mcp-handshake.mjs` (initialize + tools/list)
и живые вызовы инструментов. Команды воспроизводимы.

### 1. gdb-mcp — отладка и attach изнутри

```bash
uv venv /tmp/opencode/probe-gdb/venv --python 3.12
uv pip install --python /tmp/opencode/probe-gdb/venv/bin/python gdb-mcp "mcp<2"
node test-center/probes/mcp-handshake.mjs /tmp/opencode/probe-gdb/venv/bin/gdb-mcp --min 3
# инструментов: 7 — start_binary, attach_to_pid, gdb_command, list_sessions, stop_session, batch_commands, session_status
```

Живой attach (скрипт `/tmp/opencode/mcp-attach-test.mjs`, цель — `sleep 600`):

```
attach:  session_id 7f03895e-…, "Attaching to process 2522238… Reading symbols from /usr/bin/sleep"
THREADS: Id 1 Thread 0x7f2e5639f740 (LWP 2522238) "sleep" 0x00007f2e5641154e in __internal_syscall_cancel ()
MAPPINGS: 0x0000556ce1ed7000–… r-xp /usr/bin/sleep …
stop: {"stopped": true}
```

Версии: `gdb-mcp 1.0.1` (сам сервер представляется как `gdb-mcp 1.30.0`), `mcp 1.30.0`.
**Важно:** с `mcp 2.x` сервер падает на импорте `mcp.server.fastmcp` — ставить с пином `mcp<2`.

### 2. lldb-mcp — официальный MCP от LLVM (пакет Fedora)

В Fedora 44 `lldb 22.1.8` уже содержит `/usr/bin/lldb-mcp`. Но в 22.1.8 это **не stdio-сервер**:
бинарь поднимает `lldb -O "protocol start MCP"` (MCP-сервер на TCP-порту) и форвардит IO в REPL.
Чтобы клиент говорил по stdio, нужен мост `nc` и живой бэкенд:

```bash
setsid bash -c 'tail -f /dev/null | lldb -O "protocol-server start MCP listen://127.0.0.1:59999" >/dev/null 2>&1' &
node test-center/probes/mcp-handshake.mjs nc 127.0.0.1 59999 --min 1
# инструментов: 2 — command, debugger_list
pkill -f "protocol-server start MCP"
```

Тулы: `command` (любая команда LLDB: `target create`, `process attach --pid`, `breakpoint set`,
`memory read`) и `debugger_list`. В LLVM 23 обещают stdio-мультиплексор с 4 тулами
(`session_create`, `command`, `sessions_list`, `session_close`) — тогда мост не нужен.
Что честно: гонять это как запись каталога можно только через обёртку, которая поднимает
бэкенд и держит порт (черновик — в «Приложении А»).

### 3. frida-mcp — инъекция кода в живой процесс

```bash
uv venv /tmp/opencode/probe-frida/venv --python 3.12
uv pip install --python /tmp/opencode/probe-frida/venv/bin/python frida frida-mcp "mcp<2"
node test-center/probes/mcp-handshake.mjs /tmp/opencode/probe-frida/venv/bin/frida-mcp --min 3
# frida 17.18.0; инструментов: 13 — list_processes, enumerate_devices, get_process_by_name,
# attach, spawn, resume, kill, create_script, inject_script, …
```

Это то самое «залезть внутрь»: attach/spawn, JS-скрипты, хуки, чтение/дамп памяти, RPC.
Требует `frida` в том же venv. Альтернатива для мобилок — `FuzzySecurity/kahlo-mcp` (134★, Android).

### 4. bpftrace-mcp-server (MCPtrace) — ядро и сисколлы

```bash
cargo install --locked bpftrace-mcp-server      # 0.1.1, собралось за 39 с
sudo dnf install -y bpftrace                   # 0.24.2
BPFTRACE_PASSWD= node /tmp/opencode/mcp-mcptrace-test.mjs
# server: rmcp 0.2.1; tools: list_probes, bpf_info, exec_program, get_result
# exec_program: 234 строки за 3 с — "xargs -> /usr/bin/cat", "rustdesk -> /bin/sh", "sh -> /usr/bin/ps"…
```

Нюансы, проверенные делом:
- без переменной `BPFTRACE_PASSWD` сервер молча выходит с кодом 1 (даже от root);
- `BPFTRACE_PASSWD=` (пустая) работает, потому что на этой машине **sudo без пароля** —
  сервер подаёт пустую строку в `sudo -S`, и NOPASSWD её пропускает. Если sudo с паролем —
  в переменную придётся положить пароль (это политика самого MCPtrace, а не набора);
- `unprivileged_bpf_disabled=2` — без root/eBPF-капабилити трассировка не пойдёт.

### 5. wireshark-mcp — пакеты

```bash
sudo dnf install -y wireshark-cli               # tshark 4.6.8
uv venv /tmp/opencode/probe-ws/venv --python 3.12
uv pip install --python /tmp/opencode/probe-ws/venv/bin/python wireshark-mcp   # 3.0.0
node test-center/probes/mcp-handshake.mjs /tmp/opencode/probe-ws/venv/bin/wireshark-mcp --min 5
# инструментов: 52 — открытие .pcap, статистика, HTTP/DNS, TLS-расшифровка, YARA, живой захват
```

В 3.0 все инструменты, создающие файлы, «fail closed» без `WIRESHARK_MCP_ALLOWED_DIRS`.
Живой захват требует прав на `dumpcap` (группа `wireshark` или capabilities).

### 6. mitmproxy-mcp — HTTP(S) изнутри

```bash
uv venv /tmp/opencode/probe-mitm/venv --python 3.12
uv pip install --python /tmp/opencode/probe-mitm/venv/bin/python mitmproxy-mcp   # 0.6.1
node test-center/probes/mcp-handshake.mjs /tmp/opencode/probe-mitm/venv/bin/mitmproxy-mcp --min 3
# инструментов: 25 — start_proxy/stop_proxy, scope по доменам, правка заголовков, реплей,
# извлечение JSONPath/CSS, фаззинг параметров, экспорт OpenAPI-наброска
```

Для перехвата HTTPS клиенту нужен доверенный CA mitmproxy — отдельный шаг, не делался.

### 7. Что проверено на хосте (без MCP)

- `gdb -batch -ex attach` к чужому `sleep` — прошло (`ptrace_scope=0`);
- `bpftrace -e 'tracepoint:syscalls:sys_enter_execve {…}' -c '/bin/ls …'` — прошло;
- `gcore`, `eu-stack`, `pstack`, `strace`, `tcpdump`, `lsof`, `ss`, `netstat`, `objdump`,
  `readelf`, `nm`, `dotnet` — есть и работают как хостовые инструменты.

## Соответствие оригиналам (Zero-Invention)

Ни один дефолт не выдуман — каждый взят из кода, метаданных пакета или документации:

| что | откуда взято |
|---|---|
| python 3.12 в рантайм-venv | `mitmproxy-mcp`: `Requires-Python >=3.12,<3.14` (метаданные PyPI); у `frida` нет wheel'ов под cp314 |
| пин `mcp<2` у `frida-mcp` | `frida_mcp/cli.py:11` — `from mcp.server.fastmcp import FastMCP, Context`; в `mcp 2.x` модуля нет (падение проверено на 2.2.0) |
| `mcp` без пина у `wireshark-mcp` | его собственное требование `mcp>=2.1.1,<3` (метаданные PyPI) |
| `npx -y mcp-gdb` и `cmd.exe /c npx …` на Windows | README пакета `mcp-gdb` (signal-slot) и правило каталога для npx-записей |
| `BPFTRACE_PASSWD` | MCPtrace `src/main.rs:529` — `std::env::var("BPFTRACE_PASSWD")`; без переменной сервер выходит с кодом 1 |
| порт 59999 у lldb-моста | документация LLVM `lldb.llvm.org/use/mcp.html`, пример `listen://localhost:59999`; переопределяется `LLDB_MCP_PORT` |
| `WIRESHARK_MCP_ALLOWED_DIRS` | README Wireshark-MCP 3.x («fail closed» без переменной); значение `$HOME` — наше решение и оно видно в записи |

## Сбои и ограничения (честно)

1. ~~r2mcp не собрался~~ — **решено.** С Fedora-радаре2 5.9.8 `r2pm -Uci r2mcp` падал на `check_deps`
   (CI r2mcp собран против radare2 6.2.2). Поставлен upstream **radare2 6.2.3** (`sys/install.sh`,
   в `/usr/local`), `r2mcp` собрался с первого раза, запись `radare2` в каталоге, verify ✓.
   Distro-пакет 5.9.8 снят, чтобы не путать две версии.
2. **lldb-mcp в Fedora 22.1.8 — TCP, не stdio.** Прямая запись в каталог невозможна без обёртки
   и живущего бэкенда; порт фиксированный, бэкенд надо перезапускать после ребута/чистки.
3. **Пины `mcp<2`** для `gdb-mcp` и `frida-mcp`: с mcp 2.x они не стартуют (FastMCP переехал).
   `wireshark-mcp 3.0.0`, наоборот, требует `mcp>=2.1.1` — в одном venv их не смешивать.
4. **bpftrace-путь требует root** (`unprivileged_bpf_disabled=2`) и переменной `BPFTRACE_PASSWD`
   у MCPtrace; на этой машине спасает NOPASSWD sudo.
5. **Windows-отладка на Linux не проверяется**: `mcp-windbg` (CDB/KD), `x64dbg-mcp`,
   Process Monitor `.PML` — только на Windows-машине, здесь честно «не проверено».
6. **Платные статические реверсеры** (`ida-pro-mcp` 12k★, `binary_ninja_mcp`) требуют лицензий
   IDA/Binary Ninja — в набор не предлагаются.

## Кандидаты без живой проверки

| кандидат | звёзды / свежесть | что даёт | чего стоит |
|---|---|---|---|
| `LaurieWired/GhidraMCP` | 10158★, 2025-06 | декомпиляция и анализ в Ghidra через MCP | Ghidra + JDK 21+ (java 25 есть, `javac` доставить: `dnf install java-25-openjdk-devel`) |
| `president-xd/revula` | 77★, 2026-08 | «один сервер»: capstone/LIEF/YARA/angr, GDB/LLDB/Frida-адаптеры, jadx/APK, ROP | pip-установка из клона или Docker; проверять отдельно |
| `radareorg/radare2-mcp` | 307★, 2026-09 | официальный MCP radare2: анализ, декомпиляция, HTTP-режим, readonly-режим | radare2 ≥6.2.2 из upstream (см. сбой 1) |
| `microsoft`-линия: `svnscha/mcp-windbg` | 1586★, 2026-09 | дампы падений, user-mode и kernel-отладка Windows | Windows + Debugging Tools for Windows |
| `Gaffx/volatility-mcp` | 52★, 2025-07 | форензика памяти (volatility3): процессы, модули, скрытые объекты | дампы памяти; pip-установка |
| `inspektor-gadget/ig-mcp-server` | 27★, 2026-08 | eBPF-взгляд внутрь контейнеров и k8s | docker/podman/k8s (на машине есть docker и podman) |
| `frankbolero/dotnet-dump-mcp` | 13★, 2026-09 | разбор дампов .NET | `dotnet` (есть) |
| `FuzzySecurity/kahlo-mcp` | 134★, 2026-02 | Frida для Android: SSL-pinning, хуки, память | устройство/эмулятор Android |

## Приложение А. Черновики записей каталога

История решения: эти записи **вкатаны** в `catalog/` 23.09.2026 (боевые файлы — `catalog/<имя>.json`,
рантаймы собирает `bin/debug-setup.sh`, а с 23.09 — и близнец `bin/debug-setup.ps1` для Windows).
Запись `gdb-mcp` из первой версии заменена на `gdb` (mcp-gdb): 159★ против 3★ и 17 тулов против 7 —
обе версии проверены живьём. Текст ниже — как записи выглядели в черновике; приём тот же:
нет рантайма — клиент

### gdb-mcp (Linux)

```json
{
  "name": "gdb-mcp",
  "kind": "stdio",
  "tier": "core",
  "description": "отладка нативной программы через gdb: запуск, attach к живому процессу (ptrace), команды, сессии",
  "argv": ["bash", "-lc", "test -x \"$HOME/.venvs/gdb-mcp/bin/gdb-mcp\" || { printf 'gdb-mcp не собран: запусти mcp-station/bin/debug-setup.sh\\n' >&2; exit 1; }; command -v gdb >/dev/null 2>&1 || { printf 'нет gdb: sudo dnf install gdb\\n' >&2; exit 1; }; exec \"$HOME/.venvs/gdb-mcp/bin/gdb-mcp\""],
  "clients": ["omp", "opencode", "pi"]
}
```

На Windows запись не ставится (нет `argvWindows`) — там своя линия (`mcp-windbg`).

### frida-mcp (Linux)

```json
{
  "name": "frida-mcp",
  "kind": "stdio",
  "tier": "core",
  "description": "динамическая инструментация Frida: attach/spawn, инъекция JS, хуки, чтение и дамп памяти процесса",
  "argv": ["bash", "-lc", "test -x \"$HOME/.venvs/frida-mcp/bin/frida-mcp\" || { printf 'frida-mcp не собран: запусти mcp-station/bin/debug-setup.sh\\n' >&2; exit 1; }; exec \"$HOME/.venvs/frida-mcp/bin/frida-mcp\""],
  "clients": ["omp", "opencode", "pi"]
}
```

### bpftrace (Linux)

```json
{
  "name": "bpftrace",
  "kind": "stdio",
  "tier": "core",
  "description": "трассировка ядра через bpftrace/eBPF: kprobe, uprobe, tracepoint, syscalls — события процессов изнутри системы",
  "argv": ["bash", "-lc", "command -v bpftrace-mcp-server >/dev/null 2>&1 || { printf 'нет bpftrace-mcp-server: cargo install --locked bpftrace-mcp-server\\n' >&2; exit 1; }; command -v bpftrace >/dev/null 2>&1 || { printf 'нет bpftrace: sudo dnf install bpftrace\\n' >&2; exit 1; }; export BPFTRACE_PASSWD=\"${BPFTRACE_PASSWD-}\"; exec bpftrace-mcp-server"],
  "clients": ["omp", "opencode", "pi"]
}
```

### wireshark-mcp (Linux)

```json
{
  "name": "wireshark-mcp",
  "kind": "stdio",
  "tier": "core",
  "description": "анализ пакетов через tshark: .pcap, статистика, HTTP/DNS, расшифровка TLS, YARA",
  "argv": ["bash", "-lc", "test -x \"$HOME/.venvs/wireshark-mcp/bin/wireshark-mcp\" || { printf 'wireshark-mcp не собран: запусти mcp-station/bin/debug-setup.sh\\n' >&2; exit 1; }; command -v tshark >/dev/null 2>&1 || { printf 'нет tshark: sudo dnf install wireshark-cli\\n' >&2; exit 1; }; exec \"$HOME/.venvs/wireshark-mcp/bin/wireshark-mcp\" serve --profile core"],
  "clients": ["omp", "opencode", "pi"]
}
```

### mitmproxy-mcp (Linux)

```json
{
  "name": "mitmproxy-mcp",
  "kind": "stdio",
  "tier": "core",
  "description": "перехват HTTP(S): правка и реплей трафика, реверс API, экспорт OpenAPI-наброска",
  "argv": ["bash", "-lc", "if command -v mitmproxy-mcp >/dev/null 2>&1; then exec mitmproxy-mcp; fi; command -v uvx >/dev/null 2>&1 || { printf 'нет uvx: поставь uv (см. cli-station)\\n' >&2; exit 1; }; exec uvx mitmproxy-mcp"],
  "clients": ["omp", "opencode", "pi"]
}
```

### lldb (Linux, только с обёрткой)

```json
{
  "name": "lldb",
  "kind": "stdio",
  "tier": "core",
  "description": "официальный MCP-сервер LLVM LLDB: любые команды отладчика, attach к живому процессу, память",
  "argv": ["bash", "-lc", "command -v lldb >/dev/null 2>&1 || { printf 'нет lldb: sudo dnf install lldb\\n' >&2; exit 1; }; exec \"$STATION/bin/lldb-mcp-bridge.sh\""],
  "clients": ["omp", "opencode", "pi"]
}
```

## Приложение Б. Черновик `bin/debug-setup.sh`

Идея — как у `stealth-setup.sh`: один раз собрать рантаймы, клиентам останется только запись.

```bash
#!/usr/bin/env bash
# Рантаймы отладочных MCP: venv'ы в $HOME/.venvs, без системных питонов.
set -euo pipefail
say() { printf '%s\n' "$*"; }

# Linux-пакеты, если их нет
for pkg in gdb tshark bpftrace; do
  command -v "$pkg" >/dev/null 2>&1 || say "нет $pkg: sudo dnf install gdb wireshark-cli bpftrace"
done
command -v cargo >/dev/null 2>&1 || say "нет cargo: поставь rust (rustup)"
command -v cargo >/dev/null 2>&1 && {
  command -v bpftrace-mcp-server >/dev/null 2>&1 || cargo install --locked bpftrace-mcp-server
}

mkvenv() { # имя, питон, пакеты...
  local name="$1" py="$2"; shift 2
  [ -x "$HOME/.venvs/$name/bin/$name" ] && { say "$name: уже собран"; return; }
  uv venv "$HOME/.venvs/$name" --python "$py"
  uv pip install --python "$HOME/.venvs/$name/bin/python" "$@"
  say "$name: собран"
}

mkvenv gdb-mcp       3.12 gdb-mcp "mcp<2"
mkvenv frida-mcp     3.12 frida frida-mcp "mcp<2"
mkvenv wireshark-mcp 3.12 wireshark-mcp
mkvenv mitmproxy-mcp 3.12 mitmproxy-mcp
say "готово. Дальше: mcp-station install gdb-mcp frida-mcp bpftrace wireshark-mcp mitmproxy-mcp"
```

## Приложение В. Что эта проверка уже поставила на машину

Ставилось только то, без чего проверка не живёт; снимается одной командой:

```bash
sudo dnf install -y lldb bpftrace wireshark-cli      # системные инструменты (gdb уже был)
sudo dnf remove  -y lldb bpftrace wireshark-cli      # как снять, если не нужно
cargo install --locked bpftrace-mcp-server           # 0.1.1; снять: cargo uninstall bpftrace-mcp-server

# upstream radare2 6.2.3 — в /usr/local; distro-пакет 5.9.8 снят, чтобы не путать версии:
git clone https://github.com/radareorg/radare2 && cd radare2 && sys/install.sh && r2pm -Uci r2mcp

# рантаймы MCP: ~/.venvs/{gdb-mcp,frida-mcp,wireshark-mcp,mitmproxy-mcp}, мост ~/.local/bin/lldb-mcp-bridge
# их собирает bin/debug-setup.sh; снятие — удалить эти каталоги
```

`radare2` из Fedora (5.9.8) не нужен: r2mcp под него не собирается, он снят; остался upstream 6.2.3.

## Следующий шаг

**Сделано.** Владельцу осталось:

1. Перезапустить клиентов (opencode2 service restart / новый сеанс omp, pi): конфиги правлены позже
   запуска процессов, тулы появятся после рестарта.
2. По желанию — Windows-линия (дампы падений, ядро): `mcp-windbg` (CDB/KD), отдельно на Windows-машине.
3. По желанию — тяжёлые дополнения: форензика памяти (`volatility-mcp`), контейнеры изнутри
   (`inspektor-gadget/ig-mcp-server`), «всё-в-одном» `revula` (200+ тулов, дорого по контексту).

## Приложение Г. Отладка самих MCP-сессий (смежная дыра)

Набор проверяет MCP хендшейком (`test-center`, `center verify`), но не видит сам трафик
клиент↔сервер: аргументы и ответы инструментов. Для этого есть готовые прокси-инспекторы:

- `kerlenton/mcpsnoop` (356★, 2026-09) — «Wireshark для MCP»: прозрачный прокси, видно каждый вызов;
- `mcp-shark/mcp-shark` (178★, 2026-04) — захват и форензика MCP-обмена.

В каталог их не предлагаю: это отладочный инструмент для самих агентов, а не ежедневный MCP.
Но при разборе «почему клиент не увидел тул» они экономят часы.

## Как перепроверить этот разбор

```bash
# каталог: отладочные записи на месте
jq -r '.name' mcp-station/catalog/*.json | sort | grep -iE "gdb|lldb|frida|bpf|wireshark|mitm|radare"

# рука на пульсе (после сборки рантаймов)
node test-center/probes/mcp-handshake.mjs "$HOME/.venvs/gdb-mcp/bin/gdb-mcp" --min 7
bash mcp-station/bin/mcp-station.sh check
```

---

Свидетельства этого разбора живут в `/tmp/opencode/probe-*` (временные venv'ы). Их можно удалить:
`rm -rf /tmp/opencode/probe-*` — на записи каталога это не влияет, потому что они не вкатаны.
