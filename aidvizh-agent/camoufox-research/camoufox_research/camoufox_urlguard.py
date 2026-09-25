#!/usr/bin/env python3
"""Страж URL: пропускаем только http(s) на публичный адрес.

Зачем (аудит 21.09): URL приходит агенту со страницы-источника, то есть
частично управляется атакующим. Без стража:
  * `fetch_page("file:///etc/passwd")` / `session_navigate("file:///…")`
    + `session_text` — локальный файл (LFI) попадает в контекст агента;
  * `http://127.0.0.1:8833/…`, `169.254.169.254`, `*.internal` — SSRF
    через доверенный браузер владельца (внутренние сервисы, метаданные
    облака, роутеры);
  * `data:`/`blob:`/`javascript:` — обход любых дальнейших фильтров.

Правило: схема http/https и хост не из внутренних диапазонов. Вентили
для отладки: `CAMOUFOX_ALLOW_FILE=1` (разрешить file://),
`CAMOUFOX_ALLOW_PRIVATE=1` (разрешить локальные адреса).

DNS не резолвим (медленно и всё равно гонка TOCTOU) — режем литеральные
IP, короткие/числовые формы (127.1, 2130706433) и спец-имена.
"""

import ipaddress
import os
import re
import socket
import urllib.parse

_ALLOWED_SCHEMES = ("http", "https")
# Спец-имена, которые всегда локальны (суффикс): .local(mDNS), .internal
# (частые split-horizon), .home.arpa (RFC 8375), .localhost (RFC 6761).
_LOCAL_SUFFIXES = (".local", ".internal", ".home.arpa", ".localhost", ".lan")
_LOCAL_NAMES = ("localhost", "localhost.localdomain", "ip6-localhost")
_NUMERICISH = re.compile(r"^[0-9a-fA-FxX.]+$")


def _env_flag(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in ("1", "true", "yes", "on")


def _ip_from_host(host: str):
    """IP из хоста, включая короткие/числовые формы (127.1, 2130706433)."""
    host = host.strip("[]")
    try:
        return ipaddress.ip_address(host)
    except ValueError:
        pass
    if not _NUMERICISH.match(host):
        return None
    if host.isdigit():
        try:
            return ipaddress.ip_address(int(host))
        except ValueError:
            return None
    try:  # inet_aton понимает «127.1» и «0x7f.0.0.1» — то, за чем прячется SSRF
        return ipaddress.ip_address(socket.inet_aton(host))
    except (OSError, ValueError):
        return None


def _is_internal(ip) -> bool:
    return bool(
        ip.is_private or ip.is_loopback or ip.is_link_local
        or ip.is_reserved or ip.is_multicast or ip.is_unspecified
    )


def check_url(url: str) -> str:
    """Вернуть URL, если он безопасен; иначе ValueError с причиной.

    Вызывается на КАЖДОМ входе URL от пользователя/страницы: браузерные
    навигации (_goto, page.goto) и urllib/ctx.request-ветки (crawl, docs,
    download). Внутренние адреса сервисов (arXiv, DDG, DeepSeek) сюда не
    ходят — они заданы в коде, а не приходят снаружи.
    """
    raw = (url or "").strip()
    if not raw:
        raise ValueError("ошибка: пустой URL")
    try:
        sp = urllib.parse.urlsplit(raw)
    except ValueError as e:  # кривой URL — тоже отказ
        raise ValueError(f"ошибка: URL не разобран ({e})") from e
    scheme = (sp.scheme or "").lower()
    if not scheme:
        raise ValueError("ошибка: нет схемы в URL (нужен http:// или https://)")
    if scheme not in _ALLOWED_SCHEMES:
        if scheme == "file" and _env_flag("CAMOUFOX_ALLOW_FILE"):
            return raw
        raise ValueError(
            f"ошибка: схема '{scheme}' запрещена "
            "(разрешены http/https; file — только с CAMOUFOX_ALLOW_FILE=1)"
        )
    host = (sp.hostname or "").lower()
    if not host:
        raise ValueError("ошибка: в URL нет хоста")
    if _env_flag("CAMOUFOX_ALLOW_PRIVATE"):
        return raw
    if host in _LOCAL_NAMES or host.endswith(_LOCAL_SUFFIXES):
        raise ValueError(f"ошибка: внутренний адрес '{host}' запрещён "
                         "(CAMOUFOX_ALLOW_PRIVATE=1 — если это осознанно)")
    ip = _ip_from_host(host)
    if ip is not None and _is_internal(ip):
        raise ValueError(f"ошибка: внутренний адрес '{host}' запрещён "
                         "(CAMOUFOX_ALLOW_PRIVATE=1 — если это осознанно)")
    return raw
