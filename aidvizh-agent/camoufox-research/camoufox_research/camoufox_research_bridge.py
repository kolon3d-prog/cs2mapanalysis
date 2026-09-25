#!/usr/bin/env python3
# Источник: t.me/aidvizhenie · admin h-i-l-artem · канал и гиг: aidvizh_hub

"""Мост сервер→воркер (вынесено из camoufox_research.py, canon/FILE-SIZE.md):
production-гейты (auth/rate-limit) + живой воркер-процесс + _call.

Воркер — отдельный процесс (camoufox_worker.py --serve): браузер живёт
между вызовами. Чтение stdout — поток-читатель + queue (select нельзя
смешивать с TextIOWrapper — дедлок, проверено 08.2026). Lock держим
только на спавн и запись в stdin: FastMCP выполняет тулы в thread pool,
и ответ ждать под локом нельзя — один research (до 900с) замораживает
stats/research_status для всех остальных (аудит 21.09)."""

from pathlib import Path as _Path
import itertools
import json
import os
import queue
import subprocess
import sys
import threading
import time

# Класс ошибки тула берём из SDK: только он доезжает до клиента как
# isError=true с текстом (свой RuntimeError SDK считает крахом, см. ниже).
from mcp.server.mcpserver.exceptions import ToolError as _sdk_ToolError
try:
    from camoufox_research import camoufox_paths as _paths
except ImportError:
    import camoufox_paths as _paths

WORKER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "camoufox_worker.py")

# --- Production: healthcheck + rate-limit + auth (MCP Best Practices 9,11) ---
_START_TIME = time.monotonic()
_RATE_LIMIT: dict[str, list[float]] = {}
_RATE_LIMIT_MAX = int(os.environ.get("CAMOUFOX_RATE_LIMIT", "60"))  # max calls/min global
_RATE_LIMIT_WINDOW = 60.0
_AUTH_KEY = os.environ.get("CAMOUFOX_API_KEY", "").strip()

def _check_auth(kwargs: dict) -> str | None:
    """Если CAMOUFOX_API_KEY задан — требуем api_key в kwargs, иначе 401."""
    if not _AUTH_KEY:
        return None
    provided = str(kwargs.get("api_key", "")).strip() or str(kwargs.get("auth", "")).strip()
    if provided != _AUTH_KEY:
        return (
            "ошибка: 401 Unauthorized — неверный api_key "
            "(задай CAMOUFOX_API_KEY env и передай api_key в вызов)"
        )
    return None

def _check_rate_limit(action: str) -> str | None:
    """Простой fixed-window: max _RATE_LIMIT_MAX вызовов в 60с, иначе 429."""
    if _RATE_LIMIT_MAX <= 0:
        return None
    now = time.monotonic()
    # чистим старые
    for k in list(_RATE_LIMIT.keys()):
        _RATE_LIMIT[k] = [t for t in _RATE_LIMIT[k] if now - t < _RATE_LIMIT_WINDOW]
        if not _RATE_LIMIT[k]:
            del _RATE_LIMIT[k]
    # глобальный + per-action
    total = sum(len(v) for v in _RATE_LIMIT.values())
    if total >= _RATE_LIMIT_MAX:
        wait = int(
            _RATE_LIMIT_WINDOW - (now - min(min(v) for v in _RATE_LIMIT.values()))
        )
        return (
            f"ошибка: 429 Too Many Requests — лимит {_RATE_LIMIT_MAX}/мин, "
            f"подожди {wait}с"
        )
    lst = _RATE_LIMIT.setdefault(action, [])
    if len(lst) >= _RATE_LIMIT_MAX // 2:  # per-action половина глобального
        return f"ошибка: 429 Too Many Requests — лимит для {action} {_RATE_LIMIT_MAX // 2}/мин"
    lst.append(now)
    return None

# Живой воркер (serve-режим): браузер держится между вызовами.
_worker_state = None  # {"proc": Popen, "queue": Queue}

# Лок — только на спавн и запись в stdin, ответ ждём ВНЕ него: иначе один
# research (до 900с) держит остальные вызовы, и stats/research_status молчат
# (аудит 21.09). Ответ адресуем по id: у каждого вызова своя очередь —
# короткий не ждёт длинный, ответы не путаются между потоками FastMCP.
_worker_lock = threading.Lock()
_worker_pending: dict[int, queue.Queue] = {}
_worker_seq = itertools.count(1)

def _read_loop(proc, q):
    """Фон: строки из stdout воркера → очередь ТОГО, КТО ЖДЁТ ответ.

    Ответ без id (старый воркер, разовый режим) отдаём САМОМУ РАННЕМУ
    ждущему: раньше вызовы моста были сериализованы, значит ответы шли
    FIFO — прежний протокол обязан работать. Ответ на брошенный запрос (id
    вычищен по таймауту) роняем: ждущего нет, а отдать его соседу — выдать
    чужому вызову чужие данные."""
    for line in proc.stdout:
        line = line.strip()
        if not line:
            continue
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError:
            continue  # мусорная строка (лог браузера) — пропускаем
        if not isinstance(parsed, dict):
            continue
        rid = parsed.get("id")
        if rid is None:  # без id — самому раннему ждущему (FIFO, как раньше)
            target = next(iter(_worker_pending.values()), None)
        else:
            target = _worker_pending.get(rid)
        if target is not None:
            target.put(parsed)
        elif rid is None:
            q.put(parsed)
    q.put(None)  # EOF: разбудить всех ждущих
    for waiting in list(_worker_pending.values()):
        waiting.put(None)

