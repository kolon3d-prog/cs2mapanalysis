#!/usr/bin/env node
// command-center — центр координации: знает все проекты на диске, их связи, умеет спросить каждого
// о состоянии, активировать их и провести установку с нуля на новой машине.
//
// Вся карта — в registry.json: пути в нём относительные (от каталога центра), поэтому абсолютных
// путей нет и переезд диска ничего не ломает. Общение с проектами — через их собственные команды.
import { existsSync, readFileSync, readdirSync, lstatSync, readlinkSync, realpathSync, statSync, accessSync, constants, closeSync, openSync, readSync, unlinkSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep, isAbsolute, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { isPathWithin, normalizePathKey } from "./path-utils.mjs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HOME = process.env.CENTER_HOME || homedir();
const PLATFORM = process.env.CENTER_PLATFORM || process.platform;
/**
 * Платформа, решённая один раз. На Windows у центра своя ветка на каждый вызов шелла: `bash` в PATH там
 * часто заглушка WSL (WindowsApps\bash.exe) — печатает «поставь дистрибутив» и выходит с нулём, поэтому
 * «bash есть в PATH» не значит «bash работает». Настоящий bash ищем по абсолютному пути и проверяем делом,
 * а где можно — обходимся без шелла вовсе (node, pwsh, cmd.exe).
 */
const IS_WIN = PLATFORM === "win32";
/**
 * Разделитель PATH — по виду самой строки, а не по платформе: на Windows её пишут через «;», но в Git Bash
 * (и в WSL) та же переменная приходит через «:». Правило одно и у каталогов, и у дописывания: если каталог
 * дописать «;»-ом к «:»-PATH, разбор решит, что разделитель «;», сведёт всю PATH к одному мусорному сегменту
 * и не найдёт в ней ничего — план под win32 падал на «нет PowerShell» при установленном pwsh.
 */
function pathSepOf(path) {
  return path.includes(";") || /^[A-Za-z]:[\\/]/.test(path) ? ";" : ":";
}
/**
 * Выход из движка. `bye()` в этот момент обрывает вывод: stdout и stderr по трубе пишутся
 * асинхронно, а exit не ждёт дописывания. `center status --json | jq` отдавал ровно 8192 байта
 * (один буфер) вместо 12635 — jq падал на «Unfinished JSON», а набор тестов падал плавающе:
 * один прогон зелёный, другой красный на той же команде.
 *
 * Поэтому код кладём в process.exitCode и даём процессу выйти самому — так вывод дописывается
 * всегда. Страховочный таймер (unref, не держит процесс) на случай, если появится висящая ручка:
 * без неё такой случай читался бы как вечное молчание.
 */
function bye(code) {
  process.exitCode = code;
  // страховка, а не основной путь: таймер unref — процесс выходит сам, как только вывод дописан.
  // Вызывать здесь bye нельзя: это тот же отложенный выход, а не форс. Только process.exit.
  setTimeout(() => process.exit(code), 5000).unref();
}
/**
 * Домашний склад бинарей: сюда ставят свои команды установщики вендоров и станции набора (omp, uv,
 * basic-memory, skills-manager, сам center), а PATH свежей оболочки про каталог может ещё не знать.
 * Дописываем его в PATH процесса: установка не должна спотыкаться о то, что появится в новой оболочке.
 */
const HOME_STORE = join(HOME, ".local", "bin");
{
  const current = String(process.env.PATH ?? "");
  const sep = pathSepOf(current);
  if (!current.split(sep).includes(HOME_STORE)) process.env.PATH = `${HOME_STORE}${sep}${current}`;
}
/** Реестр: по умолчанию рядом с центром. CENTER_REGISTRY — хук для тестов (там команды проектов подменяются заглушками). */
const REGISTRY = process.env.CENTER_REGISTRY ? resolve(process.env.CENTER_REGISTRY) : join(ROOT, "registry.json");
/** Проекты — соседи центра внутри AGGG: путь считается от центра, абсолютных путей не пишем. */
const PROJECTS_ROOT = process.env.CENTER_PROJECTS_ROOT ? resolve(process.env.CENTER_PROJECTS_ROOT) : resolve(ROOT, "..");
/** Версия набора — осознанная: правило бампа и ритуал релиза описаны в docs/09-release.md. */
const VERSION_POLICY = {
  patch: "правки внутри станций: те же команды, те же контракты",
  minor: "новый проект, новая команда центра или новое поле реестра",
  major: "смена контракта между станциями (несовместимая: стороны обновляются вместе)",
};
/** Таймаут живой проверки MCP по умолчанию (секунды): столько ждём ответа сервера на initialize. */
const VERIFY_TIMEOUT = 20;

/** Расширения исполняемых файлов Windows: PATHEXT — источник правды, а не догадки про .exe. */
function pathExts() {
  return String(process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((ext) => ext.trim())
    .filter(Boolean);
}

/**
 * Файл есть и запускаем: на Unix это бит, на Windows — расширение из PATHEXT (бита там нет вовсе).
 * Store alias в WindowsApps иногда не читается через stat, но access и запуск Windows проходят.
 */
function executableFile(path) {
  try {
    if (!statSync(path).isFile()) return false;
    if (!IS_WIN) accessSync(path, constants.X_OK);
    return true;
  } catch (error) {
    if (!IS_WIN || error.code !== "EACCES") return false;
    try {
      accessSync(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Каталоги PATH. Разделитель берём по виду самой строки, а не по платформе: на Windows её пишут через «;»,
 * но в Git Bash (и в WSL) та же переменная приходит через «:» с путями вида /c/... — «;»-разбор там не
 * находит вообще ничего, и живой набор снова выглядит пустым.
 */
function pathDirs() {
  const path = String(process.env.PATH ?? "");
  return path
    .split(pathSepOf(path))
    .map((dir) => dir.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}

/**
 * Где лежит команда: обход PATH своими руками, без шелла и без `command -v`. На Windows имя получает
 * расширения PATHEXT (npx.cmd, gh.exe — тоже команды), а каталог заглушек WindowsApps можно пропустить.
 */
function whichTool(name, { skipWindowsApps = false } = {}) {
  for (const dir of pathDirs()) {
    if (skipWindowsApps && /[\\/]WindowsApps[\\/]/i.test(dir)) continue;
    for (const ext of ["", ...(IS_WIN ? pathExts() : [])]) {
      const candidate = join(dir, `${name}${ext}`);
      if (executableFile(candidate)) return candidate;
    }
  }
  return undefined;
}

/** Чем звать .ps1: обёртки написаны под PowerShell 5.1, поэтому pwsh (7) — предпочтительно, но не обязателен. */
function psRunner() {
  if (!IS_WIN) return ["pwsh", "-NoProfile", "-File"];
  const pwsh = whichTool("pwsh");
  if (pwsh && toolUsable(pwsh)) return [pwsh, "-NoProfile", "-File"];
  if (whichTool("powershell")) return ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File"];
  return undefined;
}

/**
 * Настоящий bash: Git for Windows (или явный указатель), и никогда — заглушка WSL. Проверка делом:
 * кандидат обязан ответить версией GNU bash. Заглушка печатает инструкцию и выходит с нулём — не ответ.
 */
let bashResolution;
function resolveBash() {
  if (bashResolution !== undefined) return bashResolution;
  if (!IS_WIN) {
    bashResolution = { path: "bash" };
    return bashResolution;
  }
  const candidates = [
    process.env.AGGG_BASH,
    process.env.CENTER_BASH,
    join(process.env.ProgramFiles ?? "C:\\Program Files", "Git/bin/bash.exe"),
    join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Git/bin/bash.exe"),
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Programs/Git/bin/bash.exe") : undefined,
    whichTool("bash", { skipWindowsApps: true }),
  ].filter(Boolean);
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["--version"], { encoding: "utf8", timeout: 15_000 });
    if (!probe.error && probe.status === 0 && /GNU bash/i.test(String(probe.stdout ?? ""))) {
      bashResolution = { path: candidate };
      return bashResolution;
    }
  }
  bashResolution = {
    error: "нет настоящего bash: заглушка WSL не годится (другой $HOME и другой корень диска) — поставь Git for Windows (winget install Git.Git) или задай AGGG_BASH",
  };
  return bashResolution;
}

/** Запуск .sh: на Unix — bash из PATH, на Windows — только настоящий Git Bash, иначе честный отказ. */
function bashRunner(path) {
  const bash = resolveBash();
  if (bash.error) throw new Error(bash.error);
  return [bash.path, path];
}

/**
 * На Windows .cmd/.bat нельзя запустить напрямую (node отказывается: EINVAL), их берёт cmd.exe.
 * Через shell: true не ходим — кавычки в путях с пробелами тогда ломаются молча.
 */
function spawnArgv(argv) {
  const [file, ...args] = argv;
  if (IS_WIN && /\.(cmd|bat)$/i.test(file)) return ["cmd.exe", "/c", file, ...args];
  return argv;
}

/** Путь короче для глаза: домашний каталог — как `~` (в конфигах клиентов он так и записан). */
function under(path, root) {
  for (const sep of ["/", "\\"]) {
    if (path.startsWith(`${root}${sep}`)) return path.slice(root.length + 1);
  }
  return undefined;
}

function usage() {
  process.stdout.write(`command-center — центр координации проектов на диске

  center status [--json] [--strict]  что с каждым проектом: файлы, git, тесты, ссылки;
                                    --strict также требует активные таймеры
  center ps [--json]            кто что держит сейчас: серверы MCP, браузеры, прогоны, тесты, клиенты
  center logs <проект> [--tail N]  где лежат логи проекта и их хвост (нет своих — говорит, где смотреть)
  center doctor                 проверить связи: симлинки, MCP-регистрации, целостность каталогов
  center verify [имена…]        живая проверка MCP: стоят ли харнессы и отвечают ли серверы (все три среды)
  center links                  карта связей: кто кого питает
  center run <проект> [...арг]  позвать проект его же командой
  center activate [имена|all]   активировать: поставить скиллы, расширения, MCP
  center outdated [--json]      что устарело: зовёт объявленные сверки проектов и сводит ответ
  center update [имена|all]     обновить проекты их же командами, потом перепроверить связи
  center version [--json]       из чего складывается версия набора и как её бампают
  center prereqs                что должно стоять в системе до всего остального
  center bootstrap              план установки с нуля на новой машине
  center fresh [--yes] [--deep] [--no-cleanup] снос и сразу установка: одна команда на «поставить начисто»;
                                --no-cleanup — заселение на занятую машину: ставит рядом, ничего не снимая
  center docs [тема] [--path]   документация системы: индекс, тема целиком или путь к файлу
  center backup --to <путь> [--keep N]  бэкап набора (tar.zst, рядом .sha256), старые — по --keep
  center restore --from <архив|каталог> --to <каталог>  распаковать бэкап в сторону и проверить копию делом
  center check                  прогнать сквозную проверку диска (набор тестов и doctor хаба)
  center release --to <путь>    собрать релиз: чистое дерево, manifest, безопасные исключения

Флаги:
  --dry-run    показать, что будет сделано, и ничего не менять (у activate/update/bootstrap/backup/restore)
  --best-effort  для check: пропустить отсутствующий/незапускаемый docs-gate (полный check так не делает)
  --strict       для status: ненулевой код, если таймеры не установлены/активны
  --allow-dirty  для release: разрешить несохранённые правки и записать их в manifest
  --allow-missing-checksum  для restore: диагностическое восстановление без .sha256
  --allow-missing-docs-gate  для restore: разрешить копию без docs-gate (диагностика)
  --json       машинный вывод там, где он есть (для docs — печатать путь вместо текста)
  --tail N     (logs) сколько строк хвоста показать (по умолчанию ${LOG_TAIL})

Флаги backup:
  --to <путь>        куда положить архив (обязателен); .sha256 ляжет рядом
  --keep N           сколько архивов держать в цели (остальные — старые — удаляются вместе с .sha256)
  --force-same-disk  разрешить цель на том же устройстве, что и набор: по умолчанию такой бэкап
                     отвергается — «тот же диск — это не бэкап» (сравниваются st_dev цели и набора)

Флаги restore:
  --from <архив|каталог>  откуда брать: файл архива или каталог цели (возьмётся самый свежий AGGG-*)
  --to <каталог>          куда распаковывать: каталог должен быть пустым или ещё не существовать;
                          путь внутрь живого набора отвергается — восстановление идёт в сторону

Флаги verify:
  --timeout СЕК  сколько секунд ждать ответа сервера (по умолчанию ${VERIFY_TIMEOUT})
  --client К     какую среду проверять: omp|pi|opencode|all (по умолчанию all)
  --exclude a,b  пропустить серверы по имени (тяжёлые поднимают браузер: playwright, chrome-devtools,
                 stealth-browser, camoufox) — проверка не бесплатна: она спавнит настоящие серверы

Блокировка браузера: браузерных прогонов на машине может быть один за раз, и это правило держит
механизм, а не память агента. Владельца показывает center ps, берёт и снимает — mcp-station verify
перед проверкой браузерных серверов (файл и формат — те же, что у станции):
  файл: ${BROWSER_LOCK}
  TTL:  ${Math.round(lockTtl() / 60)} мин (CENTER_BROWSER_LOCK_TTL, секунды); протухшую снимает следующий пришедший

«Зарегистрирован ≠ видно в сессии»: если конфиг клиента новее запуска самого клиента, запись в нём есть,
а тулов в текущей сессии нет — verify говорит об этом строкой (session_stale в --json) и зовёт перезапуск.

Команды обновления берутся из реестра (поле update): центр не дублирует установку, а зовёт проект.
Флаг «ничего не менять» центр передаёт только тем, у кого он объявлен в самой команде (см. --dry-run
у update): остальные в плане просто показываются.

doctor и verify — разное: doctor статический, читает конфиги и ссылки и отвечает на вопрос «есть ли
запись в клиенте»; verify живой, поднимает серверы по протоколу MCP и отвечает «работает ли соединение».
Проверяет центр не сам: харнессы — у cli-station (реестр, поле harnessStatus), соединения — у
mcp-station (поле mcpVerify).

Реестр: ${REGISTRY}
`);
}

/**
 * Реестр — источник правды о проектах. Не разобран реестр (пустой файл, правка руками, чужой путь
 * в CENTER_REGISTRY) — центр не знает ничего и говорит это строкой контракта с кодом 1, а не
 * стектрейсом: на новой машине стектрейс не подсказывает, что делать.
 */
function loadProjects() {
  let data;
  try {
    data = JSON.parse(readFileSync(REGISTRY, "utf8"));
  } catch (error) {
    process.stderr.write(`center: реестр не разобран: ${REGISTRY}: ${error.message}\n`);
    process.exit(1);
  }
  if (!Array.isArray(data?.projects)) {
    process.stderr.write(`center: реестр не разобран: ${REGISTRY}: поле projects — не список проектов\n`);
    process.exit(1);
  }
  return data.projects;
}

const projects = loadProjects();

function projectPath(project) {
  const declared = typeof project.path === "string" ? project.path.trim() : "";
  if (!declared) return join(PROJECTS_ROOT, project.name);
  const expanded = expand(declared);
  return isAbsolute(expanded) ? resolve(expanded) : resolve(PROJECTS_ROOT, expanded);
}

// Платформы проекта: реестр либо называет их прямо (поле platforms), либо проект работает везде.
// Так у честно Unix-only станции (fedora-windows-look) на Windows не спрашивают точку входа,
// которой там нет: строка говорит «не поддерживается на этой ОС», и это не ошибка диска.
const ALL_PLATFORMS = ["linux", "darwin", "win32"];

function projectPlatforms(project) {
  const list = project.platforms;
  return Array.isArray(list) && list.length > 0 ? list : ALL_PLATFORMS;
}

function platformSupported(project) {
  return projectPlatforms(project).includes(PLATFORM);
}

/** Честная строка про чужую ОС — одна на весь центр (её же печатают status, run, update). */
function platformNote(platforms) {
  return `не поддерживается на этой ОС (platforms: ${platforms.join(", ")})`;
}

function unsupportedNote(project) {
  return platformNote(projectPlatforms(project));
}

/**
 * Точки входа, объявленные в реестре, — и чья это платформа: run/update/tests принадлежат текущей ОС,
 * runWindows/updateWindows — win32. Раньше doctor смотрел только свою ОС, поэтому несуществующий
 * windows-путь в реестре (у sysprompt был `windows/install.ps1`) никто не замечал: на Linux его
 * просто не спрашивали. Теперь чужая ОС проверяется отдельной строкой.
 */
const ENTRY_FIELDS = [
  { field: "run", platform: null, label: "точка входа" },
  { field: "runWindows", platform: "win32", label: "точка входа (Windows)" },
  { field: "update", platform: null, label: "команда обновления" },
  { field: "updateWindows", platform: "win32", label: "команда обновления (Windows)" },
  { field: "tests", platform: null, label: "набор тестов" },
];

function expand(path) {
  const text = String(path);
  if (text === "~") return HOME;
  if (text.startsWith("~/") || text.startsWith("~\\")) return join(HOME, text.slice(2));
  return text.replaceAll("$HOME", HOME);
}

/**
 * Куда ведёт ссылка — как её поймёт шелл.
 *
 * Смотрим ПЕРВЫЙ симлинк в пути, а не только последний компонент: ссылкой бывает
 * и каталог (`~/.agents/skills/скилл -> коллекция`), и файл внутри него
 * (`.../скилл/SKILL.md -> исходник`). Раньше проверка делала один lstat по
 * указанному пути, поэтому форма с каталогом-ссылкой молча давала undefined и
 * doctor падал на живых, рабочих скиллах (багрепорт 5.1.0, Fedora 44).
 *
 * Выше домашнего каталога не смотрим: системные симлинки (на macOS `/var` →
 * `/private/var`, смонтированные тома) лежат НАД домом и не относятся к решению
 * пользователя ставить скилл ссылкой или копией. Из-за них цепочка до корня
 * ловила системный уровень и копия считалась ссылкой — на Linux с настоящим
 * `/tmp` этого не видно, поэтому баг всплывал только на macOS.
 */
function linkTarget(path) {
  const home = resolve(HOME);
  const chain = [];
  let current = resolve(path);
  while (true) {
    // Выше дома не смотрим: системные симлинки (на macOS /var → /private/var,
    // смонтированные тома) лежат НАД домом и не относятся к решению пользователя
    // ставить ссылкой или копией — из-за них копия считалась ссылкой.
    if (!isPathWithin(home, current, { caseInsensitive: IS_WIN })) break;
    chain.unshift(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const candidate of chain) {
    try {
      if (!lstatSync(candidate).isSymbolicLink()) continue;
      const target = readlinkSync(candidate);
      const absolute = target.startsWith("/") || /^[A-Za-z]:[\\/]/.test(target);
      return absolute ? target : resolve(dirname(candidate), target);
    } catch {
      return undefined; // компонент не существует — ссылки нет
    }
  }
  return undefined;
}

/** Ожидаемые цели ссылки: `into` — имя проекта (строка) или несколько допустимых. */
function expectedTargets(into) {
  return (Array.isArray(into) ? into : [into]).map((name) => {
    try {
      return realpathSync(join(PROJECTS_ROOT, name));
    } catch {
      return join(PROJECTS_ROOT, name);
    }
  });
}

/**
 * Цель ссылки с учётом формы записи: ссылкой бывает сам каталог скилла
 * (`~/.agents/skills/скилл -> коллекция`) или файл внутри него
 * (`.../скилл/SKILL.md -> исходник`). Второй вариант — рабочее состояние
 * (так скиллы подключены на машине разработки), поэтому проверяем и его.
 */
function linkTargetDeep(path) {
  return linkTarget(path) ?? linkTarget(join(path, "SKILL.md"));
}

/**
 * Лежит ли запись на месте — вообще, включая симлинк в никуда.
 * `existsSync` на битой ссылке отвечает «нет», и поломка выглядела бы как невыполненный шаг:
 * разница между «установщик не запускали» и «ссылку сломали» — это ровно то, что надо назвать.
 */
function laysDown(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Ссылка ведёт в одного из ожидаемых хозяев? */
function linkPointsTo(target, into) {
  if (!target) return false;
  try {
    if (!existsSync(target)) return false;
    const real = realpathSync(target);
    return expectedTargets(into).some((expected) => isPathWithin(expected, real, { caseInsensitive: IS_WIN }));
  } catch {
    return false;
  }
}

/** Конфиги MCP у трёх клиентов: у omp и pi — секция mcpServers, у opencode — mcp. */
function mcpClients() {
  return [
    { client: "omp", file: join(HOME, ".omp/agent/mcp.json"), key: "mcpServers" },
    { client: "pi", file: join(HOME, ".pi/agent/mcp.json"), key: "mcpServers" },
    { client: "opencode", file: join(process.env.XDG_CONFIG_HOME || join(HOME, ".config/opencode"), "opencode.json"), key: "mcp" },
  ];
}

/** Что видно в конфиге клиента: серверы (по имени) или причина, по которой их не видно. */
function readMcpServers({ file, key }) {
  if (!existsSync(file)) return { file, servers: {}, error: "конфига нет" };
  try {
    return { file, servers: JSON.parse(readFileSync(file, "utf8"))[key] ?? {}, error: null };
  } catch (error) {
    return { file, servers: {}, error: `не разобрать (${error.message})` };
  }
}

/** Ожидания реестра: какие MCP-серверы проекты ждут в клиентах (поле expectMcp). */
function expectedMcp() {
  return projects.flatMap((project) => (project.expectMcp ?? []).map((server) => ({ server, project: project.name })));
}

function run(argv, timeout = 600_000) {
  const [file, ...args] = spawnArgv(argv);
  const result = spawnSync(file, args, { encoding: "utf8", timeout });
  const out = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  // провал запуска не молчит: «не удалось запустить» вместо пустоты, по которой нечего чинить
  if (result.error && !out) return { code: result.status ?? -1, out: `не удалось запустить ${file}: ${result.error.code ?? result.error.message}` };
  return { code: result.status ?? -1, out };
}

/**
 * Точка входа проекта под текущую платформу: на Windows у каждого .sh есть сосед .ps1 (правило диска, его
 * же проверяет гейт доков). Без этой подстановки `outdated`, `update` и `verify` центра звали бы .sh через
 * bash из PATH — то есть через заглушку WSL, даже когда та же команда руками работает.
 */
function platformEntry(path) {
  if (!IS_WIN || !path.endsWith(".sh")) return path;
  const sibling = path.replace(/\.sh$/, ".ps1");
  return existsSync(sibling) ? sibling : path;
}

/** Чем запускается файл-скрипт: .ps1 — PowerShell (7 или встроенный 5.1), .mjs — node, остальное — bash. */
function scriptRunner(path) {
  if (path.endsWith(".ps1")) {
    const runner = psRunner();
    if (!runner) throw new Error("нет PowerShell: нужен pwsh (7) или powershell.exe (5.1) — на Windows 5.1 уже стоит");
    return [...runner, path];
  }
  if (path.endsWith(".mjs")) return ["node", path];
  return bashRunner(path);
}

/** Готовая команда запуска файла: путь под платформу плюс объявленные аргументы. */
function dispatchArgv(path, args) {
  return [...scriptRunner(platformEntry(path)), ...args];
}

/** Точка входа проекта так, как её зовёт эта ОС: на Windows — своя обёртка (runWindows), иначе unix-скрипт. */
function entryOf(project) {
  return IS_WIN ? project.runWindows ?? project.run : project.run;
}

/** Чем проект активируется и запускается: на Windows — своя обёртка (runWindows), иначе сосед .ps1. */
function runnerFor(project) {
  const entry = IS_WIN ? project.runWindows ?? project.run : project.run;
  if (!entry) return undefined;
  return dispatchArgv(join(projectPath(project), entry), []);
}

/** runnerFor, который не падает: причину, почему точку входа нечем запустить, показываем строкой. */
function tryRunnerFor(project) {
  try {
    return { argv: runnerFor(project) };
  } catch (error) {
    return { problem: error.message };
  }
}

/** Команда проекта из реестра: первое слово — путь от каталога проекта, дальше её аргументы. */
function parseCommand(project, text) {
  const [file, ...args] = String(text).trim().split(/\s+/);
  const path = platformEntry(join(projectPath(project), file));
  return { path, argv: [...scriptRunner(path), ...args] };
}

/** Текст команды: её точка входа и, если это тонкая обёртка, движок, который она запускает. */
function commandText(project, path) {
  const read = (file) => {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return "";
    }
  };
  const own = read(path);
  const texts = [own];
  const wrapper = own.match(/exec\s+node\s+"?([^"\s]+\.mjs)"?/);
  if (wrapper) texts.push(read(join(projectPath(project), wrapper[1].replace(/^\$\{?ROOT\}?\/?/, ""))));
  return texts.join("\n");
}

/**
 * Флаг «ничего не менять» для команды обновления. Запускать её с --help нельзя: у части установщиков
 * (fedora-windows-look/install.sh) он всё равно создаёт ссылки, поэтому читаем текст самой команды и
 * ищем объявленный флаг. Не нашли — проекта в режиме плана только покажем, всерьёз звать не будем.
 */
function dryRunFlag(project, command) {
  if (project.dryRunFlag === "none") return undefined;
  const flag = command.path.endsWith(".ps1") ? "-WhatIf" : project.dryRunFlag ?? "--dry-run";
  const text = commandText(project, command.path);
  const supported = flag === "-WhatIf"
    ? text.includes("-WhatIf") || text.includes("WhatIfPreference") || text.includes("SupportsShouldProcess")
    : text.includes(flag);
  return supported ? flag : undefined;
}

/** Чем проект обновляется сам: на Windows — своя команда (updateWindows), если она объявлена. */
function updateCommand(project) {
  const text = PLATFORM === "win32" ? project.updateWindows : project.update;
  if (!text) return undefined;
  const command = { text, ...parseCommand(project, text) };
  return { ...command, dryRun: dryRunFlag(project, command) };
}

/** Почему проект не обновляется сам — одной строкой: реестр говорит прямо, по умолчанию команды нет. */
function unavailableNote(project) {
  if (!platformSupported(project)) return unsupportedNote(project);
  if (project.update && !updateCommand(project)) {
    return `для платформы ${PLATFORM} команды обновления в реестре нет (unix: ${project.update})`;
  }
  return project.updateNote ?? "не обновляется сам: команды обновления в реестре нет";
}

function firstLine(text) {
  const line = String(text).split("\n").map((row) => row.trim()).find(Boolean) ?? "";
  return line.length > 100 ? `${line.slice(0, 100)}…` : line;
}

function safeJson(text) {
  const trimmed = String(text).trim();
  const inner = trimmed.slice(trimmed.indexOf("{"), trimmed.lastIndexOf("}") + 1);
  for (const candidate of [trimmed, inner]) {
    try {
      return JSON.parse(candidate);
    } catch {
      // пробуем следующий вариант: у части команд перед JSON бывают строки-объяснения
    }
  }
  return undefined;
}

/**
 * Сколько сверок не досчиталось. `unknown` в сводке — это НЕ «изменений нет»: так станция говорит
 * «спросить не вышло» (npm/реестр не ответили, строка осталась без версии). Число там бывает и
 * записанным NaN (в JSON он превращается в null) — это тоже провал сверки, а не ноль.
 */
function unknownCount(summary) {
  const raw = summary.unknown;
  if (raw === undefined) return { asked: false, count: 0 };
  if (raw === null) return { asked: true, count: NaN };
  const value = Number(raw);
  return { asked: true, count: Number.isFinite(value) ? value : NaN };
}

/**
 * Что говорит объявленная сверка проекта (поле outdated реестра): статус по контракту и одна строка
 * почему. Сводка — в формате mcp-station: ненулевое значение любого ключа кроме `current` = устарело,
 * а `unknown` — провал сверки (её нельзя выдать ни за «свежо», ни за «обновить»).
 */
function outdatedStatus(project) {
  let probe;
  try {
    probe = parseCommand(project, project.outdated);
  } catch (error) {
    // команду нечем запустить (нет PowerShell или настоящего bash) — это не «устарело», это причина
    return { status: "unknown", failed: true, detail: `сверку нечем запустить: ${error.message}` };
  }
  const result = run(probe.argv, 120_000);
  const data = safeJson(result.out);
  if (!data?.summary) {
    return { status: "unknown", failed: true, detail: `сверка не разобрана (код ${result.code}): ${firstLine(result.out) || "вывода нет"}` };
  }
  const unknown = unknownCount(data.summary);
  // строки без ответа станция может назвать и в самих записях (status: "unknown"), а в сводку не свести
  const unknownRows = Object.values(data)
    .flatMap((value) => (Array.isArray(value) ? value : []))
    .filter((row) => row && typeof row === "object" && row.status === "unknown").length;
  const missed = Number.isFinite(unknown.count) ? unknown.count : 0;
  if (!Number.isFinite(unknown.count) || missed > 0 || unknownRows > 0) {
    const how = missed > 0 ? `${missed}` : unknownRows > 0 ? `${unknownRows}` : "часть строк";
    return {
      status: "unknown",
      failed: true,
      detail: `сверка не удалась: ${how} без ответа (unknown) — «свежо» это не значит, посмотри причину`,
    };
  }
  const drift = Object.entries(data.summary).filter(([key, count]) => key !== "current" && Number(count) > 0);
  if (drift.length === 0) return { status: "current", detail: "изменений нет" };
  const detail = drift
    .map(([key, count], index) => `${count}${index === 0 && project.outdatedUnit ? ` ${project.outdatedUnit}` : ""} ${key}`)
    .join(", ");
  return { status: "updates", detail };
}

function gitState(path) {
  if (!existsSync(join(path, ".git"))) return undefined;
  const ahead = run(["git", "-C", path, "rev-list", "--count", "@{u}..HEAD"], 30_000);
  const dirty = run(["git", "-C", path, "status", "--short"], 30_000);
  return {
    ahead: ahead.code === 0 ? Number(ahead.out || "0") : null,
    dirty: dirty.code === 0 ? dirty.out.split("\n").filter(Boolean).length : null,
  };
}

/**
 * Строка про обновление проекта: если сверка объявлена (поле outdated), зовём её и берём ответ; если
 * нет — показываем команду обновления или честную причину, почему её нет. Тем же пользуется `outdated`.
 */
function statusUpdate(project) {
  if (!platformSupported(project)) {
    return { command: "", status: "unsupported", label: "не поддерживается", detail: unsupportedNote(project) };
  }
  const command = updateCommand(project);
  if (!project.outdated) {
    if (!command) return { command: "", status: "unknown", label: "не обновляется", detail: unavailableNote(project) };
    return { command: command.text, status: "unknown", label: "без сверки", detail: `машинной сверки устаревания нет (обновление: ${command.text})` };
  }
  const probe = outdatedStatus(project);
  const label = probe.status === "updates" ? "обновить" : probe.status === "current" ? "свежо" : "сверка не удалась";
  return { command: command ? command.text : "", status: probe.status, label, detail: probe.detail };
}

/** Юниты-сторожа центра: что про них спросить у systemd (и что сказать, если спросить не у кого). */
const WATCH_UNITS = [
  { label: "сторож набора", unit: "center-sentinel" },
  { label: "ночной бэкап", unit: "center-backup" },
];

/** Строка цели бэкапа: `path|keep` — формат без пробелов; старый `path keep` пока поддерживается. */
function parseBackupTarget(line) {
  const text = String(line).trim();
  if (!text || text.startsWith("#")) return undefined;
  if (text.includes("|")) {
    const separator = text.indexOf("|");
    const path = text.slice(0, separator).trim();
    const keep = text.slice(separator + 1).trim();
    return { path, keep: keep && /^\d+$/.test(keep) ? Number(keep) : undefined, extra: keep.includes("|") ? "лишние разделители" : "" };
  }
  const [path, keep, ...rest] = text.split(/\s+/);
  return { path, keep: keep && /^\d+$/.test(keep) ? Number(keep) : undefined, extra: rest.length ? rest.join(" ") : "" };
}

/** Файл целей бэкапа: путь и, если указан, свой --keep на строку. Пустые строки и «#» — пропуск. */
function backupTargets(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .map(parseBackupTarget)
    .filter(Boolean);
}

/** Свойства юнита от systemd: Key=Value построчно. Не спросилось — так и говорим, а не выдумываем успех. */
function unitProperties(bin, unit, props) {
  const result = run([bin, "--user", "show", unit, "-p", props.join(",")], 15_000);
  if (result.code !== 0) return { error: firstLine(result.out) || `код ${result.code}` };
  const map = {};
  for (const line of result.out.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) map[line.slice(0, at)] = line.slice(at + 1);
  }
  return { map };
}

/** «Tue 2026-09-22 23:16:03 EEST» → «23:16:03»: в строке статуса нужен момент, а не полная дата. */
function shortTime(text) {
  const found = /(\d{2}:\d{2}:\d{2})/.exec(text ?? "");
  return found ? found[1] : "";
}

/**
 * Сторожа: есть ли их юниты, включены ли таймеры и чем кончился последний прогон. Ответ берётся
 * у systemd, а не из памяти о том, «как ставили»: без этой строки отвалившийся таймер видно только
 * в журнале, куда никто не смотрит. Где системы юнитов нет (Windows, macOS) — это тоже строка,
 * а не молчаливое «всё хорошо».
 */
function watchReport() {
  const lines = [];
  if (PLATFORM !== "linux") {
    const hand = PLATFORM === "win32" ? "bin/sentinel.ps1" : "bin/sentinel.sh";
    lines.push({ label: "сторожа", ok: true, text: `юнитов нет: на ${PLATFORM} сторож и бэкап запускаются руками — ${hand} и center backup` });
    return lines;
  }
  const systemctl = whichTool("systemctl");
  if (!systemctl) {
    lines.push({ label: "сторожа", ok: false, text: "systemctl не найден: про юниты спросить нечем — сторож и бэкап идут руками" });
    return lines;
  }
  const configHome = process.env.XDG_CONFIG_HOME ? resolve(process.env.XDG_CONFIG_HOME) : join(HOME, ".config");
  const unitsDir = join(configHome, "systemd/user");
  const targetFile = join(configHome, "center/backup.target");
  const targets = backupTargets(targetFile);
  for (const { label, unit } of WATCH_UNITS) {
    const service = join(unitsDir, `${unit}.service`);
    const timer = join(unitsDir, `${unit}.timer`);
    const noTarget = unit === "center-backup" && targets.length === 0;
    if (!existsSync(service) || !existsSync(timer)) {
      const why = noTarget ? ` — цели бэкапа нет: положи путь в ${shownPath(targetFile)} (по строке на цель)` : "";
      lines.push({ label, ok: false, text: `юнита нет: поставь bash ${shownPath(join(ROOT, "contrib/install-units.sh"))}${why}` });
      continue;
    }
    if (noTarget) {
      lines.push({ label, ok: false, text: `юнит есть, а цели бэкапа нет — положи путь в ${shownPath(targetFile)}, иначе бэкап падает` });
      continue;
    }
    const timerInfo = unitProperties(systemctl, `${unit}.timer`, ["UnitFileState", "ActiveState", "LastTriggerUSec"]);
    if (timerInfo.error) {
      lines.push({ label, ok: false, text: `про юнит не спросить: ${timerInfo.error}` });
      continue;
    }
    const enabled = timerInfo.map.UnitFileState === "enabled" || existsSync(join(unitsDir, "timers.target.wants", `${unit}.timer`));
    if (!enabled) {
      lines.push({ label, ok: false, text: `юнит есть, но не включён — поставь: systemctl --user enable --now ${unit}.timer` });
      continue;
    }
    const serviceInfo = unitProperties(systemctl, `${unit}.service`, ["Result", "ExecMainExitTimestamp"]);
    const lastTime = shortTime(serviceInfo.error ? "" : serviceInfo.map.ExecMainExitTimestamp);
    const fired = shortTime(timerInfo.map.LastTriggerUSec);
    if (serviceInfo.error) {
      lines.push({ label, ok: false, text: `таймер включён (${timerInfo.map.ActiveState}), а про последний прогон не спросить: ${serviceInfo.error}` });
      continue;
    }
    const result = serviceInfo.map.Result || "статуса нет";
    // Таймер и сервис — две разные вещи, и путать их нельзя: запуск вручную не делает таймер
    // отработавшим. Строка «ещё ни разу не срабатывал, прогон … success» выглядела как враньё,
    // хотя обе половины были правдой про разные объекты — человек из этого не понимал ничего.
    const byTimer = fired ? `запускался таймером ${fired}` : "таймер ещё не срабатывал";
    const byHand = !fired && lastTime ? "запускали вручную" : "";
    const parts = [`юнит включён, таймер ${timerInfo.map.ActiveState === "active" ? "идёт" : timerInfo.map.ActiveState}`, byTimer, byHand, lastTime ? `последний прогон ${lastTime} — ${result}` : ""];
    if (unit === "center-backup") parts.push(`целей ${targets.length}`);
    const ok = result === "success" || (result === "статуса нет" && !lastTime);
    lines.push({ label, ok, text: parts.filter(Boolean).join(", ") + (ok ? "" : `: смотри journalctl --user -u ${unit} -n 20`) });
  }
  return lines;
}

function cmdStatus(asJson, strict = false) {
  const clients = mcpClients().map((client) => ({ client: client.client, ...readMcpServers(client) }));
  const rows = projects.map((project) => {
    const path = projectPath(project);
    const exists = existsSync(path);
    const entry = entryOf(project);
    const entryExists = exists && (!entry || existsSync(join(path, entry)));
    const tests = project.tests ? existsSync(join(path, project.tests)) : false;
    const links = (project.expectLinks ?? []).map(({ link, into, allowCopy }) => {
      const expanded = expand(link);
      const target = linkTargetDeep(expanded);
      const points = linkPointsTo(target, into);
      const copy = Boolean(allowCopy) && !target && existsSync(expanded);
      return { link: expanded, ok: points || copy, copy };
    });
    const mcp = (project.expectMcp ?? []).map((server) => ({
      server,
      clients: clients.filter((entry) => Object.hasOwn(entry.servers, server)).map((entry) => entry.client),
    }));
    const update = statusUpdate(project);
    return { name: project.name, kind: project.kind, optional: Boolean(project.optional), platforms: projectPlatforms(project), supported: platformSupported(project), exists, entryExists, tests, git: exists ? gitState(path) : undefined, links, mcp, update };
  });

  const broken = rows.filter((row) => !row.exists || !row.entryExists);
  const mandatories = broken.filter((row) => !projects.find((p) => p.name === row.name)?.optional);
  const watch = watchReport();
  if (asJson) {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    return mandatories.length === 0 && (!strict || watch.every((line) => line.ok)) ? 0 : 1;
  }

  process.stdout.write(`диск: ${ROOT}\nплатформа: ${PLATFORM}\n\n`);
  for (const { name, kind, exists, entryExists, tests, git, links, mcp, update, supported, platforms } of rows) {
    const bits = !supported
      ? [platformNote(platforms)]
      : [
          exists ? "есть" : "НЕТ",
          entryExists ? "" : "нет точки входа",
          tests ? "тесты" : "",
          git ? `git ${git.dirty ?? "?"}Δ${git.ahead ? ` +${git.ahead}` : ""}` : "",
          links.length ? `ссылки ${links.filter((l) => l.ok).length}/${links.length}` : "",
          mcp.length ? `mcp ${mcp.map(({ clients: have }) => `${have.length}/${clients.length}`).join(", ")}` : "",
          update.label === "обновить" ? `↻ обновить (${update.detail})` : update.label === "свежо" ? "обновлено" : update.label === "сверка не удалась" ? `↻ ${update.detail}` : "",
          platforms.length < ALL_PLATFORMS.length ? `только ${platforms.join("/")}` : "",
        ].filter(Boolean);
    process.stdout.write(`${name.padEnd(20)} ${(kind ?? "").padEnd(9)} ${bits.join(", ")}\n`);
  }
  const optionalMissing = broken.filter((row) => projects.find((p) => p.name === row.name)?.optional).length;
  const versionFile = join(PROJECTS_ROOT, "VERSION");
  const version = existsSync(versionFile) ? readFileSync(versionFile, "utf8").trim() : "";
  process.stdout.write(`\nвсего проектов: ${rows.length}, проблемных: ${mandatories.length}${optionalMissing ? `, необязательных нет: ${optionalMissing}` : ""}${version ? `, версия набора: ${version}` : ""}\n`);
  process.stdout.write(`обновление: команда есть у ${rows.filter((row) => row.update.command).length} проектов, машинная сверка у ${projects.filter((project) => project.outdated).length} — что устарело: center outdated, обновить: center update, из чего версия: center version\n`);
  process.stdout.write(`\nсторожа (то, что лежит вне набора и сторожит его из дома):\n`);
  for (const line of watch) process.stdout.write(`  ${line.ok ? "ok  " : "нет "} ${line.label.padEnd(14)} ${line.text}\n`);
  return mandatories.length === 0 && (!strict || watch.every((line) => line.ok)) ? 0 : 1;
}

/**
 * Проверка связей. Тем же кодом пользуется `update`: после обновления связи перепроверяются этим же
 * doctor, а не второй проверкой рядом.
 */
function doctorRun() {
  const lines = [];
  let problems = 0;
  const say = (ok, text) => {
    lines.push(`${ok ? "ok  " : "FAIL"} ${text}`);
    if (!ok) problems += 1;
  };

  for (const project of projects) {
    const path = projectPath(project);
    if (!platformSupported(project)) {
      lines.push(`—    ${project.name}: ${unsupportedNote(project)}`);
      continue;
    }
    if (!existsSync(path) && project.optional) {
      lines.push(`—    ${project.name}: нет (необязательный, данные машины)`);
      continue;
    }
    say(existsSync(path), `${project.name}: каталог на месте`);
    if (existsSync(path)) {
      for (const { field, platform, label } of ENTRY_FIELDS) {
        const declared = project[field];
        if (!declared) continue;
        const file = String(declared).trim().split(/\s+/)[0];
        if (!file || file.startsWith("-")) continue;
        const owner = platform ?? PLATFORM;
        // проект, которого на этой ОС нет, не обязан иметь её точек входа: реестр говорит platforms
        if (!projectPlatforms(project).includes(owner)) continue;
        const present = existsSync(join(path, file));
        if (owner === PLATFORM) say(present, `${project.name}: ${label} ${file}`);
        // чужая ОС: файла нет — реестр обещает то, чего на диске не лежит, и это видно отдельной строкой
        else if (!present) say(false, `${project.name}: ${label} ${file} — объявлено для ${owner}, файла нет`);
      }
    }
    if (project.expectLinks) {
      for (const { link, into, allowCopy, separate } of project.expectLinks) {
        const expanded = expand(link);
        const target = linkTargetDeep(expanded);
        const who = (Array.isArray(into) ? into : [into]).join("|");
        if (linkPointsTo(target, into)) {
          say(true, `${expanded} → ${who}`);
        } else if (allowCopy && !target && existsSync(expanded)) {
          // установщик положил копию, а не ссылку — это рабочее состояние, но не то,
          // что ждёт реестр: показываем нейтрально, проблемой не считаем
          say(true, `${expanded} → ${who} (копия, не ссылка)`);
        } else if (separate && !laysDown(expanded)) {
          // реестр сам объясняет, почему файла нет: это ставит другой установщик, а не fresh.
          // «Не существует вообще» — невыполненный шаг, а не поломка связей. Лежит хоть битая
          // или чужая запись — это уже поломка, и сюда такое не попадает: ложим через lstat,
          // который видит и симлинк в никуда, в отличие от existsSync.
          lines.push(`—    ${expanded} → ${who} (нет: ${separate})`);
        } else {
          say(false, `${expanded} → ${who}`);
        }
      }
    }
  }

  // MCP-регистрации: чем ходят клиенты и живы ли пути
  const clients = mcpClients().map((client) => ({ client: client.client, ...readMcpServers(client) }));
  for (const { file, servers, error } of clients) {
    if (error) {
      say(false, `${file}: ${error}`);
      continue;
    }
    say(Object.keys(servers).length > 0, `${file}: серверов ${Object.keys(servers).length}`);
  }

  // Ожидания реестра (expectMcp): у кого из клиентов сервер есть. Регистрирует mcp-station, у неё
  // свой check, поэтому отсутствие здесь — справка, а не проблема doctor: код возврата не меняется.
  const expected = expectedMcp();
  if (expected.length) {
    lines.push(`MCP-ожидания реестра (ставит mcp-station install):`);
    for (const { server, project } of expected) {
      const have = clients.filter((entry) => Object.hasOwn(entry.servers, server)).map((entry) => entry.client);
      const miss = clients.filter((entry) => !Object.hasOwn(entry.servers, server)).map((entry) => entry.client);
      lines.push(`—    ${server} (${project}): есть у ${have.length ? have.join(", ") : "никого"}${miss.length ? `; нет у ${miss.join(", ")}` : ""}`);
    }
  }

  lines.push("");
  lines.push(problems === 0 ? "doctor: связи в порядке" : `doctor: проблем ${problems}`);
  return { problems, code: problems === 0 ? 0 : 1, text: lines.join("\n") };
}

function cmdDoctor() {
  const report = doctorRun();
  process.stdout.write(`${report.text}\n`);
  return report.code;
}

/** Проект, объявивший поле реестра (например, команду живой проверки): реестр знает, кто это умеет. */
function projectDeclaring(field) {
  const project = projects.find((item) => item[field]);
  if (!project) throw new Error(`в реестре никто не объявил поле ${field}`);
  return project;
}

/**
 * Команда живой проверки из реестра: точка входа проекта (на Windows — его обёртка) плюс объявленная
 * подкоманда. Флаги (--timeout/--client/--exclude) добавляет центр — проект их не знает.
 */
function probeCommand(field, args) {
  const project = projectDeclaring(field);
  const entry = PLATFORM === "win32" ? project.runWindows ?? project.run : project.run;
  if (!entry) throw new Error(`у ${project.name} нет команды запуска в реестре`);
  return parseCommand(project, [entry, project[field], ...args].join(" "));
}

/**
 * Харнессы: спрашиваем cli-station (её `status --json` уже отдаёт name/installed/version) — центр не
 * изобретает свою проверку установки, а берёт готовую и сводит к полям контракта.
 */
function harnessProbe() {
  let probe;
  try {
    probe = probeCommand("harnessStatus", []);
  } catch (error) {
    return { harness: [], error: `cli-station status нечем запустить: ${error.message}` };
  }
  const result = run(probe.argv, 120_000);
  const data = safeJson(result.out);
  if (!Array.isArray(data)) {
    return { harness: [], error: `cli-station status не разобран (код ${result.code}): ${firstLine(result.out)}` };
  }
  const harness = data.map(({ name, installed, version }) => ({ name, installed: Boolean(installed), version: version ?? "" }));
  return { harness, error: null };
}

/** Путь короче для глаза: домашний каталог — как `~` (в конфигах клиентов он так и записан). */
function tildify(path) {
  const rest = under(path, HOME);
  return rest === undefined ? path : `~${IS_WIN ? "\\" : "/"}${rest}`;
}

/**
 * Живые соединения: зовём mcp-station verify — она одна спавнит серверы и говорит по протоколу,
 * отвечает ли каждый. Центр сам не спавнит ничего: он только сводит её отчёт по клиентам.
 */
function mcpProbe({ timeout, client, exclude, servers }) {
  const args = ["--timeout", String(timeout), "--client", client];
  if (exclude) args.push("--exclude", exclude);
  let probe;
  try {
    probe = probeCommand("mcpVerify", [...args, ...servers]);
  } catch (error) {
    return { clients: [], error: `mcp-station verify нечем запустить: ${error.message}` };
  }
  // серверов бывает много и часть тяжёлая: даём станции время на все — она ждёт каждый свой таймаут
  const result = run(probe.argv, Math.max(180_000, (timeout + 20) * 1000 * 8));
  const data = safeJson(result.out);
  const entries = Array.isArray(data?.clients) ? data.clients : [];
  if (entries.length === 0) {
    // станция умеет отказать до запуска (например, браузер занят): её причину берём как есть
    return {
      clients: [],
      error: data?.error
        ? `mcp-station verify: ${data.error}`
        : `mcp-station verify не разобран (код ${result.code}): ${firstLine(result.out)}`,
    };
  }
  const clients = entries.map((entry) => {
    const list = Array.isArray(entry.servers) ? entry.servers : [];
    // Станция помечает записи полем `ours`: своя упала — наш провал, чужая (сервер покупателя,
    // запись чужого установщика) — не наш. Старая станция поля не отдаёт: тогда считаем как раньше,
    // всякий провал наш — совместимость важнее новой точности.
    const oursList = list.filter((server) => server.ours !== false);
    const badOurs = oursList.filter((server) => server.state !== "connected");
    const foreign = list.filter((server) => server.ours === false && server.state !== "connected");
    return {
      client: entry.client,
      file: entry.file ?? "",
      connected: oursList.length - badOurs.length,
      total: oursList.length,
      failed: badOurs.length,
      foreign_failed: foreign.length,
      failures: badOurs.map((server) => ({ name: server.name, state: server.state, ms: server.ms, error: server.error ?? "" })),
      foreign_failures: foreign.map((server) => ({ name: server.name, state: server.state, ms: server.ms, error: server.error ?? "" })),
    };
  });
  // Состояние станции не прочитать — она считала «своё» по каталогу; центр говорит это же строкой
  const owners = entries.some((entry) => entry.owners === "catalog") ? "catalog" : undefined;
  return { clients, error: null, ...(owners ? { owners } : {}) };
}

/**
 * Живая проверка MCP: «стоят ли харнессы и отвечают ли серверы по протоколу» во всех трёх средах.
 *
 * Отличие от doctor: doctor статический — читает конфиги и ссылки и говорит, ЕСТЬ ли запись;
 * verify поднимает настоящие серверы и говорит, РАБОТАЕТ ли соединение (это долго и не бесплатно).
 * Центр не дублирует проверку: харнессы берёт у cli-station (поле реестра harnessStatus), соединения —
 * у mcp-station (поле mcpVerify). Код возврата 1, если харнесса нет или не ответила наша запись;
 * чужие записи клиента (поле `ours: false` от станции) считаются отдельно — `foreign_failed`.
 */
function cmdVerify(flags) {
  const timeout = flags.timeout === null ? VERIFY_TIMEOUT : Number(flags.timeout);
  if (!Number.isInteger(timeout) || timeout <= 0) throw new Error(`--timeout: нужно целое число секунд, а не «${flags.timeout}»`);
  const client = flags.client ?? "all";
  const clients = ["omp", "pi", "opencode", "all"];
  if (!clients.includes(client)) throw new Error(`--client: неизвестная среда ${client} (есть: ${clients.join(", ")})`);

  const harness = harnessProbe();
  const probe = mcpProbe({ timeout, client, exclude: flags.exclude, servers: flags.servers });
  // «зарегистрирован ≠ видно в сессии»: конфиг новее запуска клиента — новые тулы в текущей сессии не видны.
  // Процесса клиента нет — поля нет вовсе: «не знаю» честнее выдумки.
  const sessions = clientSessions()
    .filter((session) => client === "all" || session.client === client)
    .map((session) => ({ client: session.client, verdict: sessionStale(session) }));
  const stale = sessions.filter((session) => session.verdict).map((session) => ({ client: session.client, ...session.verdict }));
  const mcp = {};
  for (const entry of probe.clients) {
    const verdict = sessions.find((session) => session.client === entry.client)?.verdict;
    mcp[entry.client] = {
      connected: entry.connected,
      failed: entry.failed,
      foreign_failed: entry.foreign_failed,
      ...(verdict === null || verdict === undefined ? {} : { session_stale: Boolean(verdict) }),
    };
  }
  const foreignFailures = probe.clients.flatMap((entry) => entry.foreign_failures.map((failure) => ({ client: entry.client, ...failure })));
  const summary = {
    harness_missing: harness.harness.filter((item) => !item.installed).length,
    servers_failed: Object.values(mcp).reduce((sum, item) => sum + item.failed, 0),
    foreign_failed: foreignFailures.length,
    sessions_stale: stale.length,
  };
  // проверку не удалось провести — это не «всё хорошо»: говорим прямо, а не показываем нули
  const error = [harness.error, probe.error].filter(Boolean).join("; ");
  const ok = !error && summary.harness_missing === 0 && summary.servers_failed === 0;

  if (flags.json) {
    const report = {
      ok,
      harness: harness.harness,
      mcp,
      summary,
      ...(foreignFailures.length ? { foreign_failures: foreignFailures } : {}),
      ...(probe.owners === undefined ? {} : { owners: probe.owners }),
      ...(stale.length ? { sessions: stale } : {}),
      ...(error ? { error } : {}),
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return ok ? 0 : 1;
  }

  process.stdout.write(`проверка MCP: спавнит настоящие серверы — часть тяжёлая (playwright, chrome-devtools, stealth-browser, camoufox поднимают браузер); таймаут ${timeout} с\n`);
  const harnesses = harness.harness.map((item) => `${item.name} ${item.installed ? `(${item.version || "версия неизвестна"})` : "— НЕТ"}`);
  process.stdout.write(`харнессы: ${harnesses.length ? harnesses.join(" · ") : "не спросить"}\n`);
  for (const entry of probe.clients) {
    process.stdout.write(`${entry.client.padEnd(9)} ${tildify(entry.file).padEnd(42)} connected ${entry.connected}/${entry.total}${stale.some((session) => session.client === entry.client) ? "  запись новее запуска" : ""}\n`);
  }
  // зарегистрировать запись мало: клиент, стартовавший до её правки, показывает старый список тулов
  for (const session of stale) {
    process.stdout.write(`${session.client}: запись новее запуска клиента (процесс с ${session.since}, конфиг правлен ${session.modified}, pid ${session.pid}): ${STALE_HINT}\n`);
  }
  const failures = probe.clients.flatMap((entry) => entry.failures.map((failure) => ({ ...failure, client: entry.client })));
  if (failures.length) {
    process.stdout.write(`провалы:\n`);
    for (const { client: who, name, state, ms, error: why } of failures) {
      process.stdout.write(`  ${who}/${name} — ${state}${Number.isFinite(ms) ? ` (${ms} мс)` : ""}: ${why || "без объяснения"}\n`);
    }
  }
  const totals = probe.clients.reduce((acc, entry) => ({ connected: acc.connected + entry.connected, total: acc.total + entry.total }), { connected: 0, total: 0 });
  process.stdout.write(`итог: серверов ${totals.total}, connected ${totals.connected}, провалов ${summary.servers_failed}, харнессов не хватает ${summary.harness_missing}\n`);
  // Чужие записи — не наши провалы: покупатель завёл их сам, и пугать его кодом 1 не за что
  if (summary.foreign_failed) {
    for (const { client: who, name, state } of foreignFailures) {
      process.stdout.write(`чужое, не считаем: ${who}/${name} — ${state}\n`);
    }
  }
  if (probe.owners === "catalog") process.stdout.write(`принадлежность записей — по каталогу: состояние станции не прочитать (подробности: mcp-station verify)\n`);
  if (error) process.stdout.write(`проверка не удалась: ${error}\n`);
  return ok ? 0 : 1;
}

// ---------------------------------------------------------------- кто что держит: процессы, блокировка, логи

/**
 * Рантайм центра: состояние, дампы и блокировка браузера. Блокировка лежит здесь, а не на диске данных:
 * она про эту машину и этот момент, переезжать вместе с диском ей незачем.
 * Путь и формат заморожены контрактом — тот же файл читает mcp-station (`verify` берёт блокировку перед
 * проверкой браузерных серверов), поэтому формат простой: строки KEY=VALUE (читают node, bash и pwsh).
 */
const STATE_DIR = process.env.CENTER_STATE_DIR ? resolve(process.env.CENTER_STATE_DIR) : join(HOME, ".local/state/command-center");
const BROWSER_LOCK = process.env.CENTER_BROWSER_LOCK ? resolve(process.env.CENTER_BROWSER_LOCK) : join(STATE_DIR, "browser.lock");
/** Сколько живёт блокировка без обновления: старше — протухшая, её снимает тот, кто пришёл следующим. */
const LOCK_TTL = 1800;
/** Сколько строк хвоста показывать у логов по умолчанию. */
const LOG_TAIL = 40;
const SELF_PID = process.pid;
/** Откуда берём процессы: /proc на Linux. CENTER_PROC_ROOT — хук для тестов (свой снимок процессов). */
const PROC_ROOT = process.env.CENTER_PROC_ROOT ? resolve(process.env.CENTER_PROC_ROOT) : "/proc";

/** TTL блокировки: настраиваемый (CENTER_BROWSER_LOCK_TTL, секунды), по умолчанию 30 минут. */
function lockTtl() {
  const value = Number(process.env.CENTER_BROWSER_LOCK_TTL);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : LOCK_TTL;
}

/** Время для глаза: день.месяц часы:минуты:секунды по местным часам. */
function timeText(ms) {
  if (!Number.isFinite(ms)) return "?";
  const at = new Date(ms);
  const two = (value) => String(value).padStart(2, "0");
  return `${two(at.getDate())}.${two(at.getMonth() + 1)} ${two(at.getHours())}:${two(at.getMinutes())}:${two(at.getSeconds())}`;
}

/** Жив ли процесс. Unix — сигнал 0 (без внешних команд), Windows — tasklist по pid. */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (PLATFORM === "win32") {
    const found = run(["tasklist", "/FI", `PID eq ${pid}`, "/NH"], 20_000);
    return found.code === 0 && found.out.includes(String(pid));
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM"; // чужой процесс: он жив, просто сигналы нам не разрешены
  }
}

/** Что записано в блокировке. Пустой или битый файл — это «блокировки нет»: владельца не выдумываем. */
function readLock() {
  if (!existsSync(BROWSER_LOCK)) return null;
  const fields = {};
  for (const line of readFileSync(BROWSER_LOCK, "utf8").split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) fields[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  const pid = Number(fields.pid);
  return {
    pid: Number.isInteger(pid) && pid > 0 ? pid : null,
    owner: fields.owner ?? "",
    run: fields.run ?? "",
    started: fields.started ?? "",
    ttl: Number(fields.ttl) > 0 ? Number(fields.ttl) : lockTtl(),
  };
}

/**
 * Состояние блокировки: свободна, держится живым владельцем (held) или протухла (stale).
 * Протухшая — мёртвый pid или возраст больше TTL: её снимет следующий пришедший, и скажет об этом.
 */
function lockState() {
  const lock = readLock();
  if (!lock) return { state: "free", lock: null, path: BROWSER_LOCK };
  const startedAt = Date.parse(lock.started);
  const ageSeconds = Number.isFinite(startedAt) ? Math.round((Date.now() - startedAt) / 1000) : null;
  const alive = lock.pid !== null && pidAlive(lock.pid);
  const old = ageSeconds !== null && ageSeconds > lock.ttl;
  const why = !alive ? `pid ${lock.pid ?? "?"} не жив` : old ? `старше TTL (${Math.round(lock.ttl / 60)} мин)` : "";
  return { state: why ? "stale" : "held", lock, ageSeconds, why, path: BROWSER_LOCK };
}

/** Владелец блокировки одной строкой: кто её взял и чем занят. */
function lockOwnerText(lock) {
  const who = lock.owner || "неизвестный владелец";
  return lock.run ? `${who} (${lock.run})` : who;
}

/** Строка про блокировку браузера для глаза: свободна / занята / протухла. */
function lockLine(info) {
  const path = tildify(BROWSER_LOCK);
  if (info.state === "free") return `блокировка браузера: свободна (${path})`;
  const lock = info.lock;
  const startedAt = Date.parse(lock.started);
  const since = timeText(startedAt);
  const until = Number.isFinite(startedAt) ? timeText(startedAt + lock.ttl * 1000) : "?";
  if (info.state === "held") {
    return `блокировка браузера: занята — ${lockOwnerText(lock)}, pid ${lock.pid ?? "?"} с ${since} (TTL до ${until}); снять принудительно: rm ${path}`;
  }
  return `блокировка браузера: протухла (${info.why}) — файл ${path}, снимется при следующем verify`;
}

/** Блокировка машинным видом: тот же смысл, но без форматирования для глаза. */
function lockReport(info) {
  if (info.state === "free") return { state: "free", path: BROWSER_LOCK };
  const startedAt = Date.parse(info.lock.started);
  return {
    state: info.state,
    path: BROWSER_LOCK,
    owner: info.lock.owner,
    run: info.lock.run,
    pid: info.lock.pid,
    started: Number.isFinite(startedAt) ? new Date(startedAt).toISOString() : null,
    ttl: info.lock.ttl,
    age_seconds: info.ageSeconds,
    ...(info.why ? { reason: info.why } : {}),
  };
}

/** Тики часов в секунду: в них считается время старта в /proc/stat (getconf есть на любом Linux). */
function clockTicks() {
  const probe = run(["getconf", "CLK_TCK"], 10_000);
  const value = Number(probe.out.trim());
  return Number.isFinite(value) && value > 0 ? value : 100;
}

/**
 * Процессы Linux одним снимком: pid, родитель, время старта и командная строка. Читаем /proc сами —
 * внешние ps/pgrep на разных машинах разные, а раскладка /proc одна и даёт точное время старта.
 * Ядерные потоки пропускаем: у них пустая командная строка, показывать человеку нечего.
 */
function procSnapshot() {
  const hz = clockTicks();
  const stat = readFileSync(join(PROC_ROOT, "stat"), "utf8");
  const btime = /^btime\s+(\d+)/m.exec(stat);
  const boot = btime
    ? Number(btime[1]) * 1000
    : Date.now() - Number(readFileSync(join(PROC_ROOT, "uptime"), "utf8").split(" ")[0]) * 1000;
  const processes = [];
  for (const entry of readdirSync(PROC_ROOT)) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const cmd = readFileSync(join(PROC_ROOT, entry, "cmdline"), "utf8").replaceAll("\0", " ").trim();
      if (!cmd) continue;
      const line = readFileSync(join(PROC_ROOT, entry, "stat"), "utf8");
      // имя процесса бывает со скобками и пробелами: режем по последней закрывающей скобке
      const fields = line.slice(line.lastIndexOf(")") + 2).split(" ");
      const ppid = Number(fields[1]); // 4-е поле stat: родитель
      const ticks = Number(fields[19]); // 22-е поле stat: время старта в тиках после загрузки
      processes.push({
        pid: Number(entry),
        ppid: Number.isInteger(ppid) ? ppid : null,
        started: Number.isFinite(ticks) ? Math.round(boot + (ticks / hz) * 1000) : null,
        cmd,
      });
    } catch {
      // процесс успел умереть между чтениями — его в снимке просто нет
    }
  }
  return { source: tildify(PROC_ROOT), processes };
}

/** Unix без /proc (macOS): тот же снимок через ps — другой раскладки там нет. */
function psSnapshot() {
  const list = run(["ps", "-axo", "pid=,ppid=,lstart=,command="], 20_000);
  if (list.code !== 0) return { source: "ps", processes: [], note: "ps не ответил — процессов не показать" };
  const processes = [];
  for (const line of list.out.split("\n")) {
    const found = /^\s*(\d+)\s+(\d+)\s+(.{24})\s+(.*)$/.exec(line);
    if (!found) continue;
    processes.push({ pid: Number(found[1]), ppid: Number(found[2]), started: Date.parse(found[3]) || null, cmd: found[4].trim() });
  }
  return { source: "ps", processes };
}

/**
 * Процессы машины. На Linux — /proc; на Windows /proc нет вовсе, поэтому честно говорим, что показываем
 * по tasklist (там видны имя и pid, но не время старта и не аргументы) — и почему видно меньше.
 */
function processSnapshot() {
  if (PLATFORM === "win32") {
    const list = run(["tasklist", "/FO", "CSV", "/NH"], 20_000);
    if (list.code !== 0 || !list.out.trim()) {
      return { source: "tasklist", processes: [], note: "нет /proc, а tasklist/Get-CimInstance недоступны — процессов не показать" };
    }
    const processes = list.out
      .split("\n")
      .map((line) => {
        const cells = line.split('","').map((cell) => cell.replace(/^"|"$/g, ""));
        const pid = Number(cells[1]);
        return Number.isInteger(pid) && pid > 0 ? { pid, ppid: null, started: null, cmd: cells[0] ?? "" } : null;
      })
      .filter(Boolean);
    return {
      source: "tasklist",
      processes,
      note: "нет /proc: показываю по tasklist — у этих строк видны только имя и pid (время старта и аргументы там не видны)",
    };
  }
  if (existsSync(join(PROC_ROOT, "stat"))) return procSnapshot();
  return psSnapshot();
}

/** Каталог ли путь: каталог приметой быть не может (слишком широкая), файл — может. */
function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false; // пути нет: это имя пакета или чужой путь — пусть решает сравнение с командной строкой
  }
}

/**
 * Приметы записи клиента: путь к файлу (он и в процессе виден как есть) или имя пакета.
 * Каталог приметой не бывает — иначе `.venvs/camoufox-research` тянул бы к себе и драйвер playwright;
 * служебные слова оболочки (exec, node, set, /dev/null, 2>&1) тоже пропускаем.
 */
function commandTokens(command) {
  const stop = new Set(["exec", "node", "npx", "npm", "bash", "sh", "set", "test", "command", "printf", "export", "true", "false", "-lc", "-y", "-a", "."]);
  const tokens = new Set();
  for (const raw of String(command).split(/\s+/)) {
    const token = raw.replace(/^["'([{]+/, "").replace(/["')\]};,]+$/, "");
    if (token.length < 6 || stop.has(token)) continue;
    if (token.includes("/")) {
      if (!/^[/~$@A-Za-z][\w./@~$-]*$/.test(token)) continue; // >/dev/null, 2>&1 и прочий мусор
      const path = expand(token);
      if (isDirectory(path)) continue;
      tokens.add(path);
      continue;
    }
    if (!/^@?[\w][\w.@-]*$/.test(token)) continue;
    if (token.includes("-")) tokens.add(token); // firecrawl-mcp, @playwright/mcp@latest, basic-memory
  }
  return [...tokens];
}

/** Имена всех наших записей: и те, что стоят в клиентах, и те, что объявлены реестром. */
function knownServers() {
  const names = new Set(projects.flatMap((project) => project.expectMcp ?? []));
  for (const client of mcpClients()) {
    for (const name of Object.keys(readMcpServers(client).servers)) names.add(name);
  }
  return [...names];
}

/**
 * Приметы наших MCP-серверов: имя записи → подстроки, по которым её узнать в списке процессов.
 * Общая примета никого не опознаёт (путь к файлу ключей есть у четырёх записей) — оставляем уникальные.
 */
function mcpMatchers() {
  const serversWith = new Map(); // примета → записи, которые ею опознаются
  const byServer = new Map();
  for (const client of mcpClients()) {
    for (const [name, record] of Object.entries(readMcpServers(client).servers)) {
      const command = record && typeof record === "object" && !Array.isArray(record)
        ? [record.command, ...(Array.isArray(record.args) ? record.args : [])].filter((part) => typeof part === "string").join(" ")
        : "";
      const set = byServer.get(name) ?? new Set();
      for (const token of commandTokens(command)) {
        set.add(token);
        const owners = serversWith.get(token) ?? new Set();
        owners.add(name);
        serversWith.set(token, owners);
      }
      byServer.set(name, set);
    }
  }
  return [...byServer]
    .map(([name, tokens]) => ({ name, tokens: [...tokens].filter((token) => serversWith.get(token)?.size === 1) }))
    .filter((matcher) => matcher.tokens.length > 0);
}

/** Лучшее совпадение процесса с приметами: чем длиннее примета, тем она точнее. */
function bestMatch(cmd, matchers) {
  let best = null;
  for (const matcher of matchers) {
    for (const token of matcher.tokens) {
      if (!cmd.includes(token)) continue;
      if (!best || token.length > best.token.length) best = { name: matcher.name, token };
    }
  }
  return best;
}

/** Как узнаём клиента-агента в списке процессов: opencode (в т.ч. opencode2 и служба), omp, pi. */
function clientOfProcess(cmd) {
  if (/opencode/i.test(cmd)) return "opencode";
  if (/(__omp|oh-my-pi|\/\.omp\/|(^|[\s/])omp([\s/]|$))/i.test(cmd)) return "omp";
  if (/(^|[\s/])pi([\s/]|$)/.test(cmd)) return "pi";
  return null;
}

/** Браузер и его семейство. Дети (рендереры, zygote, -contentproc) не в счёт: показываем сам браузер. */
function browserKind(cmd) {
  if (isBrowserChild(cmd)) return null;
  if (/playwright\/driver|run-driver/.test(cmd)) return null; // это драйвер, а не браузер
  if (/camoufox/i.test(cmd)) return "camoufox";
  // playwright — это семейство браузера, а не процесс playwright-mcp: у браузера есть свой профиль
  if (/playwright[_-]?(chromium|chrome|firefox|webkit)/i.test(cmd) || /playwright_[a-z]*dev_profile/i.test(cmd)) return "playwright";
  if (/(^|[\s/])(chrome|chromium|msedge)([\s"']|$)/i.test(cmd)) return "chrome";
  if (/(^|[\s/])firefox([\s]|$)/i.test(cmd)) return "firefox"; // чужой браузер: показываем как есть
  return null;
}

/** Ребёнок браузера (рендерер, zygote, сетевой или аудио-сервис): сам браузер уже показан отдельной строкой. */
function isBrowserChild(cmd) {
  return /-contentproc|--type=/.test(cmd);
}

/** Драйверы прогонов: чем станции водят браузер и что запускает сами прогоны. */
function driverKind(cmd) {
  if (/playwright\/driver|run-driver/.test(cmd)) return "драйвер playwright";
  if (/camoufox_worker/.test(cmd)) return "драйвер браузера camoufox";
  if (/(mcp_drive|soak_probe|cf_drive)\b/.test(cmd)) return "прогон camoufox";
  return null;
}

/** Тесты: bats и наши прогонщики наборов. */
function isTestRun(cmd) {
  return /(^|[\s/])bats([\s]|$)/.test(cmd) || /run_bats/.test(cmd);
}

/**
 * Проект по файлу приметы: запись нередко указывает на симлинк из ~/.agents (skills-ops → skills-hub,
 * wiki-station, stealth-browser), и настоящий хозяин виден только по реальному пути файла.
 */
function projectOfToken(token) {
  if (!token.includes("/")) return null;
  try {
    return projectByPath(realpathSync(token));
  } catch {
    return null;
  }
}

/** Проект-хозяин по пути в командной строке: длиннейшее совпадение с каталогом проекта из реестра. */
function projectByPath(cmd) {
  let best = null;
  for (const project of projects) {
    const marker = `${PROJECTS_ROOT}/${project.name}`;
    if (!cmd.includes(marker)) continue;
    if (!best || marker.length > best.length) best = project.name;
  }
  return best;
}

/**
 * Имя нашей записи, которое видно в командной строке: по нему находим проект-хозяина процесса.
 * Сначала смотрим на саму программу (первое слово), и только потом на аргументы: у camoufox-bin в
 * аргументах лежит временный профиль playwright, и по аргументам он бы «стал» записью playwright.
 */
function serverNamed(cmd) {
  const hit = (text) =>
    knownServers()
      .filter((name) => new RegExp(`(^|[\\s/])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([\\s/._-]|$)`, "i").test(text))
      .sort((a, b) => b.length - a.length)[0] ?? null;
  return hit(String(cmd).split(/\s+/)[0] ?? "") ?? hit(cmd);
}

/**
 * Проект записи: объявленный в реестре (expectMcp), иначе — каталог mcp-station.
 * Реестр знает хозяев тех серверов, что принадлежат станциям; остальные записи — из каталога станции MCP.
 */
function projectOfServer(name) {
  if (!name) return null;
  const declared = projects.find((project) => (project.expectMcp ?? []).includes(name));
  return declared ? declared.name : "mcp-station";
}

/** Кто ведёт процесс: ближайший по цепочке предков наш MCP-сервер или клиент-агент. */
function heldBy(startPid, index, matchers) {
  let current = startPid;
  const seen = new Set();
  for (let depth = 0; depth < 8 && current; depth += 1) {
    if (seen.has(current)) return null;
    seen.add(current);
    const row = index.get(current);
    if (!row) return null;
    const server = bestMatch(row.cmd, matchers);
    if (server) return { kind: "mcp", name: server.name };
    const client = clientOfProcess(row.cmd);
    if (client) return { kind: "client", name: client };
    current = row.ppid;
  }
  return null;
}

/** Что сказать про владельца строки: клиент, наш сервер — или ничего. */
function ownerText(owner) {
  if (!owner) return "";
  return owner.kind === "client" ? `клиент ${owner.name}` : `MCP ${owner.name}`;
}

const ROLE_ORDER = ["mcp", "browser", "driver", "test", "station", "agent"];
const ROLE_LABEL = { mcp: "MCP-сервер", browser: "браузер", driver: "прогон", test: "тест", station: "станция", agent: "клиент" };

/**
 * Строки `ps`: наши MCP-серверы, браузеры, драйверы прогонов, тесты, движки станций и клиенты.
 * Порядок разбора — от точного к общему: запись из конфига клиента, потом браузер, потом драйвер и т.д.
 * Ни свой процесс, ни рендереры браузеров в отчёт не попадают: это шум, а не ответ на «кто что держит».
 */
function classifyProcesses(processes) {
  const matchers = mcpMatchers();
  const index = new Map(processes.map((row) => [row.pid, row]));
  const rows = [];
  for (const entry of processes) {
    if (entry.pid === SELF_PID || isBrowserChild(entry.cmd)) continue;
    const cmd = entry.cmd;
    const matched = bestMatch(cmd, matchers);
    const browser = browserKind(cmd);
    const driver = driverKind(cmd);
    const byPath = projectByPath(cmd);
    const engine = byPath && /\/bin\/[\w.-]+\.(mjs|sh|ps1|cmd)\b/.test(cmd) ? byPath : null;
    let role;
    let what;
    let owner = null;
    if (matched) {
      role = "mcp";
      owner = heldBy(entry.ppid, index, matchers);
      what = `MCP ${matched.name}${owner && owner.name !== matched.name ? ` (${ownerText(owner)})` : ""}`;
    } else if (driver) {
      // драйвер проверяем раньше браузера: worker camoufox живёт в том же venv, что и сам браузер
      role = "driver";
      owner = heldBy(entry.pid, index, matchers);
      what = driver + (owner ? ` (${ownerText(owner)})` : "");
    } else if (browser) {
      role = "browser";
      owner = heldBy(entry.pid, index, matchers);
      what = `браузер ${browser}${owner ? ` (${ownerText(owner)})` : " (не из наших станций)"}`;
    } else if ((owner = heldBy(entry.pid, index, matchers))?.kind === "mcp") {
      // Процесс запущен нашим сервером, но приметы в команде нет (node-обёртка npx-пакета): это его часть.
      role = "mcp";
      what = `MCP ${owner.name} (часть сервера)`;
    } else if (isTestRun(cmd)) {
      role = "test";
      what = `тесты: ${firstLine(cmd)}`;
    } else if (engine) {
      role = "station";
      what = `движок станции: ${firstLine(cmd)}`;
    } else {
      const client = clientOfProcess(cmd);
      if (!client) continue;
      role = "agent";
      what = `клиент ${client}`;
    }
    // Проект: путь в командной строке точнее всего, дальше — реальный путь файла записи (симлинк из
    // ~/.agents ведёт в проект), потом — хозяин записи (объявлен реестром или это каталог mcp-station).
    const named = matched?.name ?? (owner?.kind === "mcp" ? owner.name : null) ?? serverNamed(cmd);
    const project = byPath
      ?? (matched ? projectOfToken(matched.token) : null)
      ?? projectOfServer(named)
      ?? (role === "agent" ? "cli-station" : role === "test" ? "command-center" : "—");
    rows.push({
      project,
      pid: entry.pid,
      role,
      what,
      // командную строку показываем там, где имя записи её не заменяет: у MCP-сервера она лишняя
      detail: role === "mcp" ? "" : firstLine(cmd).slice(0, 120),
      started: Number.isFinite(entry.started) ? new Date(entry.started).toISOString() : null,
      since: Number.isFinite(entry.started) ? timeText(entry.started) : "?",
      cmd: firstLine(cmd),
    });
  }
  rows.sort((a, b) => (ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role)) || (String(a.started).localeCompare(String(b.started))) || a.pid - b.pid);
  return rows;
}

/** `center ps`: кто что держит прямо сейчас. Центр только читает: ни серверов, ни браузеров он не поднимает. */
function cmdPs(asJson) {
  const snapshot = processSnapshot();
  const lock = lockState();
  const rows = classifyProcesses(snapshot.processes);
  if (asJson) {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      platform: PLATFORM,
      source: snapshot.source,
      ...(snapshot.note ? { note: snapshot.note } : {}),
      processes: rows,
      lock: lockReport(lock),
    }, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`процессы (${PLATFORM}, источник: ${snapshot.source}):\n`);
  if (snapshot.note) process.stdout.write(`  ${snapshot.note}\n`);
  if (rows.length === 0) {
    process.stdout.write("  наших процессов не видно\n");
  } else {
    process.stdout.write(`  ${"проект".padEnd(20)} pid      старт            что\n`);
    for (const row of rows) {
      const tail = row.detail ? ` — ${row.detail}` : "";
      process.stdout.write(`  ${row.project.padEnd(20)} ${String(row.pid).padEnd(8)} ${row.since.padEnd(16)} ${row.what}${tail}\n`);
    }
    const counts = ROLE_ORDER.filter((role) => rows.some((row) => row.role === role)).map((role) => `${ROLE_LABEL[role]} ${rows.filter((row) => row.role === role).length}`);
    process.stdout.write(`  всего: ${rows.length} (${counts.join(", ")})\n`);
  }
  process.stdout.write(`\n${lockLine(lock)}\n`);
  return 0;
}

/** Где лежат логи проекта: файлы в рантайме (state и cache по имени проекта) и подкаталог logs. */
function projectLogSources(project) {
  const stateHome = process.env.XDG_STATE_HOME ? resolve(process.env.XDG_STATE_HOME) : join(HOME, ".local/state");
  const cacheHome = process.env.XDG_CACHE_HOME ? resolve(process.env.XDG_CACHE_HOME) : join(HOME, ".cache");
  const roots = [join(stateHome, project.name), join(cacheHome, project.name)];
  const sources = [];
  for (const root of roots) {
    for (const dir of [root, join(root, "logs")]) {
      if (!existsSync(dir)) continue;
      for (const file of readdirSync(dir)) {
        if (!file.endsWith(".log")) continue;
        const path = join(dir, file);
        try {
          sources.push({ path, modified: statSync(path).mtimeMs });
        } catch {
          // файл исчез между чтениями: его в списке просто нет
        }
      }
    }
  }
  sources.sort((a, b) => b.modified - a.modified);
  return { sources: sources.slice(0, 3), roots: roots.filter((root) => existsSync(root)) };
}

/** Юнит пользователя с именем проекта: логи юнита живут в журнале, а не в файле. */
function projectUnit(name) {
  const configHome = process.env.XDG_CONFIG_HOME ? resolve(process.env.XDG_CONFIG_HOME) : join(HOME, ".config");
  const dir = join(configHome, "systemd/user");
  if (!existsSync(dir)) return null;
  return readdirSync(dir).filter((file) => file.endsWith(".service") && file.startsWith(name)).sort()[0] ?? null;
}

/**
 * `center logs <проект> [--tail N]`: где лежат логи проекта и их хвост. Своих логов у станции может не
 * быть вовсе — тогда центр говорит это прямо и подсказывает, где смотреть (журнал юнита, состояние
 * станции, вывод на экран), а не показывает пустоту вместо ответа.
 */
function cmdLogs(name, tail, asJson) {
  const project = projects.find((item) => item.name === name);
  if (!project) throw new Error(`в реестре нет ${name} (есть: ${projects.map((p) => p.name).join(", ")})`);
  const lines = Number.isInteger(tail) && tail > 0 ? tail : LOG_TAIL;
  const found = projectLogSources(project);
  const unit = projectUnit(project.name);
  const hints = [];
  if (unit) hints.push(`журнал юнита: journalctl --user -u ${unit} -n ${lines}`);
  for (const root of found.roots) hints.push(`рантайм станции: ${tildify(root)} (файлов .log там нет)`);
  if (hints.length === 0) {
    hints.push(`файловых логов нет вовсе: вывод идёт на экран — повтори команду проекта (center run ${project.name} …)`);
  }
  const sources = found.sources.map((source) => {
    const stat = statSync(source.path);
    const maxBytes = Math.min(stat.size, 1024 * 1024);
    const start = Math.max(0, stat.size - maxBytes);
    const fd = openSync(source.path, "r");
    const buffer = Buffer.alloc(maxBytes);
    const bytes = readSync(fd, buffer, 0, maxBytes, start);
    closeSync(fd);
    const text = buffer.subarray(0, bytes).toString("utf8").replace(/\n$/, "");
    return { path: source.path, modified: new Date(source.modified).toISOString(), tail: text ? text.split("\n").slice(-lines) : [] };
  });

  if (asJson) {
    process.stdout.write(`${JSON.stringify({ ok: true, project: project.name, sources, hint: hints }, null, 2)}\n`);
    return 0;
  }
  if (sources.length === 0) {
    process.stdout.write(`логов нет: ${project.name} своих логов не пишет — смотри:\n`);
    for (const hint of hints) process.stdout.write(`  ${hint}\n`);
    return 0;
  }
  process.stdout.write(`логи ${project.name} (хвост по ${lines} строк):\n`);
  for (const source of sources) {
    process.stdout.write(`\n${tildify(source.path)} (изменён ${timeText(Date.parse(source.modified))})\n`);
    for (const line of source.tail) process.stdout.write(`  ${line}\n`);
  }
  return 0;
}

/** Запущенные клиенты и их конфиги: конфиг новее запуска — клиент держит старое представление о записях. */
function clientSessions() {
  const snapshot = processSnapshot();
  return mcpClients().map((client) => {
    const running = snapshot.processes.filter((row) => row.pid !== SELF_PID && clientOfProcess(row.cmd) === client.client);
    const oldest = running.filter((row) => Number.isFinite(row.started)).sort((a, b) => a.started - b.started)[0] ?? null;
    return { client: client.client, file: client.file, running, oldest };
  });
}

/**
 * «Зарегистрирован ≠ видно в сессии»: конфиг клиента новее запуска самого клиента — значит клиент читал
 * его до правки и новых тулов в текущей сессии не увидит. Процесса клиента нет — судить не о чем (null),
 * есть и он старше правки — «свежо» (false).
 */
function sessionStale(client) {
  if (!existsSync(client.file) || !client.oldest) return null;
  try {
    const modified = statSync(client.file).mtimeMs;
    if (modified <= client.oldest.started) return false;
    return { pid: client.oldest.pid, since: timeText(client.oldest.started), modified: timeText(modified) };
  } catch {
    return null;
  }
}

/** Строка про устаревшую сессию клиента — одна и та же в verify центра и в verify станции. */
const STALE_HINT = "тулы появятся после перезапуска (opencode2 service restart / новый сеанс omp, pi)";

function cmdLinks() {
  process.stdout.write("связи:\n\n");
  for (const project of projects) {
    const out = project.activate ? `→ активируется: ${project.run} ${project.activate.join(" ")}` : "";
    process.stdout.write(`${project.name.padEnd(20)} ${project.what}\n`);
    for (const { link, into } of project.expectLinks ?? []) {
      process.stdout.write(`${"".padEnd(20)}   ссылка: ${link} → ${into}\n`);
    }
    for (const server of project.expectMcp ?? []) {
      process.stdout.write(`${"".padEnd(20)}   MCP: ${server} у клиентов (проверяет doctor, ставит mcp-station)\n`);
    }
    if (out) process.stdout.write(`${"".padEnd(20)}   ${out}\n`);
  }
  process.stdout.write("\nцепочка активации: cli-station → skills-hub/skills-station → spec-station → mcp-station → memory-station/wiki-station → prompt-station (personas) → sysprompt\n");
  return 0;
}

function cmdRun(name, args) {
  const project = projects.find((item) => item.name === name);
  if (!project) throw new Error(`в реестре нет ${name} (есть: ${projects.map((p) => p.name).join(", ")})`);
  // Чужая ОС — не поломка диска: говорим прямо и не ищем точку входа, которой тут и не должно быть.
  if (!platformSupported(project)) {
    process.stdout.write(`${name}: ${unsupportedNote(project)}\n`);
    return 0;
  }
  const runner = runnerFor(project);
  if (!runner) throw new Error(`у ${name} нет команды запуска в реестре`);
  process.stderr.write(`center: ${runner.join(" ")} ${args.join(" ")}\n`);
  const result = run([...runner, ...args]);
  process.stdout.write(result.out ? `${result.out}\n` : "");
  return result.code === 0 ? 0 : 1;
}

/** Сводка устаревшего: центр не проверяет сам, а зовёт то, что объявлено у проектов (поле outdated). */
function cmdOutdated(asJson) {
  const rows = projects.map((project) => {
    const status = statusUpdate(project);
    return { name: project.name, update: status.command, status: status.status, detail: status.detail, label: status.label };
  });
  const failed = rows.filter((row) => row.label === "сверка не удалась");
  if (asJson) {
    const payload = rows.map(({ name, update, status, detail }) => ({ name, update, status, detail }));
    process.stdout.write(`${JSON.stringify({ ok: failed.length === 0, projects: payload }, null, 2)}\n`);
    return failed.length === 0 ? 0 : 1;
  }

  process.stdout.write(`сверка обновлений: команды у проектов свои, центр только зовёт и сводит\n\n`);
  printRows(rows, 20);
  const count = (label) => rows.filter((row) => row.label === label).length;
  process.stdout.write(`\nитог: обновить ${count("обновить")}, на месте ${count("свежо")}, без сверки ${count("без сверки")}, не обновляется ${count("не обновляется")}${failed.length ? `, сверка не удалась ${failed.length}` : ""}\n`);
  return failed.length === 0 ? 0 : 1;
}

/** Печать строк «имя — метка — почему» одинаково у outdated и update. */
function printRows(rows, width) {
  for (const row of rows) {
    process.stdout.write(`${row.name.padEnd(width)} ${(row.label ?? "").padEnd(18)} ${row.detail}\n`);
  }
}

/**
 * Обновление проектов их же командами. Центр не дублирует установку: берёт команду из реестра, зовёт
 * её и сводит результат. При --dry-run флаг «ничего не менять» получают только те, у кого он объявлен
 * в самой команде: у остальных центр ничего не запускает, а показывает строку плана.
 */
function cmdUpdate(names, flags) {
  const all = names.length === 0 || names[0] === "all";
  if (!all) {
    const unknown = names.filter((name) => !projects.some((project) => project.name === name));
    if (unknown.length) throw new Error(`в реестре нет ${unknown.join(", ")} (есть: ${projects.map((p) => p.name).join(", ")})`);
  }
  const target = all ? projects : projects.filter((project) => names.includes(project.name));
  const rows = [];
  let failed = 0;
  let ran = 0;
  if (!flags.json) {
    process.stdout.write(`обновление: ${flags.dryRun ? "план (командам уходит флаг «ничего не менять»)" : "выполняю команды из реестра"}\n\n`);
  }

  for (const project of target) {
    if (!platformSupported(project)) {
      rows.push({ name: project.name, command: "", status: "unsupported", code: null, detail: unsupportedNote(project) });
      continue;
    }
    const command = updateCommand(project);
    if (!command) {
      rows.push({ name: project.name, command: "", status: "no-command", code: null, detail: unavailableNote(project) });
      continue;
    }
    if (flags.dryRun && !command.dryRun) {
      rows.push({ name: project.name, command: command.text, status: "plan", code: null, detail: "команда не объявила флаг «ничего не менять» — в плане только показана" });
      continue;
    }
    const argv = flags.dryRun ? [...command.argv, command.dryRun] : command.argv;
    const result = run(argv);
    ran += 1;
    const tail = firstLine(result.out.split("\n").filter(Boolean).slice(-1)[0] ?? "");
    const ok = result.code === 0;
    if (!ok && !flags.dryRun) failed += 1;
    rows.push({
      name: project.name,
      command: command.text,
      status: ok ? "ok" : "failed",
      code: result.code,
      detail: ok ? tail : `код ${result.code}: ${tail}`,
    });
  }

  if (!flags.json) printRows(rows.map((row) => ({ ...row, label: row.status })), 20);

  // Настоящее обновление меняет установленное — связи после него перепроверяем тем же doctor.
  let doctor = null;
  if (!flags.dryRun && ran > 0) {
    const report = doctorRun();
    doctor = report.code;
    if (report.code !== 0) failed += 1;
    if (!flags.json) process.stdout.write(`\nсвязи после обновления:\n${report.text}\n`);
  }

  if (flags.json) {
    process.stdout.write(`${JSON.stringify({ ok: failed === 0, dryRun: flags.dryRun, projects: rows, doctor }, null, 2)}\n`);
    return failed === 0 ? 0 : 1;
  }
  const skipped = rows.filter((row) => row.status === "no-command").length;
  const foreign = rows.filter((row) => row.status === "unsupported").length;
  process.stdout.write(`\n${flags.dryRun ? "план: ничего не запущено всерьёз" : "обновление прошло"}; звал ${ran} из ${target.length}${skipped ? `, нечем обновлять ${skipped}` : ""}${foreign ? `, не поддерживается на этой ОС ${foreign}` : ""}${failed ? `, проблем ${failed}` : ""}\n`);
  return failed === 0 ? 0 : 1;
}

/** Состояние проекта на диске одним снимком: какой коммит лежит и есть ли правки. */
function gitSnapshot(path) {
  const probe = run(["git", "-C", path, "rev-parse", "--show-toplevel"], 20_000);
  if (probe.code !== 0) return undefined;
  try {
    const repositoryRoot = realpathSync(probe.out.trim());
    const requestedRoot = realpathSync(path);
    if (normalizePathKey(repositoryRoot, { caseInsensitive: IS_WIN }) !== normalizePathKey(requestedRoot, { caseInsensitive: IS_WIN })) return undefined;
  } catch {
    return undefined;
  }
  const commit = run(["git", "-C", path, "rev-parse", "--short", "HEAD"], 20_000);
  const head = run(["git", "-C", path, "rev-parse", "HEAD"], 20_000);
  const branch = run(["git", "-C", path, "rev-parse", "--abbrev-ref", "HEAD"], 20_000);
  const dirty = run(["git", "-C", path, "status", "--short", "--untracked-files=all"], 20_000);
  const rows = dirty.code === 0 ? dirty.out.split("\n").filter(Boolean) : [];
  return {
    commit: commit.code === 0 ? commit.out.trim() : null,
    head: head.code === 0 ? head.out.trim() : null,
    branch: branch.code === 0 ? branch.out.trim() : null,
    dirty: dirty.code === 0 ? rows.length : null,
    untracked: dirty.code === 0 ? rows.filter((row) => row.startsWith("??")).length : null,
  };
}

/**
 * Версия набора: единственный источник — файл VERSION в корне диска, меняется осознанно по релизу.
 * Здесь видно, из чего версия складывается (снимок проектов) и по какому правилу её бампают.
 */
function cmdVersion(asJson) {
  const file = join(PROJECTS_ROOT, "VERSION");
  const version = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
  const composition = projects
    .filter((project) => existsSync(projectPath(project)))
    .map((project) => ({ name: project.name, ...(gitSnapshot(projectPath(project)) ?? { commit: null, head: null, branch: null, dirty: null, untracked: null }) }));
  const root = gitSnapshot(SET_ROOT) ?? { commit: null, head: null, branch: null, dirty: null, untracked: null };
  const dirtied = composition.filter((row) => row.dirty).length + (root.dirty ? 1 : 0);
  const ritual = ["center update", "center check", "правка VERSION", "center version"];

  if (asJson) {
    process.stdout.write(`${JSON.stringify({ version, source: file, root, policy: VERSION_POLICY, projects: composition, ritual }, null, 2)}\n`);
    return version ? 0 : 1;
  }

  process.stdout.write(`версия набора: ${version || "НЕТ (файла VERSION нет)"}\n`);
  process.stdout.write(`источник: ${file} — единственный источник, версия меняется руками по релизу\n`);
  process.stdout.write(`правило бампа: patch — ${VERSION_POLICY.patch}; minor — ${VERSION_POLICY.minor}; major — ${VERSION_POLICY.major}\n`);
  const rootGit = root.commit ? `${root.commit}${root.branch ? ` (${root.branch})` : ""}${root.dirty ? `, правок ${root.dirty}` : ", чисто"}` : "не git-репозиторий";
  process.stdout.write(`корень набора: ${rootGit}\n`);
  process.stdout.write(`\nиз чего складывается (состояние проектов на диске):\n`);
  for (const row of composition) {
    const git = row.commit ? `${row.commit}  ${row.dirty ? `правок ${row.dirty}` : "чисто"}` : "не git-репозиторий";
    process.stdout.write(`  ${row.name.padEnd(20)} ${git}\n`);
  }
  process.stdout.write(`\nпроектов: ${composition.length}, с несохранёнными правками: ${dirtied}\n`);
  process.stdout.write(`ритуал релиза:\n`);
  process.stdout.write(`  1. правки в станциях — их собственные тесты зелёные (bats станции)\n`);
  process.stdout.write(`  2. center update    — догнать установленное до диска (reconcile, при нужде --prune)\n`);
  process.stdout.write(`  3. center check     — связи и сквозной прогон\n`);
  process.stdout.write(`  4. правка VERSION   — осознанно: patch/minor/major по правилу выше, автоинкремента нет\n`);
  process.stdout.write(`  5. center version   — сверить состав и версию, дальше коммит/тег\n`);
  return version ? 0 : 1;
}

function cmdActivate(names, dryRun) {
  const target = names.length === 0 || names[0] === "all" ? projects.filter((p) => p.activate) : projects.filter((p) => names.includes(p.name));
  if (target.length === 0) throw new Error("нечего активировать — проверь имена");
  let failed = 0;
  for (const project of target) {
    if (!platformSupported(project)) {
      process.stdout.write(`${project.name.padEnd(20)} ${unsupportedNote(project)}\n`);
      continue;
    }
    if (!project.activate) {
      process.stdout.write(`${project.name.padEnd(20)} активировать нечего${project.note ? ` (${project.note})` : ""}\n`);
      continue;
    }
    const activateFile = activateFileOf(project);
    let runner;
    try {
      // файл активации тоже берётся под текущую ОС: на Windows у него своя обёртка-сосед
      runner = activateFile ? scriptRunner(platformEntry(join(projectPath(project), activateFile))) : runnerFor(project);
    } catch (error) {
      process.stdout.write(`${project.name.padEnd(20)} активировать нечем: ${error.message}\n`);
      continue;
    }
    if (!runner) {
      process.stdout.write(`${project.name.padEnd(20)} нет команды запуска\n`);
      continue;
    }
    const wantsDryRun = project.dryRunFlag !== "none";
    const argv = [...runner, ...project.activate];
    if (dryRun && wantsDryRun) argv.push(/pwsh|powershell/i.test(runner[0]) ? "-WhatIf" : "--dry-run");
    const note = dryRun && !wantsDryRun ? "   (этот скрипт dry-run не умеет — в плане только показан)" : "";
    process.stdout.write(`${project.name.padEnd(20)} ${argv.slice(1).join(" ")}${note}\n`);
    if (dryRun) continue;
    const result = run(argv);
    if (result.code !== 0) {
      failed += 1;
      process.stdout.write(`${"".padEnd(20)} не вышло (код ${result.code}): ${result.out.split("\n").slice(-2).join(" / ")}\n`);
    }
  }
  process.stdout.write(dryRun ? "\n(dry-run: ничего не запущено)\n" : failed === 0 ? "\nактивация прошла\n" : `\nактивация: ошибок ${failed}\n`);
  return failed === 0 ? 0 : 1;
}

function cmdDocs(topic, asPath) {
  const dir = join(ROOT, "docs");
  if (!existsSync(dir)) throw new Error("нет каталога docs");
  const files = readdirSync(dir).filter((file) => file.endsWith(".md")).sort();
  if (!topic) {
    const index = join(dir, "README.md");
    process.stdout.write(existsSync(index) ? readFileSync(index, "utf8") : files.map((f) => `${f}\n`).join(""));
    process.stdout.write(`\nфайлы: ${files.join(", ")}\n`);
    return 0;
  }
  const wanted = files.find((file) => file === `${topic}` || file === `${topic}.md` || file.startsWith(topic));
  if (!wanted) {
    process.stderr.write(`нет темы ${topic}. Есть: ${files.map((f) => f.replace(/\.md$/, "")).join(", ")}\n`);
    return 1;
  }
  const path = join(dir, wanted);
  process.stdout.write(asPath ? `${path}\n` : readFileSync(path, "utf8"));
  return 0;
}

/** Чем импортировать ключи и добить серверы с ключами: на Windows — обёртки .ps1, на Unix — .sh. */
const KEYS_IMPORT = IS_WIN ? "mcp-station/bin/keys.ps1 import" : "mcp-station/bin/keys.sh import";
const KEYS_INSTALL = IS_WIN ? "mcp-station/bin/mcp-station.ps1 install --profile keyed" : "mcp-station/bin/mcp-station.sh install --profile keyed";
/**
 * Тяжёлые MCP (браузер ~663 МБ и stealth-сборка) в шаги fresh не входят осознанно — значит, и в живой
 * проверке fresh они давали бы вечный провал. Исключаем и называем их команды строкой, а не прячем.
 */
const HEAVY_SERVERS = "camoufox,stealth-browser";
/**
 * Отладочные MCP (поле `browser` их не помечает) ставятся как core, но живут только после сборки
 * локальных рантаймов — `mcp-station/bin/debug-setup.sh`: venv'ы, bpftrace-mcp-server из cargo, мост
 * lldb. До сборки запись честно падает с подсказкой, а значит в проверке fresh давала бы вечный
 * провал — ровно как camoufox и stealth-browser. Список сверяет тест: новая отладочная запись в
 * каталоге без строки здесь — упавший тест, а не тихая дыра в проверке.
 */
const DEBUG_SERVERS = "gdb,frida-mcp,bpftrace,wireshark-mcp,mitmproxy-mcp,lldb,radare2";

/**
 * Каталог mcp-station по тирам — факт для плана установки: списки и числа в шагах следуют за
 * каталогом, а не наоборот (иначе «tier=core, 8 штук» переживает семь новых записей). Каталог не
 * прочитать — это видно в problems, и план говорит об этом строкой, а не показывает старый список.
 */
function mcpCatalogTiers() {
  const dir = join(PROJECTS_ROOT, "mcp-station/catalog");
  const tiers = { core: [], keyed: [], problems: [] };
  let files = [];
  try {
    files = readdirSync(dir).filter((file) => file.endsWith(".json")).sort();
  } catch (error) {
    tiers.problems.push(`каталог не прочитать (${dir}): ${error.message}`);
    return tiers;
  }
  for (const file of files) {
    try {
      const data = JSON.parse(readFileSync(join(dir, file), "utf8"));
      if (tiers[data.tier]) tiers[data.tier].push(data.name);
      else tiers.problems.push(`${file}: tier=${data.tier ?? "нет"} (ждали core|keyed)`);
    } catch (error) {
      tiers.problems.push(`${file}: ${error.message}`);
    }
  }
  return tiers;
}

/**
 * Шаги установки с нуля. Файл шага записан unix-путём: на Windows у него берётся .ps1-сосед (platformEntry).
 * Шаг, у которого на этой ОС нет своей формы (systemd-таймер, Linux-only станция), не выполняется — о нём
 * честно говорится строкой, а не падением в bash-заглушку.
 */
function freshSteps(persona, flags) {
  const cleanupArgs = ["clean-all", "--yes", ...(flags.deep ? ["--deep"] : [])];
  // --no-cleanup: заселение на занятую машину — ставим рядом и ничего не снимаем (docs/01-install.md)
  const steps = [
    ...(flags.noCleanup ? [] : [{ label: "снос прежнего", file: "cleanup-station/bin/cleanup.sh", args: cleanupArgs }]),
    { label: "команда center", file: "command-center/contrib/install-links.sh", args: [] },
    { label: "агенты", file: "cli-station/bin/cli-station.sh", args: ["install"] },
    { label: "симлинки хаба", file: "skills-hub/contrib/install-links.sh", args: [] },
    { label: "скиллы", file: "skills-station/bin/skills-station.sh", args: ["install", "all"] },
    { label: "спек-режим", file: "spec-station/bin/spec-station.sh", args: ["install"] },
    { label: "режимы /goal и /loop", file: "modes-station/bin/modes-station.sh", args: ["install"] },
    { label: "режим директора /vibe", file: "vibe-station/bin/vibe-station.sh", args: ["install"] },
    { label: "плагины pi", file: "pi-plugins-station/bin/pi-plugins-station.sh", args: ["install", "all"] },
    { label: "MCP", file: "mcp-station/bin/mcp-station.sh", args: ["install"] },
    { label: "память", file: "memory-station/bin/memory-station.sh", args: ["install", "--bootstrap-uv"] },
    { label: "вики", file: "wiki-station/bin/wiki-station.sh", args: ["install"] },
    { label: `персона ${persona}`, file: "prompt-station/bin/prompt-station.sh", args: ["flash", persona] },
    { label: "смена персоны на ходу", file: "prompt-station/bin/prompt-station.sh", args: ["install-ext"] },
    { label: "/prompt", file: "sysprompt/install.sh", args: ["all"] },
    { label: "free-модели opencode", file: "omp-zen-free/install.sh", args: [] },
    { label: "скилл переезда", file: "fedora-windows-look/install.sh", args: [] },
    { label: "часовая автопроверка", file: "skills-hub/contrib/install-units.sh", args: [] },
    { label: "сторож и бэкап набора", file: "command-center/contrib/install-units.sh", args: [] },
  ];
  return steps.map((step) => {
    const path = join(PROJECTS_ROOT, step.file);
    const entry = platformEntry(path);
    // на win32 своя форма — это .ps1-сосед: нет соседа — нет и шага (systemd-таймер, Linux-only станция)
    const portable = IS_WIN ? entry !== path : existsSync(entry);
    return { ...step, path, entry, portable };
  });
}

/** Чем шаг запускается — для плана и для отчёта о пропуске: на Windows это pwsh-обёртка, на Unix — bash. */
function stepCommand(step) {
  try {
    return shownCommand([...scriptRunner(step.entry), ...step.args]);
  } catch (error) {
    return `нечем запустить: ${error.message}`;
  }
}

/** Одна команда «поставить начисто»: сначала полный снос, потом установка по шагам. */
function cmdFresh(flags) {
  const steps = freshSteps(flags.persona || "duck", flags);
  const runnable = steps.filter((step) => step.portable);
  const skipped = steps.filter((step) => !step.portable);

  const modeNote = flags.deep ? " (снос с состоянием и логинами)" : flags.noCleanup ? " (без сноса: ставлю рядом)" : "";
  process.stdout.write(`режим: ${flags.yes ? "выполняю" : "план"}${modeNote}\n\n`);
  if (!flags.yes) {
    const listed = flags.noCleanup ? runnable : runnable.slice(1);
    if (!flags.noCleanup) process.stdout.write(`0. снос: cleanup-station clean-all --yes${flags.deep ? " --deep" : ""}\n`);
    listed.forEach((step, index) => process.stdout.write(`${index + 1}. ${step.label}\n`));
    process.stdout.write(`${listed.length + 1}. проверка: MCP отвечают (живой хендшейк; шаг долгий — спавнит настоящие серверы,\n`);
    process.stdout.write(`${"".padEnd(3)}часть поднимает браузер; таймаут ${VERIFY_TIMEOUT} с, быстрее — center verify --exclude playwright,chrome-devtools,stealth-browser)\n`);
    process.stdout.write(`${"".padEnd(3)}тяжёлые ${HEAVY_SERVERS.replace(",", " и ")} в проверке fresh пропускаются — они ставятся отдельными командами\n`);
    process.stdout.write(`${"".padEnd(3)}отладочные ${DEBUG_SERVERS.replaceAll(",", ", ")} тоже пропускаются: они живут после сборки рантаймов — mcp-station/bin/debug-setup.sh\n`);
    for (const step of skipped) {
      process.stdout.write(`\nшаг «${step.label}» на этой ОС пропущен: у ${step.file} нет своей обёртки\n`);
      process.stdout.write(`${"".padEnd(3)}(такие пути перечислены в command-center/platform-exceptions.txt с причиной)\n`);
    }
    const tiers = mcpCatalogTiers();
    const tierFact = tiers.problems.length
      ? `каталог не прочитан (проблем: ${tiers.problems.length}) — список серверов смотри в mcp-station`
      : `tier=core, записей: ${tiers.core.length}`;
    process.stdout.write(`\nMCP: шаг ставит только серверы БЕЗ ключей (${tierFact}).\n`);
    const keyed = tiers.problems.length ? "список не собран (каталог не прочитан)" : tiers.keyed.join(", ");
    process.stdout.write(`серверы с ключами (${keyed}) — после импорта ключей:\n`);
    process.stdout.write(`  ${KEYS_IMPORT}        # строки VAR=значение со stdin\n`);
    process.stdout.write(`  ${KEYS_INSTALL}\n`);
    process.stdout.write(`\nдальше вручную: логины провайдеров, отладочные рантаймы (mcp-station/bin/debug-setup.sh),\n`);
    process.stdout.write(`перезапуск клиентов (opencode2 service restart, новый сеанс omp/pi), затем center check\n`);
    process.stdout.write(`\nзапустить всерьёз: ${flags.noCleanup ? "center fresh --yes --no-cleanup" : "center fresh --yes"}\n`);
    return 0;
  }

  for (const step of skipped) {
    process.stdout.write(`\n[пропуск] ${step.label}: у ${step.file} нет обёртки под ${PLATFORM}\n`);
  }
  for (const [index, step] of runnable.entries()) {
    process.stdout.write(`\n[${index + 1}/${runnable.length}] ${step.label}\n`);
    const result = run([...scriptRunner(step.entry), ...step.args]);
    const tail = result.out.split("\n").filter(Boolean).slice(-3);
    for (const line of tail) process.stdout.write(`    ${line}\n`);
    if (result.code !== 0) {
      process.stderr.write(`center: шаг «${step.label}» упал (код ${result.code}) — дальше не иду, починить и повторить\n`);
      return 1;
    }
  }

  process.stdout.write("\nпроверка:\n");
  const doctor = run(dispatchArgv(join(ROOT, "bin/center.sh"), ["doctor"]));
  const doctorLines = doctor.out.split("\n");
  const doctorFails = doctorLines.filter((line) => line.startsWith("FAIL"));
  // Код 1 без названных причин — не проверка, а молчаливый отказ: печатаем, что именно не сошлось,
  // иначе установщик в чистом доме остаётся с «FRESH_RC=1» и без точки приложения.
  if (doctorFails.length) {
    process.stdout.write(`doctor: не сошлось ${doctorFails.length} (полный ответ: center doctor):\n`);
    for (const line of doctorFails) process.stdout.write(`  ${line.replace(/^FAIL\s*/, "")}\n`);
  }
  process.stdout.write(`${doctorLines.slice(-2).join("\n")}\n`);
  // шаг долгий и не бесплатный: он поднимает настоящие серверы — говорим об этом до запуска, а не после
  process.stdout.write(`\nMCP отвечают: спавню настоящие серверы (часть поднимает браузер), таймаут ${VERIFY_TIMEOUT} с — это не быстро\n`);
  const verify = run(dispatchArgv(join(ROOT, "bin/center.sh"), ["verify", "--timeout", String(VERIFY_TIMEOUT), "--exclude", `${HEAVY_SERVERS},${DEBUG_SERVERS}`]));
  process.stdout.write(`${verify.out}\n`);
  process.stdout.write(`MCP поставлены только серверы без ключей (tier=core). Серверы с ключами — сам, когда будут ключи:\n`);
  process.stdout.write(`  ${KEYS_IMPORT}   →   ${KEYS_INSTALL}\n`);
  process.stdout.write(`тяжёлые серверы отдельно (в шаги fresh не входят): camoufox — center run camoufox-research (браузер ~663 МБ); stealth-browser — mcp-station/bin/stealth-setup.sh\n`);
  process.stdout.write(`отладочные ${DEBUG_SERVERS.replaceAll(",", ", ")} — отдельно: mcp-station/bin/debug-setup.sh собирает их рантаймы (в проверке fresh они пропущены)\n`);
  process.stdout.write(`\nосталось руками: логины провайдеров, отладочные рантаймы (mcp-station/bin/debug-setup.sh),\n`);
  process.stdout.write(`перезапуск клиентов (opencode2 service restart, новый сеанс omp/pi)\n`);
  const configHome = process.env.XDG_CONFIG_HOME ? resolve(process.env.XDG_CONFIG_HOME) : join(HOME, ".config");
  const backupConfigured = backupTargets(join(configHome, "center/backup.target")).length > 0;
  const watchFailures = watchReport().filter((line) => !line.ok && (line.label === "сторож набора" || (line.label === "ночной бэкап" && backupConfigured)));
  if (watchFailures.length) {
    process.stdout.write(`\nтаймеры после fresh: не все активны\n`);
    for (const line of watchFailures) process.stdout.write(`  ${line.label}: ${line.text}\n`);
  }
  return doctor.code === 0 && verify.code === 0 && watchFailures.length === 0 ? 0 : 1;
}

/** Команда не только найдена, но и отвечает на проверку запуска. */
function toolUsable(path) {
  const [file, ...args] = spawnArgv([path, "--version"]);
  const result = spawnSync(file, args, { encoding: "utf8", timeout: 20_000 });
  return !result.error && result.status === 0;
}

/** Версия инструмента — доказательство, что он не просто лежит: путь без ответа на `--version` ничего не значит. */
function toolVersion(path) {
  const [file, ...args] = spawnArgv([path, "--version"]);
  const probe = spawnSync(file, args, { encoding: "utf8", timeout: 20_000 });
  const line = String(probe.stdout ?? probe.stderr ?? "").split("\n")[0].trim();
  if (probe.error || probe.status !== 0 || !line) return "";
  return line.length > 60 ? `${line.slice(0, 60)}…` : line;
}

function nodeVersionAtLeast(path, major, minor = 0) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(toolVersion(path));
  if (!match) return false;
  const [, currentMajor, currentMinor] = match.map(Number);
  return currentMajor > major || (currentMajor === major && currentMinor >= minor);
}

function cmdPrereqs() {
  // need: install — без него станции не встанут; extra — справочно (установку не блокирует);
  // tests — наборы тестов и линт; info — показываем, но требовать нечего.
  // Проверяем своими руками (PATH + PATHEXT), а не `command -v` через bash: на Windows bash в PATH —
  // заглушка WSL, которая печатает инструкцию и выходит с нулём, и живой набор выглядел как «не хватает девяти».
  const tools = {
    node: { why: "нужен всему: движки станций и MCP-серверы", hint: "fedora: dnf install nodejs | macos: brew install node", hintWin: "winget install OpenJS.NodeJS", need: "install" },
    npm: { why: "ставит pi и opencode (opencode2)", hint: "идёт в поставке node", hintWin: "идёт в поставке node", need: "install", either: "npm|bun" },
    bun: { why: "альтернатива npm и способ поставить omp", hint: "curl -fsSL https://bun.sh/install | bash", hintWin: "npm i -g bun", need: "install", either: "npm|bun" },
    git: { why: "клонировать репозитории с диска и обновлять скиллы", hint: "dnf/brew install git", hintWin: "winget install Git.Git", need: "install" },
    gh: { why: "источник github в хабе скиллов", hint: "dnf install gh | brew install gh", hintWin: "winget install GitHub.cli", need: "install" },
    jq: {
      why: "адаптеры хаба разбирают ответы маркетов",
      hint: "dnf install jq | brew install jq",
      hintWin: "winget install jqlang.jq",
      need: IS_WIN ? "extra" : "install",
      whyExtra: "на Windows маркеты идут через PowerShell-адаптеры, jq нужен только bash-ветке",
    },
    curl: {
      why: "скрипты установки вендоров и запросы к маркетам",
      hint: "обычно уже есть",
      hintWin: "curl.exe уже входит в Windows 10+",
      need: IS_WIN ? "extra" : "install",
    },
    bats: { why: "наборы тестов всех станций", hint: "dnf install bats | brew install bats-core", hintWin: "npm i -g bats (bats — POSIX-скрипт, ему нужен Git Bash)", need: "tests" },
    shellcheck: { why: "линт скриптов", hint: "dnf install ShellCheck | brew install shellcheck", hintWin: "winget install koalaman.shellcheck", need: "tests" },
    pwsh: {
      why: "обёртки под Windows; полной установке нужен PowerShell 7 (шаги симлинков хаба и camoufox несут #Requires -Version 7.0)",
      hint: "linux/macOS: не нужен · windows: winget install Microsoft.PowerShell (встроенного 5.1 не хватает)",
      need: "info",
    },
  };
  const found = new Map();
  for (const tool of Object.keys(tools)) {
    if (tool === "pwsh") {
      const path = IS_WIN ? whichTool("pwsh") ?? whichTool("powershell") : whichTool("pwsh");
      found.set(tool, path);
      continue;
    }
    found.set(tool, whichTool(tool));
  }
  const missing = { install: [], extra: [], tests: [] };
  process.stdout.write(`платформа: ${PLATFORM}\n\n`);
  for (const [tool, spec] of Object.entries(tools)) {
    const path = found.get(tool);
    const hint = IS_WIN ? spec.hintWin ?? spec.hint : spec.hint;
    if (path) {
      if (tool === "node" && toolVersion(path) && !nodeVersionAtLeast(path, 20)) {
        process.stdout.write(`—   ${tool.padEnd(12)} ${path} найден, но нужен Node >= 20\n`);
        missing.install.push(tool);
        continue;
      }
      if (tool === "pwsh" && IS_WIN && !toolUsable(path)) {
        process.stdout.write(`—   ${tool.padEnd(12)} ${path} найден, но --version не ответил; это не рабочий PowerShell\n`);
        continue;
      }
      const version = tool === "pwsh" && IS_WIN && !/pwsh\.exe$/i.test(path) ? "встроенный PowerShell 5.1" : toolVersion(path);
      process.stdout.write(`ok   ${tool.padEnd(12)} ${path}${version ? ` · ${version}` : ""}\n`);
      continue;
    }
    const blocking = spec.need === "install";
    const mark = blocking ? "НЕТ " : "—   ";
    process.stdout.write(`${mark} ${tool.padEnd(12)} ${spec.why}${spec.need === "tests" ? " (нужен только тестам и линту — установку не блокирует)" : spec.whyExtra ? ` (${spec.whyExtra})` : ""}\n`);
    process.stdout.write(`${"".padEnd(17)}поставить: ${hint}\n`);
    if (blocking) missing.install.push(tool);
    else if (spec.need === "extra") missing.extra.push(tool);
    else if (spec.need === "tests") missing.tests.push(tool);
  }
  // npm и bun заменяют друг друга: не хватает пары, а не обоих — пары разбираем группами
  for (const group of new Set(Object.values(tools).map((spec) => spec.either).filter(Boolean))) {
    const names = group.split("|");
    if (!names.some((name) => found.get(name))) continue;
    for (const name of names) {
      const at = missing.install.indexOf(name);
      if (at >= 0) missing.install.splice(at, 1);
    }
  }
  if (missing.install.length) {
    process.stdout.write(`\nне хватает: ${missing.install.length} — поставь их до станций\n`);
    return 1;
  }
  const spare = missing.extra.length + missing.tests.length;
  process.stdout.write(`\nпредпосылки на месте${spare ? ` (справочно нет: ${[...missing.extra, ...missing.tests].join(", ")} — установку не блокируют)` : ""}\n`);
  return 0;
}

function cmdBootstrap(dryRun) {
  // Списки серверов — из каталога станции: план следует за каталогом, а не наоборот.
  const tiers = mcpCatalogTiers();
  const coreFact = tiers.problems.length
    ? `каталог не прочитан (проблем: ${tiers.problems.length}) — список смотри в mcp-station list`
    : `tier=core, записей: ${tiers.core.length} — список: mcp-station list`;
  const steps = [
    ["0", "prereqs", ["node", "npm", "bun", "git", "gh", "jq", "bats", "curl"], "проверить предпосылки (node обязателен: на нём движки станций)"],
    ["1", "command-center", ["install-links"], "поставить команду center в PATH (без неё остальные шаги плана вызываются как command-center/bin/center.sh …)"],
    ["2", "cli-station", ["install"], "поставить агентов: omp, pi, opencode (opencode2)"],
    ["3", "skills-hub", [], "создать симлинки хаба: команда skills-manager и скилл skills-ops"],
    ["4", "skills-station", ["install", "all"], "разложить коллекцию скиллов в ~/.agents/skills"],
    ["5", "spec-station", ["install"], "разложить спек-режим: скилл spec-mode и команды /spec* в клиентов"],
    ["6", "modes-station", ["install"], "поставить режимы /goal и /loop в opencode2 (плагин modes-station)"],
    ["7", "vibe-station", ["install"], "поставить режим директора /vibe в opencode2 (плагин vibe-station: агенты режима и скилл)"],
    ["8", "pi-plugins-station", ["install", "all"], "поставить сторонние плагины pi из каталога станции"],
    ["9", "mcp-station", ["install"], `зарегистрировать MCP-серверы БЕЗ ключей (${coreFact})`],
    ["10", "memory-station", ["install", "--bootstrap-uv"], "поставить память: uv (с astral.sh, если его нет) + basic-memory + MCP-проект в клиенты"],
    ["11", "wiki-station", ["install"], "поставить вики: скилл + база поиска + проект в basic-memory"],
    ["12", "mcp-station", ["keys"], "ключи сервисов в один файл секретов (на диске не лежит), затем серверы с ключами: mcp-station install --profile keyed"],
    ["13", "prompt-station", ["flash", "duck"], "прошить базовую персону"],
    ["14", "prompt-station", ["install-ext"], "поставить смену персоны на ходу и /prompt-расширения"],
    ["15", "sysprompt", ["all"], "поставить команду /prompt в opencode, omp и pi"],
    ["16", "omp-zen-free", [], "снять 403 бесплатного тарифа OpenCode Go/Zen в omp/pi (расширение; ключи добавляются в клиентах)"],
    ["17", "fedora-windows-look", [], "подключить скилл переезда (Linux-хост, только симлинки)"],
    ["18", "skills-hub", ["install-units"], "включить часовую автопроверку диска (systemd user)"],
    ["19", "command-center", ["install-units"], "включить сторожа набора (диск DATA и ссылки в $HOME раз в 15 минут) и ночной бэкап набора"],
    ["20", "—", ["verify"], `проверить, что MCP реально отвечают во всех трёх средах (живой хендшейк; спавнит настоящие серверы, часть поднимает браузер — это долго, таймаут 20 с; тяжёлые ${HEAVY_SERVERS.replace(",", " и ")} и отладочные ${DEBUG_SERVERS} пропускаются — они отдельными командами)`],
    ["21", "—", ["check"], "финальная проверка: center doctor и сквозной прогон тестов"],
  ];
  const manual = [
    "если ставишь начисто: сначала `cleanup-station clean-all --yes` (см. docs/02-cleanup.md)",
    "тяжёлые MCP (в план не входят): camoufox — center run camoufox-research (браузер ~663 МБ); stealth-browser — mcp-station/bin/stealth-setup.sh (git + uv)",
    "отладочные MCP (в план не входят: живут после сборки рантаймов): mcp-station/bin/debug-setup.sh — venv'ы (uv), bpftrace-mcp-server (cargo), мост lldb; системные пакеты скрипт только называет",
    `логины провайдеров: omp/pi/opencode спрашивают их сами (\`/login\`, \`opencode2\` — по своему); серверы с ключами (${tiers.problems.length ? "список не собран: каталог не прочитан" : tiers.keyed.join("/")}) ставятся отдельно: keys.sh import → mcp-station install --profile keyed`,
    "первый запуск клиентов: opencode2 service restart, новый сеанс omp/pi (расширения читаются на старте)",
    "сторож и бэкап набора: цели бэкапа — по строке на цель в ~/.config/center/backup.target (локальная копия и оффлайн-носитель, во втором столбце свой --keep); нет файла — бэкап-юниты не ставятся, и установщик скажет об этом строкой",
    "проверка на живой сессии: /persona (список персон), /prompt <текст>, center doctor",
    "fedora-windows-look: применяется по SKILL.md шагами, preflight.sh первым",
    "free-модели OpenCode Go/Zen: расширение omp-zen-free уже стоит — ключ добавь в клиенте (/login в omp, ~/.pi/agent/auth.json у pi)",
  ];
  process.stdout.write("план установки с нуля:\n\n");
  for (const [number, name, args, what] of steps) {
    process.stdout.write(`${number}. ${name.padEnd(16)} ${what}\n`);
    if (name === "—") {
      process.stdout.write(`   команда: center ${args[0]}${args[0] === "verify" ? ` --timeout ${VERIFY_TIMEOUT}` : ""}\n`);
      continue;
    }
    if (name === "prereqs") {
      process.stdout.write(`   команда: center prereqs   (что не найдено — поставить по подсказкам)\n`);
      continue;
    }
    if (name === "mcp-station" && args[0] === "keys") {
      process.stdout.write(`   команда: ${KEYS_IMPORT}   (строки VAR=значение со stdin)\n`);
      continue;
    }
    if (name === "skills-hub" && args[0] === "install-units") {
      process.stdout.write(IS_WIN
        ? `   на Windows этого шага нет: часовую автопроверку там держит Task Scheduler, systemd-юнита не бывает\n`
        : `   команда: skills-hub/contrib/install-units.sh && systemctl --user enable --now skills-hub-check.timer\n`);
      continue;
    }
    if (name === "command-center" && args[0] === "install-links") {
      process.stdout.write(
        IS_WIN
          ? `   команда: pwsh -File command-center/contrib/install-links.ps1   (кладёт center.cmd в ~/.local/bin)\n`
          : `   команда: command-center/contrib/install-links.sh   (идемпотентно, есть --dry-run)\n`,
      );
      continue;
    }
    if (name === "command-center" && args[0] === "install-units") {
      process.stdout.write(IS_WIN
        ? `   на Windows юнитов центра нет: сторож и бэкап по расписанию там не написаны — bin/sentinel.ps1 и center backup запускаются руками\n`
        : `   команда: command-center/contrib/install-units.sh, затем systemctl --user enable --now center-sentinel.timer\n` +
          `   (бэкап-юниты ставятся, когда цели заданы по строке в ~/.config/center/backup.target)\n`);
      continue;
    }
    const project = projects.find((item) => item.name === name);
    if (project && !platformSupported(project)) {
      process.stdout.write(`   шага нет: ${unsupportedNote(project)}\n`);
      continue;
    }
    const activateFile = project ? activateFileOf(project) : undefined;
    if (activateFile) {
      // активация идёт своей обёрткой под текущую ОС — показываем ту команду, которой её и позовут
      const path = join(projectPath(project), activateFile);
      const shown = existsSync(platformEntry(path))
        ? shownCommand([...scriptRunner(platformEntry(path)), ...args])
        : `${activateFile} ${args.join(" ")}`;
      process.stdout.write(`   команда: ${shown}   (идемпотентно, есть --dry-run)\n`);
      continue;
    }
    const runner = project ? tryRunnerFor(project) : undefined;
    const why = runner?.problem ? `   (нечем запустить: ${runner.problem})` : runner?.argv ? `   (${runner.argv[0]} ${entryOf(project)})` : "";
    process.stdout.write(`   команда: center run ${name} ${args.join(" ")}${why}\n`);
  }
  process.stdout.write(`\nостаётся руками:\n`);
  for (const line of manual) process.stdout.write(`  · ${line}\n`);
  process.stdout.write(`\nподробности по каждому шагу — agent-bundle/harness/*.md\n`);
  if (!dryRun) process.stdout.write("(шаги не выполняются автоматически: сначала прочитай план, потом гоняй по одному)\n");
  return 0;
}

/** Файл активации проекта: на Windows — своя обёртка (activateFileWindows), если она объявлена. */
function activateFileOf(project) {
  return PLATFORM === "win32" ? project.activateFileWindows ?? project.activateFile : project.activateFile;
}

/** Путь файла станции так, как его называет человек: от каталога центра. */
function shownPath(path) {
  return under(path, ROOT) ?? path;
}

// ── бэкап набора ─────────────────────────────────────────────────────────────

/** Набор целиком: родитель каталога центра (то, что лежит на внешнем диске). */
const SET_ROOT = dirname(ROOT);

/** Мусор, который в архив бэкапа не кладём: кэши прогонов и логи. `.git` (и корневой, и подпроектов) — кладём. */
const BACKUP_EXCLUDES = ["*/node_modules", "*/__pycache__", "*/.pytest_cache", "*.pyc", "*.log"];
const BACKUP_CACHE_RE = /(^|\/)(node_modules|__pycache__|\.pytest_cache)(\/|$)|\.pyc$|\.log$/;
/** Release-архив не берёт git-историю, runtime-базы и любые файлы, которые похожи на секреты. */
const RELEASE_EXCLUDES = [
  ...BACKUP_EXCLUDES,
  "*/.git",
  "*/.env*",
  "*/secrets",
  "*/secrets.*",
  "*.key",
  "*.pem",
  "*.db",
  "*.sqlite",
  "*.sqlite3",
  "багрепорт.md",
];
const RELEASE_FORBIDDEN_RE = /(^|\/)(\.git|\.env[^/]*|secrets|[^/]+\.key|[^/]+\.pem|[^/]+\.(?:db|sqlite|sqlite3)|багрепорт\.md)(?:\/|$)/;

/** Байты для глаза: «8,4 МБ (8 812 345 байт)». */
function humanSize(bytes) {
  const units = ["Б", "КБ", "МБ", "ГБ", "ТБ"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const shown = unit === 0 ? String(bytes) : value.toFixed(1).replace(".", ",");
  return `${shown} ${units[unit]}`;
}

/**
 * Устройство пути (st_dev): у несуществующего — у ближайшего существующего предка. Так решается
 * «тот же диск»: цель бэкапа может ещё не существовать, а её устройство уже определено.
 */
function deviceOf(path) {
  let current = resolve(path);
  while (true) {
    try {
      return statSync(current).dev;
    } catch {
      const parent = dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

/** Метка времени для имени архива: 20260922-183045. */
function stamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** sha256 файла потоком: архив бывает большой, целиком в память его не берём. */
function sha256File(path) {
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(1 << 20);
    let read;
    while ((read = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, read));
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

/** Версия набора из VERSION: имя архива должно говорить, что в нём лежит. */
function setVersion() {
  try {
    return readFileSync(join(SET_ROOT, "VERSION"), "utf8").trim();
  } catch {
    return "";
  }
}

function releaseState() {
  return {
    root: gitSnapshot(SET_ROOT) ?? { commit: null, head: null, branch: null, dirty: null, untracked: null },
    projects: projects
      .filter((project) => existsSync(projectPath(project)))
      .map((project) => ({
        name: project.name,
        path: typeof project.path === "string" && project.path ? project.path : project.name,
        ...(gitSnapshot(projectPath(project)) ?? { commit: null, head: null, branch: null, dirty: null, untracked: null }),
      })),
  };
}

function releaseDirtyRows(state) {
  const rows = [];
  if (state.root?.commit || state.root?.head) {
    if (state.root.dirty === null) rows.push({ name: "корень набора", dirty: "неизвестно" });
    else if (state.root.dirty > 0) rows.push({ name: "корень набора", ...state.root });
  }
  for (const project of state.projects) {
    if (!project.commit && !project.head) continue;
    if (project.dirty === null) rows.push({ name: project.name, dirty: "неизвестно" });
    else if (project.dirty > 0) rows.push(project);
  }
  return rows;
}

/**
 * Бэкап набора: `center backup --to <путь> [--keep N] [--dry-run] [--json] [--force-same-disk]`.
 *
 * Собирает архив всего набора (tar.zst, если есть zstd, иначе tar.gz) без кэшей, кладёт рядом
 * .sha256, читает оглавление архива (проверка, что он не пустой и что кэш в него не попал) и
 * ротирует старые по --keep. Бэкап на том же устройстве, что и набор, — не бэкап: отказ, пока не
 * сказано --force-same-disk.
 */
function cmdBackup(flags, { release = false } = {}) {
  // Архив и checksum могут содержать приватные runtime-файлы: не оставлять им режим 0644.
  process.umask(0o077);
  const kind = release ? "релиз" : "бэкап";
  const excludes = release ? RELEASE_EXCLUDES : BACKUP_EXCLUDES;
  const forbiddenRe = release ? RELEASE_FORBIDDEN_RE : BACKUP_CACHE_RE;
  if (!flags.to) throw new Error(`нужен путь: center ${release ? "release" : "backup"} --to <путь> [--keep N] [--dry-run] [--json]`);
  const state = release ? releaseState() : undefined;
  const dirty = release ? releaseDirtyRows(state) : [];
  if (release && dirty.length && !flags.allowDirty) {
    const names = dirty.map((row) => `${row.name}: ${typeof row.dirty === "number" ? `${row.dirty}правок` : row.dirty}`).join(", ");
    throw new Error(`релиз не собирается: несохранённые правки (${names}); зафиксируй их или повтори с --allow-dirty`);
  }
  const dest = resolve(flags.to);
  const setDev = deviceOf(SET_ROOT);
  const destDev = deviceOf(dest);
  const sameDevice = setDev !== null && destDev !== null && setDev === destDev;
  if (sameDevice && !flags.forceSameDisk) {
    throw new Error(
      `тот же диск — это не бэкап: ${dest} и набор ${SET_ROOT} лежат на одном устройстве (st_dev ${destDev}). ` +
        `Укажи путь на другом диске или повтори с --force-same-disk, если бэкап нужен именно здесь`,
    );
  }

  const tar = whichTool("tar");
  if (!tar) throw new Error("нет tar: бэкап нечем собрать (поставь tar)");
  const zstd = whichTool("zstd");
  const compressor = zstd ? "zstd" : "gzip";
  const extension = zstd ? "tar.zst" : "tar.gz";
  const version = setVersion();
  const safeVersion = (version || "unknown").replace(/[^A-Za-z0-9._-]+/g, "-");
  const base = `AGGG-${safeVersion}-${stamp()}${release ? "-release" : ""}`;
  let archive = join(dest, `${base}.${extension}`);
  // имя с точностью до секунды: два прогона подряд не должны затирать друг друга
  for (let n = 2; existsSync(archive); n += 1) archive = join(dest, `${base}-${n}.${extension}`);
  const partial = `${archive}.partial`;
  const sumsPartial = `${archive}.sha256.partial`;

  const compressArgv = zstd ? ["--use-compress-program", "zstd -T0 -q"] : ["-z"];
  const createArgv = [
    tar,
    "-C",
    dirname(SET_ROOT),
    ...excludes.map((pattern) => `--exclude=${pattern}`),
    ...compressArgv,
    "-cf",
    partial,
    SET_ROOT.slice(dirname(SET_ROOT).length + 1) || SET_ROOT,
  ];

  // что будет с ротацией — считаем до записи: в плане это тоже видно
  const existing = existsSync(dest)
    ? readdirSync(dest)
        .filter((name) => /^AGGG-.*\.tar\.(zst|gz)$/.test(name))
        .map((name) => ({ name, time: statSync(join(dest, name)).mtimeMs }))
        .sort((a, b) => b.time - a.time)
    : [];
  const keep = Number.isInteger(flags.keep) ? flags.keep : null;
  // новый архив сам занимает одно место: держим keep штук вместе с ним, значит старых остаётся keep-1
  const doomed = keep === null ? [] : existing.slice(Math.max(keep - 1, 0)).map((row) => row.name);

  if (flags.dryRun) {
    const plan = {
      ok: true,
      dryRun: true,
      target: dest,
      archive,
      compressor,
      excludes,
      kind,
      dirty: release ? dirty : undefined,
      version,
      device: destDev,
      sameDevice,
      rotation: { keep, wouldRemove: doomed },
    };
    if (flags.json) process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    else {
      process.stdout.write(`${kind} набора (план, ничего не пишу):\n`);
      process.stdout.write(`  архив: ${archive}\n`);
      process.stdout.write(`  сжатие: ${compressor}${zstd ? "" : " (zstd не найден — беру gzip)"}\n`);
      process.stdout.write(`  не кладу: ${excludes.join(", ")}\n`);
      if (keep !== null) process.stdout.write(`  ротация (--keep ${keep}): убрал бы ${doomed.length ? doomed.join(", ") : "нечего"}\n`);
      if (sameDevice) process.stdout.write(`  внимание: цель на том же устройстве, что набор (st_dev ${destDev}) — пущен только из-за --force-same-disk\n`);
    }
    return 0;
  }

  mkdirIfNeeded(dest);
  for (const stale of [partial, sumsPartial]) if (existsSync(stale)) unlinkSync(stale);
  const result = run(createArgv, 3_600_000);
  if (result.code !== 0 || !existsSync(partial)) {
    if (existsSync(partial)) unlinkSync(partial);
    throw new Error(`архив не собрался (код ${result.code}): ${firstLine(result.out) || "вывода нет"}`);
  }

  // проверка архива чтением оглавления: пустой или с кэшем архив бэкапом не считается
  const toc = run([tar, "-tf", partial], 600_000);
  const entries = toc.out.split("\n").filter(Boolean);
  const forbidden = entries.filter((name) => forbiddenRe.test(name));
  if (toc.code !== 0 || entries.length === 0 || forbidden.length > 0) {
    unlinkSync(partial);
    const why = toc.code !== 0 ? `оглавление не читается: ${firstLine(toc.out)}` : entries.length === 0 ? "оглавление пусто" : `в архив попал запрещённый файл: ${forbidden.slice(0, 3).join(", ")}`;
    throw new Error(`архив негоден (${why}) — удалил его, бэкапа нет`);
  }

  const sums = `${archive}.sha256`;
  let archiveCommitted = false;
  let bytes;
  let hash;
  try {
    bytes = statSync(partial).size;
    hash = sha256File(partial);
    writeFileSync(sumsPartial, `${hash}  ${archive.slice(dest.length + 1)}\n`);
    renameSync(partial, archive);
    archiveCommitted = true;
    renameSync(sumsPartial, sums);
  } catch (error) {
    if (existsSync(partial)) unlinkSync(partial);
    if (archiveCommitted && existsSync(archive)) unlinkSync(archive);
    if (existsSync(sumsPartial)) unlinkSync(sumsPartial);
    if (existsSync(sums)) unlinkSync(sums);
    throw new Error(`архив не зафиксирован: ${error.message}`);
  }
  const manifestPath = release ? `${archive}.manifest.json` : undefined;
  if (release) {
    const manifest = {
      schema: 1,
      kind: "release",
      createdAt: new Date().toISOString(),
      version,
      root: state.root,
      projects: state.projects,
      archive: archive.slice(dest.length + 1),
      archiveSha256: hash,
      bytes,
      excludes,
    };
    try {
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    } catch (error) {
      unlinkSync(archive);
      unlinkSync(sums);
      throw new Error(`manifest не записать (${manifestPath}): ${error.message}`);
    }
  }

  const removed = [];
  for (const name of doomed) {
    unlinkSync(join(dest, name));
    if (existsSync(`${join(dest, name)}.sha256`)) unlinkSync(`${join(dest, name)}.sha256`);
    if (existsSync(`${join(dest, name)}.manifest.json`)) unlinkSync(`${join(dest, name)}.manifest.json`);
    removed.push(name);
  }

  if (flags.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          path: archive,
          bytes,
          sha256: hash,
          sha256File: sums,
          version,
          entries: entries.length,
          compressor,
          kind,
          excludes,
          manifest: manifestPath,
          target: dest,
          device: destDev,
          sameDevice,
          forced: Boolean(flags.forceSameDisk),
          rotation: { keep, kept: keep === null ? null : existing.length - removed.length + 1, removed },
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  process.stdout.write(`${kind} набора: ${archive}\n`);
  process.stdout.write(`размер: ${humanSize(bytes)} (${bytes} байт), рядом контрольная сумма ${sums}\n`);
  process.stdout.write(`sha256: ${hash}\n`);
  if (manifestPath) process.stdout.write(`manifest: ${manifestPath}\n`);
  process.stdout.write(`версия набора: ${version || "не прочитана"}\n`);
  process.stdout.write(`оглавление: ${entries.length} записей, запрещённых файлов нет (${excludes.join(", ")})\n`);
  if (keep !== null) {
    process.stdout.write(`ротация (--keep ${keep}): оставлено ${existing.length - removed.length + 1}, удалено ${removed.length}${removed.length ? `: ${removed.join(", ")}` : ""}\n`);
  }
  if (sameDevice) process.stdout.write(`внимание: цель на том же устройстве, что набор (st_dev ${destDev}) — бэкап пущен только из-за --force-same-disk\n`);
  return 0;
}

function cmdRelease(flags) {
  return cmdBackup(flags, { release: true });
}

function inspectArchive(tar, source) {
  const toc = run([tar, "-tf", source], 600_000);
  const entries = toc.out.split("\n").filter(Boolean);
  if (toc.code !== 0 || entries.length === 0) {
    throw new Error(`оглавление архива не читается: ${firstLine(toc.out) || "записей нет"}`);
  }
  const roots = new Set();
  for (const raw of entries) {
    const entry = String(raw).replaceAll("\\", "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
    if (!entry || entry === ".") continue;
    if (entry.startsWith("/") || /^[A-Za-z]:\//.test(entry)) throw new Error(`небезопасный путь в архиве: ${raw}`);
    const parts = entry.split("/");
    if (parts.includes("..")) throw new Error(`небезопасный путь в архиве: ${raw}`);
    roots.add(parts[0]);
  }
  if (roots.size !== 1) throw new Error(`небезопасная структура архива: ожидался один корень, найдено ${roots.size}`);
  const verbose = run([tar, "-tvf", source], 600_000);
  if (verbose.code !== 0) throw new Error(`подробное оглавление архива не читается: ${firstLine(verbose.out)}`);
  const root = [...roots][0];
  const unsafe = [];
  for (const raw of verbose.out.split("\n")) {
    const line = raw.trim();
    if (!line || /^[bcps]/.test(line)) {
      if (line) unsafe.push(line);
      continue;
    }
    const arrow = line.indexOf(" -> ");
    if (arrow < 0) {
      if (/^h/.test(line)) unsafe.push(line);
      continue;
    }
    const match = line.match(/\s(\S+)\s+->\s+(.+)$/);
    if (!match) {
      unsafe.push(line);
      continue;
    }
    const target = match[2].trim();
    const resolved = target.startsWith("/") ? target : posix.normalize(posix.join(posix.dirname(match[1]), target));
    const safeTarget = isPathWithin(root, resolved, { caseInsensitive: IS_WIN }) ||
      (posix.isAbsolute(target) && isPathWithin(SET_ROOT, resolved, { caseInsensitive: IS_WIN }));
    if (!safeTarget) unsafe.push(line);
  }
  if (unsafe.length) throw new Error(`небезопасная ссылка в архиве: ${firstLine(unsafe[0])}`);
  return { entries, root };
}

/**
 * Восстановление набора из архива: `center restore --from <архив|каталог> --to <каталог> [--dry-run] [--json]`.
 *
 * Зачем отдельная команда: бэкап, который ни разу не распаковывали, — это надежда, а не бэкап. Команда
 * распаковывает архив В СТОРОНУ (в пустой каталог) и проверяет копию делом: VERSION читается, реестр
 * разбирается, объявленные проекты на месте, гейт доков копии проходит. Живой набор не трогается:
 * путь внутрь набора и путь-предок набора отвергаются — иначе это была бы подмена данных, а не проверка.
 * Контрольная сумма сверяется, если рядом есть `.sha256`; нет файла — так и говорится, а не «ok».
 */
function cmdRestore(flags) {
  if (!flags.from) throw new Error("нужен архив: center restore --from <архив|каталог> --to <каталог> [--dry-run]");
  if (!flags.to) throw new Error("нужен каталог назначения: center restore --from <архив|каталог> --to <каталог> [--dry-run]");

  const tar = whichTool("tar");
  if (!tar) throw new Error("нет tar: архив нечем распаковать (поставь tar)");

  let source = resolve(flags.from);
  if (existsSync(source) && statSync(source).isDirectory()) {
    const archives = readdirSync(source)
      .filter((name) => /^AGGG-.*\.tar\.(zst|gz)$/.test(name))
      .filter((name) => existsSync(join(source, `${name}.sha256`)))
      .map((name) => ({ name, time: statSync(join(source, name)).mtimeMs }))
      .sort((a, b) => b.time - a.time);
    if (archives.length === 0) throw new Error(`в каталоге нет архивов AGGG-*.tar.zst|gz: ${source}`);
    source = join(source, archives[0].name);
  }
  if (!existsSync(source)) throw new Error(`архива нет: ${source}`);
  if (!statSync(source).isFile()) throw new Error(`это не файл архива: ${source}`);

  const target = resolve(flags.to);
  if (target === SET_ROOT || under(target, SET_ROOT)) {
    throw new Error(`отказ: ${target} лежит внутри живого набора (${SET_ROOT}) — восстановление идёт в сторону, в пустой каталог вне набора`);
  }
  if (under(SET_ROOT, target)) {
    throw new Error(`отказ: ${target} — родитель живого набора (${SET_ROOT}): распаковка легла бы поверх него`);
  }
  if (existsSync(target) && readdirSync(target).length > 0) {
    throw new Error(`каталог назначения не пуст: ${target} — нужен пустой или ещё не созданный`);
  }

  const sums = `${source}.sha256`;
  const actual = sha256File(source);
  let checksum = { file: sums, verified: false, present: false, expected: null, actual };
  if (existsSync(sums)) {
    const expected = String(readFileSync(sums, "utf8")).trim().split(/\s+/)[0] ?? "";
    checksum = { file: sums, verified: expected.toLowerCase() === actual.toLowerCase(), present: true, expected, actual };
    if (!checksum.verified) {
      throw new Error(`контрольная сумма не сходится (${sums}: ${expected.slice(0, 12)}…, посчитано: ${actual.slice(0, 12)}…) — архив битый, восстанавливать нечего`);
    }
  } else if (!flags.allowMissingChecksum) {
    throw new Error(`контрольная сумма обязательна: нет ${sums}; для диагностического восстановления повтори с --allow-missing-checksum`);
  }

  const bytes = statSync(source).size;
  const inspected = inspectArchive(tar, source);
  const entries = inspected.entries;
  const root = inspected.root;
  const restored = join(target, root);
  const nameVersion = (/^AGGG-(.+?)-\d{8}-\d{6}/.exec(source.slice(source.lastIndexOf(sep) + 1)) ?? [])[1] ?? "";

  if (flags.dryRun) {
    const plan = {
      ok: true,
      dryRun: true,
      from: source,
      bytes,
      to: target,
      set: restored,
      entries: entries.length,
      checksum,
      versionInName: nameVersion,
    };
    if (flags.json) process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    else {
      process.stdout.write(`восстановление (план, ничего не распаковываю):\n`);
      process.stdout.write(`  откуда: ${source} (${humanSize(bytes)}, записей ${entries.length})${checksum.present ? ", сумма сходится" : ", .sha256 рядом нет — целостность не проверена"}\n`);
      process.stdout.write(`  куда: ${target}\n`);
      process.stdout.write(`  набор разложится в: ${restored}\n`);
      process.stdout.write(`  после распаковки проверю: VERSION, реестр и пути проектов, гейт доков копии\n`);
    }
    return 0;
  }

  const work = `${target}.partial-${process.pid}`;
  if (existsSync(work)) rmSync(work, { recursive: true, force: true });
  mkdirIfNeeded(work);
  const extractArgv = (destination) => {
    const prefix = IS_WIN ? [] : ["--no-same-owner", "--no-same-permissions"];
    return [tar, ...prefix, "-xf", source, "-C", destination];
  };
  let result = run(extractArgv(work), 3_600_000);
  if (result.code !== 0 && /\.zst$/.test(source)) {
    // tar без встроенной поддержки zstd — просим распаковщик явно (так же зовёт его и бэкап)
    const prefix = IS_WIN ? [] : ["--no-same-owner", "--no-same-permissions"];
    result = run([tar, ...prefix, "--use-compress-program", "zstd -d -q", "-xf", source, "-C", work], 3_600_000);
  }
  if (result.code !== 0 || !existsSync(join(work, root))) {
    rmSync(work, { recursive: true, force: true });
    throw new Error(`архив не распаковался (код ${result.code}): ${firstLine(result.out) || "вывода нет"}`);
  }
  const stagedRestored = join(work, root);

  const checks = [];
  let version = "";
  try {
    version = readFileSync(join(stagedRestored, "VERSION"), "utf8").trim();
    checks.push({ name: "VERSION", ok: version.length > 0, detail: version || "файл пуст" });
  } catch (error) {
    checks.push({ name: "VERSION", ok: false, detail: `не прочитан: ${error.message}` });
  }

  const projects = { total: 0, present: 0, missing: [] };
  try {
    // реестр живёт у центра, а каталоги проектов — соседи центра внутри набора (PROJECTS_ROOT)
    const registry = JSON.parse(readFileSync(join(stagedRestored, "command-center/registry.json"), "utf8"));
    for (const project of Array.isArray(registry.projects) ? registry.projects : []) {
      const relative = typeof project.path === "string" && project.path ? project.path : project.name;
      if (typeof relative !== "string" || relative.startsWith("~")) continue; // рантайм-пути (~/.local/state/…) в наборе и не лежат
      projects.total += 1;
      if (existsSync(join(stagedRestored, relative))) projects.present += 1;
      else projects.missing.push(relative);
    }
    checks.push({
      name: "реестр и пути",
      ok: projects.missing.length === 0,
      detail: `проектов ${projects.present} из ${projects.total}${projects.missing.length ? `, нет на месте: ${projects.missing.slice(0, 5).join(", ")}` : ""}`,
    });
  } catch (error) {
    checks.push({ name: "реестр и пути", ok: false, detail: `реестр не разобран: ${error.message}` });
  }

  const gatePath = join(stagedRestored, "command-center/bin", PLATFORM === "win32" ? "docs-check.ps1" : "docs-check.sh");
  if (existsSync(gatePath)) {
    const gate = run(scriptRunner(gatePath), 600_000);
    checks.push({ name: "гейт доков копии", ok: gate.code === 0, detail: firstLine(gate.out) || `код ${gate.code}` });
  } else {
    checks.push({ name: "гейт доков копии", ok: flags.allowMissingDocsGate, detail: flags.allowMissingDocsGate ? "гейта в копии нет — пропуск разрешён флагом" : "гейта в копии нет: восстановление без docs-gate запрещено" });
  }

  const failed = checks.filter((check) => !check.ok);
  const ok = failed.length === 0;
  const nameMatchesVersion = !nameVersion || !version || nameVersion === version;
  if (ok) {
    try {
      if (existsSync(target)) rmSync(target, { recursive: true, force: true });
      renameSync(work, target);
    } catch (error) {
      rmSync(work, { recursive: true, force: true });
      throw new Error(`не удалось зафиксировать распакованную копию (${target}): ${error.message}`);
    }
  } else {
    rmSync(work, { recursive: true, force: true });
  }

  if (flags.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok,
          from: source,
          bytes,
          to: target,
          set: restored,
          version,
          versionInName: nameVersion,
          nameMatchesVersion,
          checksum,
          projects,
          checks,
        },
        null,
        2,
      )}\n`,
    );
    return ok ? 0 : 1;
  }

  process.stdout.write(`восстановил: ${restored}\n`);
  process.stdout.write(`архив: ${source} (${humanSize(bytes)})${checksum.present ? ", сумма сходится" : ", .sha256 рядом нет — целостность не проверена"}\n`);
  for (const check of checks) process.stdout.write(`${check.ok ? "ok  " : "нет "} ${check.name}: ${check.detail}\n`);
  if (!nameMatchesVersion) process.stdout.write(`внимание: в имени архива ${nameVersion}, а внутри ${version} — архив переименован?\n`);
  process.stdout.write(
    ok
      ? `\nкопия живая: версия ${version}, реестр сходится, гейт доков прошёл\n`
      : `\nкопия негодна: не прошло ${failed.length} из ${checks.length} проверок — разбирай архив и набор в нём\n`,
  );
  return ok ? 0 : 1;
}

/** Каталог цели: создаём при необходимости (без -p не обойтись — путь может быть глубоким). */
function mkdirIfNeeded(path) {
  if (existsSync(path)) return;
  const result = run(IS_WIN ? ["cmd.exe", "/c", "mkdir", path] : ["mkdir", "-p", path]);
  if (result.code !== 0 || !existsSync(path)) {
    throw new Error(`каталог цели не создать: ${path} (${firstLine(result.out) || `код ${result.code}`})`);
  }
}

/** Команда для глаза: абсолютные пути внутри диска показываем от его корня (так их и пишут в доках). */
function shownCommand(argv) {
  return argv.map((token) => under(token, PROJECTS_ROOT) ?? under(token, ROOT) ?? token).join(" ");
}

/**
 * Гейт доков внутри сквозной проверки: `bin/docs-check.sh` (на Windows — `bin/docs-check.ps1`, обёртка
 * того же движка) сверяет числа и списки в README/docs с фактом. Вызов мягкий — файла нет, и шаг
 * просто пропускается; но если файл есть и расходится с фактом, сквозная проверка не зелёная: иначе
 * гейт ничего не гейтит. CENTER_DOCS_CHECK — хук для тестов (подменить гейт своим скриптом).
 */
function docsCheckRun(bestEffort = false) {
  // На Windows гейт зовётся своей обёрткой (она идёт в тот же движок), иначе — bash-версией.
  const path = process.env.CENTER_DOCS_CHECK
    ? resolve(process.env.CENTER_DOCS_CHECK)
    : join(ROOT, PLATFORM === "win32" ? "bin/docs-check.ps1" : "bin/docs-check.sh");
  if (!existsSync(path)) {
    const code = bestEffort ? 0 : 1;
    const mode = bestEffort ? "best-effort: шаг пропущен" : "полный check требует gate";
    return { present: false, code, text: `гейта доков нет: ${shownPath(path)} не найден — ${mode}` };
  }
  const runner = scriptRunner(path);
  const result = run(runner);
  if (result.code === -1 || result.code === 127) {
    const code = bestEffort ? 0 : 1;
    const mode = bestEffort ? "best-effort: шаг пропущен" : "полный check требует запускаемый gate";
    return { present: true, code, text: `гейт доков не запустить (${runner[0]} недоступен): ${firstLine(result.out)} — ${mode}` };
  }
  return { present: true, code: result.code, text: result.out || `${shownPath(path)}: без вывода (код ${result.code})` };
}

function cmdCheck(flags = {}) {
  // Полный прогон всегда идёт через Unix-скрипт: на Windows его запускает настоящий Git Bash.
  // PowerShell-обёртка skills-hub-check.ps1 остаётся отдельной ручной проверкой, но не заменяет
  // полный состав соседних станций.
  const check = join(PROJECTS_ROOT, "skills-hub/contrib/skills-hub-check.sh");
  if (!existsSync(check)) throw new Error("не нашёл сквозную проверку skills-hub/contrib/skills-hub-check.sh");
  const result = run(scriptRunner(check));
  process.stdout.write(`${result.out}\n`);
  const docs = docsCheckRun(Boolean(flags.bestEffort));
  const gate = process.env.CENTER_DOCS_CHECK
    ? shownPath(resolve(process.env.CENTER_DOCS_CHECK))
    : PLATFORM === "win32"
      ? "bin/docs-check.ps1"
      : "bin/docs-check.sh";
  process.stdout.write(`\nгейт доков (${gate}):\n${docs.text}\n`);
  let watchCode = 0;
  if (flags.strict) {
    const watchFailures = watchReport().filter((line) => !line.ok && (line.label === "сторож набора" || (line.label === "ночной бэкап" && backupTargets(join(process.env.XDG_CONFIG_HOME ? resolve(process.env.XDG_CONFIG_HOME) : join(HOME, ".config"), "center/backup.target")).length > 0)));
    if (watchFailures.length) {
      watchCode = 1;
      process.stdout.write(`\nтаймеры (--strict): не все активны\n`);
      for (const line of watchFailures) process.stdout.write(`  ${line.label}: ${line.text}\n`);
    }
  }
  return result.code === 0 && docs.code === 0 && watchCode === 0 ? 0 : 1;
}

const argv = process.argv.slice(2);
const commands = new Set(["status", "ps", "logs", "doctor", "verify", "links", "run", "activate", "outdated", "update", "version", "bootstrap", "fresh", "prereqs", "check", "docs", "backup", "release", "restore"]);
const flags = { dryRun: false, json: false, yes: false, deep: false, noCleanup: false, bestEffort: false, strict: false, allowDirty: false, allowMissingChecksum: false, allowMissingDocsGate: false, persona: null, timeout: null, client: null, exclude: null, tail: null, to: null, from: null, keep: null, forceSameDisk: false };
let command = null;
const positional = [];

/**
 * Отказ по контракту: неизвестное имя или флаг — это не «молча сделать status с нулём», а строка
 * с тем, что именно не понято, и код 1. Так опечатка в команде видна сразу, а не выглядит как отчёт.
 */
function refuse(message) {
  process.stderr.write(`center: ${message}\n`);
  process.exit(1);
}

for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === "--dry-run") flags.dryRun = true;
  else if (arg === "--json") flags.json = true;
  else if (arg === "--yes") flags.yes = true;
  else if (arg === "--deep") flags.deep = true;
  else if (arg === "--no-cleanup") flags.noCleanup = true;
  else if (arg === "--best-effort") flags.bestEffort = true;
  else if (arg === "--strict") flags.strict = true;
  else if (arg === "--allow-dirty") flags.allowDirty = true;
  else if (arg === "--allow-missing-checksum") flags.allowMissingChecksum = true;
  else if (arg === "--allow-missing-docs-gate") flags.allowMissingDocsGate = true;
  else if (arg === "--force-same-disk") flags.forceSameDisk = true;
  else if (arg === "--persona") flags.persona = argv[++i];
  else if (arg === "--timeout") flags.timeout = argv[++i];
  else if (arg === "--client") flags.client = argv[++i];
  else if (arg === "--exclude") flags.exclude = argv[++i];
  else if (arg === "--to") flags.to = argv[++i];
  else if (arg === "--from") flags.from = argv[++i];
  else if (arg === "--keep") {
    flags.keep = Number(argv[++i]);
    if (!Number.isInteger(flags.keep) || flags.keep <= 0) {
      process.stderr.write("center: --keep принимает число архивов (целое, ≥ 1)\n");
      process.exit(2);
    }
  }
  else if (arg === "--tail") {
    flags.tail = Number(argv[++i]);
    if (!Number.isInteger(flags.tail) || flags.tail <= 0) {
      process.stderr.write("center: --tail принимает число строк (целое, ≥ 1)\n");
      process.exit(2);
    }
  }
  else if (arg === "-h" || arg === "--help") {
    usage();
    process.exit(0);
  } else if (arg.startsWith("-")) {
    refuse(`неизвестный флаг ${arg} (см. center --help)`);
  } else if (command === null) {
    if (!commands.has(arg)) refuse(`неизвестная команда ${arg} (см. center --help)`);
    command = arg;
  } else positional.push(arg);
}
command = command ?? "status";

try {
  let code = 0;
  if (command === "status") code = cmdStatus(flags.json, flags.strict);
  else if (command === "ps") code = cmdPs(flags.json);
  else if (command === "logs") {
    if (!positional[0]) throw new Error("нужно имя проекта: center logs mcp-station [--tail 20]");
    code = cmdLogs(positional[0], flags.tail, flags.json);
  } else if (command === "doctor") code = cmdDoctor();
  else if (command === "verify") code = cmdVerify({ ...flags, servers: positional });
  else if (command === "links") code = cmdLinks();
  else if (command === "run") {
    if (!positional[0]) throw new Error("нужно имя проекта: center run skills-hub search pdf");
    code = cmdRun(positional[0], positional.slice(1));
  } else if (command === "activate") code = cmdActivate(positional, flags.dryRun);
  else if (command === "outdated") code = cmdOutdated(flags.json);
  else if (command === "update") code = cmdUpdate(positional, flags);
  else if (command === "version") code = cmdVersion(flags.json);
  else if (command === "bootstrap") code = cmdBootstrap(flags.dryRun);
  else if (command === "fresh") code = cmdFresh(flags);
  else if (command === "docs") code = cmdDocs(positional[0], flags.json);
  else if (command === "prereqs") code = cmdPrereqs();
  else if (command === "backup") code = cmdBackup(flags);
  else if (command === "release") code = cmdRelease(flags);
  else if (command === "restore") code = cmdRestore(flags);
  else if (command === "check") code = cmdCheck(flags);
  bye(code);
} catch (error) {
  process.stderr.write(`center: ${error.message}\n`);
  process.exit(1);
}
