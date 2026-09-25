#!/usr/bin/env python3
"""Единственный источник путей состояния сервера (вентиль CAMOUFOX_CACHE_DIR).

Зачем модуль (аудит 21.09, находка F1): восемь мест в пакете склеивали путь
из `Path.home()` в момент ИМПОРТА, поэтому `CAMOUFOX_CACHE_DIR` — который
читают скрипты и пишет установщик в `config.env` — сервер игнорировал. Итог:
кэш, экспорт, профили, скриншоты, загрузки и память уезжали в домашний
каталог, а бэкап/пульс/статистика смотрели в указанный (пустой бэкап,
«кэш пуст», нулевая статистика). Docker спасался симлинком на `/data`.

Правила:
  * резолвим ЛЕНИВО (функцией, в момент вызова) — env меняется без перезапуска
    и подменяется в тестах; иначе снова получим «на импорте»;
  * дефолт — ОС-корректный кэш-каталог: Linux `~/.cache`, macOS
    `~/Library/Caches`, Windows `%LOCALAPPDATA%\\Cache` (стандарт XDG/Apple);
  * вентиль `CAMOUFOX_CACHE_DIR` перекрывает дефолт целиком (одна точка правды).
"""

import os
import sys
from pathlib import Path

_APP = "camoufox-research"


def cache_dir() -> Path:
    """Каталог состояния: env → ОС-дефолт. Все остальные пути — от него."""
    env = os.environ.get("CAMOUFOX_CACHE_DIR", "").strip()
    if env:
        return Path(env).expanduser()
    home = Path.home()
    if sys.platform == "darwin":
        return home / "Library" / "Caches" / _APP
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA") or str(home / "AppData" / "Local")
        return Path(base) / _APP / "Cache"
    return home / ".cache" / _APP


def cache_db() -> Path:
    return cache_dir() / "cache.db"


def export_dir() -> Path:
    return cache_dir() / "exports"


def shots_dir() -> Path:
    return cache_dir() / "shots"


def downloads_dir() -> Path:
    return cache_dir() / "downloads"


def profiles_dir() -> Path:
    return cache_dir() / "profiles"


def research_dir() -> Path:
    return cache_dir() / "research"


def watchdog_log() -> Path:
    env = os.environ.get("CAMOUFOX_WATCHDOG_LOG", "").strip()
    return Path(env).expanduser() if env else cache_dir() / "watchdog.log"


def memory_file() -> Path:
    env = os.environ.get("CAMOUFOX_MEMORY_FILE", "").strip()
    return Path(env).expanduser() if env else cache_dir() / "memory.md"


def usage_file() -> Path:
    return cache_dir() / "tool_usage.json"


def dev_dir() -> Path:
    """Артефакты отладки/харнессов (экспортится через CAMOUFOX_DEV_DIR)."""
    env = os.environ.get("CAMOUFOX_DEV_DIR", "").strip()
    return Path(env).expanduser() if env else cache_dir() / "dev"


def ensure(path: Path) -> Path:
    """Создать каталог и вернуть его (частый случай: `ensure(export_dir())`)."""
    path.mkdir(parents=True, exist_ok=True)
    return path