def _worker_proc():
    global _worker_state
    with _worker_lock:  # спавн под локом: два потока не поднимут двух воркеров
        if _worker_state is None or _worker_state["proc"].poll() is not None:
            # nosemgrep: python36-compatibility-Popen — версии 3.10+ (семгреп придирается)
            proc = subprocess.Popen(
                [sys.executable, WORKER, "--serve"],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                # nosemgrep: python36-compatibility-Popen — воркспейс на Python
                # 3.10+, errors=/encoding= доступны с 3.6 (семгреп-эвристика)
                stderr=subprocess.DEVNULL,
                text=True,
                encoding="utf-8",
                errors="replace",
            )
            q = queue.Queue()
            t = threading.Thread(target=_read_loop, args=(proc, q), daemon=True)
            t.start()
            _worker_state = {"proc": proc, "queue": q}
    return _worker_state

def _call_live(req, timeout, rid=None):
    """Запрос к живому воркеру: JSON-строка в stdin, ответ — из очереди.

    Ждём ответ ВНЕ лока (он только на запись в stdin). По таймауту воркер
    НЕ убиваем: браузер и вкладки сессии переживают это, а у действия с
    побочными эффектами не появляется второй попытки (решает _call).
    Без id (rid=None) работаем как раньше — читаем общую очередь.
    """
    state = _worker_proc()
    proc = state["proc"]
    reply = queue.Queue()
    if rid is not None:
        _worker_pending[rid] = reply
    try:
        with _worker_lock:
            try:
                proc.stdin.write(req + "\n")
                proc.stdin.flush()
            except (BrokenPipeError, OSError) as e:
                # Состояние не чистим руками: мёртвый процесс увидит
                # _worker_proc() по poll() и поднимет нового.
                raise RuntimeError("воркер упал при записи") from e
        src = reply if rid is not None else state["queue"]
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(f"воркер не ответил за {timeout}с")
            try:
                line = src.get(timeout=remaining)
            except queue.Empty as e:
                raise TimeoutError(f"воркер не ответил за {timeout}с") from e
            if line is None:
                raise RuntimeError("воркер закрыл stdout") from None
            return _parse(line)
    finally:
        if rid is not None:
            _worker_pending.pop(rid, None)

def _parse(parsed):
    if "error" in parsed:
        return f"{ERR_PREFIX} {parsed['error']}"
    return parsed.get("result", "")


# --- Контракт ошибок MCP (21.09) -----------------------------------------
# Было: ошибка ехала СТРОКОЙ с префиксом «ошибка:», FastMCP отдавал её как
# успешный результат (isError=false) — агент не мог отличить сбой от ответа
# (живая проба: isError=false на «ошибка: TypeError: research_start()…»).
# Стало: строку с префиксом обёртка тула превращает в ИСКЛЮЧЕНИЕ.
# ВАЖНО: бросать надо ИМЕННО класс SDK (проверено живьём) — свой
# RuntimeError SDK считает крахом (`UnexpectedToolError`), прячет текст
# ошибки и оставляет агенту только «Error executing tool X». SDK-шный
# ToolError доезжает как isError=true С ТЕКСТОМ.
ERR_PREFIX = "ошибка:"

ToolError = _sdk_ToolError


def tool_call(action, **kwargs):
    """Обёртка тул→воркер: ответ отдаём, ошибку бросаем.

    Единственная точка, где строковый ABI воркера превращается в
    протокольный isError. Тул, который «вернул» текст ошибки, для клиента
    неотличим от успеха — поэтому дальше неё ошибка не проходит.
    """
    out = _call(action, **kwargs)
    if isinstance(out, str) and out.startswith(ERR_PREFIX):
        raise ToolError(out)
    return out

# Счётчик вызовов тулов (usage-метрика 28.08): каждый реальный вызов
# через _call инкрементится — tool_usage() читает для «какие тулы
# реально зовутся». Персистентно: JSON в кэше (загрузка при импорте,
# запись при каждом инкременте) — переживает рестарт воркера.
_USAGE_FILE = _paths.usage_file()  # legacy-алиас; код берёт _usage_file()


def _usage_file() -> _Path:
    """Файл метрики вызовов (лениво: env CAMOUFOX_CACHE_DIR)."""
    return _paths.usage_file()


def _usage_load() -> dict[str, dict]:
    """Читаем usage: новый формат {tool: {count, last}} или СТАРЫЙ
    {tool: count} (миграция 28.08: дата последнего вызова нужна для
    «тул не звался 30 дней → кандидат на резку»)."""
    try:
        if _usage_file().exists():
            import json
            data = json.loads(_USAGE_FILE.read_text(encoding="utf-8"))
            out = {}
            for k, v in data.items():
                if isinstance(v, dict):
                    out[k] = v
                else:  # старый формат: v = count
                    out[k] = {"count": v, "last": None}
            return out
    except Exception:
        pass
    return {}


def _usage_save(data: dict) -> None:
    try:
        import json
        _usage_file().parent.mkdir(parents=True, exist_ok=True)
        _usage_file().write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    except Exception:
        pass  # метрика — бонус, не роняем вызов


_TOOL_USAGE: dict[str, dict] = _usage_load()


# --- Свой срок и права на повтор у каждого действия (аудит 21.09) --------
# Было одно дефолтных 120с на всё: check_links (max_links 50 × timeout 15с =
# 750с худшего случая), crawl, digest, citation_pack и table_extract не
# укладывались — мост убивал воркер НА ПОЛПУТИ (вместе с браузером и
# вкладками сессии) и переигрывал запрос в новом процессе.
DEFAULT_TIMEOUT = 120
_LONG = 900  # волны поиска / 50 ссылок × 15с / LLM-выжимка по источникам
_ACTION_TIMEOUT = dict.fromkeys(
    ("check_links", "crawl", "research", "research_start", "research_resume",
     "research_digest", "citation_pack"), _LONG,
) | {"citation_report": 600, "batch_fetch": 600, "table_extract": 300}

# Коллизия имён (аудит 21.09): у этих действий ЕСТЬ свой аргумент timeout —
# check_links считает по нему срок НА ССЫЛКУ, session_wait_for/download — на
# ожидание. Тулы шлют его как call(..., timeout=...) и попадают в бюджет RPC:
# check_links просил 15с бюджета на работу в 750с и не укладывался НИКОГДА,
# даже с планкой из таблицы выше. Для них timeout — аргумент действия, а
# бюджет берём свой (с запасом 30с, чтобы внутренний срок успел истечь сам:
# иначе клиент получит таймаут моста вместо честного «не дождался»).
_OWN_TIMEOUT_ACTIONS = frozenset({"check_links", "session_wait_for", "session_download"})

# Действия с побочными эффектами: повтор = тихое двойное выполнение. Разовый
# процесс не видит ни браузера, ни вкладок сессии — второй session_start
# открывает вкладку заново, второй research_start заводит вторую кампанию на
# ту же тему. Их не переигрываем никогда, только честная ошибка.
_SIDE_EFFECTS = frozenset(
    {"research_start", "research_resume", "set_proxy", "profile_save", "profile_load"}
)


def _is_side_effect(action: str) -> bool:
    return action.startswith("session_") or action in _SIDE_EFFECTS


def _call(action, timeout=None, **kwargs):
    import time as _t

    rec = _TOOL_USAGE.get(action, {"count": 0, "last": None})
    rec["count"] = rec.get("count", 0) + 1
    rec["last"] = _t.time()
    _TOOL_USAGE[action] = rec
    _usage_save(_TOOL_USAGE)
    # production gates
    err = _check_auth(kwargs)
    if err:
        return err
    kwargs.pop("api_key", None)
    kwargs.pop("auth", None)
    err = _check_rate_limit(action)
    if err:
        return err
    if action in _OWN_TIMEOUT_ACTIONS:  # timeout — аргумент действия, не бюджет
        own = timeout
        if own is not None:
            kwargs["timeout"] = own
        timeout = max(_ACTION_TIMEOUT.get(action, DEFAULT_TIMEOUT), (own or 0) + 30)
    elif timeout is None:  # тул не назвал срок — берём планку самого действия
        timeout = _ACTION_TIMEOUT.get(action, DEFAULT_TIMEOUT)
    rid = next(_worker_seq)
    req = json.dumps({"action": action, "id": rid, **kwargs})
    try:
        return _call_live(req, timeout, rid)
    except Exception as e:
        if _is_side_effect(action):
            return (
                f"ошибка: {action} не обслужен ({type(e).__name__}: {e}) — повтор "
                f"не делаю: побочные эффекты (повтор = двойное выполнение). Воркер "
                f"жив, работа может доработать: проверь session_status/research_status."
            )
        # фолбэк: разовый запуск воркера. Для действий БЕЗ побочек повтор
        # безопасен; раньше это был единственный путь для всех — живой
        # воркер убивался даже когда его браузер и сессия были нужны.
        try:
            proc = subprocess.run(
                [sys.executable, WORKER, req],
                capture_output=True,
                text=True,
                timeout=timeout,
                check=False,
            )
        except subprocess.TimeoutExpired:
            # Явная ошибка, а не исключение наружу: SDK превратил бы
            # TimeoutExpired в «Error executing tool» без текста и причины.
            return f"ошибка: {action} не уложился и в разовом воркере ({timeout}с)"
        out = proc.stdout.strip()
        if not out:
            return f"ошибка: пустой ответ воркера ({type(e).__name__})"
        try:
            return _parse(json.loads(out))
        except json.JSONDecodeError:
            return f"ошибка: не-JSON ответ: {out[:120]}"
