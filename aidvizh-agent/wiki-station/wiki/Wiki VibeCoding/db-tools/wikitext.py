#!/usr/bin/env python3
"""Общий слой для поискового движка вики: разбор frontmatter + нормализация текста.

Один и тот же код используют build.py (индексирует базу) и search.py (обрабатывает
запрос) — иначе нормализованные токены в базе и в запросе разошлись бы.

Нормализация токена:
- регистр → нижний;
- разделители: всё не-буквенно-цифровое (дефис, точка, слэш, подчёркивание) режет токены,
  поэтому `sing-box` и `sing.box` дают одни токены, а `wireguard` остаётся собой;
- стоп-слова ru+en выкидываются;
- лёгкий русский стеммер по суффиксам (Snowball-типа) — только для токенов с кириллицей,
  латиница (`wireguard`, `vless`, `singbox`) не трогается;
- транслит в обе стороны: `впн` → `vpn`, `tunnel` → `туннел`, чтобы русский и латинский
  варианты одного слова находились.

Текст, который уходит в FTS: сначала идут основные (стеммингованные) токены в исходном
порядке — чтобы работал поиск по фразе, — а затем блок вариантов транслита.
"""
from __future__ import annotations

import re
from pathlib import Path

SKIP_FILES = frozenset({"README.md", "index.md", "log.md"})
SKIP_DIRS = frozenset({"_templates", "db", "db-tools", ".git", "node_modules"})

TOKEN_RE = re.compile(r"[^\W_]+", re.UNICODE)

STOP_WORDS = frozenset(
    """
    а без бы был была были было быть вам вас вдруг ведь во вот все всего всех всю вы
    где да даже для до его ее ей ему если есть еще ж же за и из или им их к как какая
    какой когда конечно кто куда ли лучше между меня мне много можно мой моя мы на над
    надо нас не него нее ней нет ни никогда ним них но ну о об один он она они опять от
    очень по под после потом потому почти при про раз разве с сам себе себя сейчас со
    совсем так такой там тебя тем теперь то тоже том тот тут ты у уж уже хорошо хоть чего
    чем через что чтоб чтобы эту эта эти это этой этом этот я
    a about after all also am an and any are as at be because been before being but by
    can did do does doing don for from had has have he her here him his how i if in into
    is it its just me more most my no not of off on once only or other our out over own
    same she should so some such than that the their them then there these they this those
    through to too under until up very was we were what when where which while who why will
    with would you your
    """.split()
)

# Суффиксы отсортированы от длинных к коротким: срезаем самый длинный подходящий.
_RU_SUFFIXES = tuple(
    sorted(
        {
            "иями", "ями", "ами", "ией", "иях", "иям", "ием", "ыми", "ими", "ей", "ой",
            "ый", "ий", "ая", "яя", "ое", "ее", "ые", "ие", "ью", "ья", "ье", "ия", "ию",
            "ии", "ов", "ев", "ах", "ях", "ам", "ям", "ом", "ем", "им", "ым", "ых", "их",
            "ок", "ек", "ей", "ий", "я", "ю", "а", "е", "и", "о", "у", "ы", "ь", "й",
        },
        key=len,
        reverse=True,
    )
)

_MIN_STEM = 3

_RU2LAT = {
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "e", "ж": "zh",
    "з": "z", "и": "i", "й": "i", "к": "k", "л": "l", "м": "m", "н": "n", "о": "o",
    "п": "p", "р": "r", "с": "s", "т": "t", "у": "u", "ф": "f", "х": "h", "ц": "c",
    "ч": "ch", "ш": "sh", "щ": "shch", "ъ": "", "ы": "y", "ь": "", "э": "e", "ю": "yu",
    "я": "ya",
}
_LAT2RU = {
    "a": "а", "b": "б", "c": "к", "d": "д", "e": "е", "f": "ф", "g": "г", "h": "х",
    "i": "и", "j": "й", "k": "к", "l": "л", "m": "м", "n": "н", "o": "о", "p": "п",
    "q": "к", "r": "р", "s": "с", "t": "т", "u": "у", "v": "в", "w": "в", "x": "кс",
    "y": "ы", "z": "з",
}

_CYR_RE = re.compile(r"[а-яё]", re.IGNORECASE)
_LAT_RE = re.compile(r"^[a-z]+$")


def base_tokens(text: str) -> list[str]:
    """Токены как есть: нижний регистр, разделители — всё не-буквенно-цифровое."""
    return TOKEN_RE.findall(text.lower())


def is_stopword(token: str) -> bool:
    return token in STOP_WORDS


def stem(token: str) -> str:
    """Лёгкий стеммер: срезает частотные русские окончания. Латиницу не трогает."""
    if not _CYR_RE.search(token):
        return token
    for suffix in _RU_SUFFIXES:
        if token.endswith(suffix) and len(token) - len(suffix) >= _MIN_STEM:
            return token[: -len(suffix)]
    return token


def ru_to_lat(token: str) -> str:
    if not _CYR_RE.search(token):
        return token
    return "".join(_RU2LAT.get(ch, ch) for ch in token)


def lat_to_ru(token: str) -> str:
    if not _LAT_RE.match(token):
        return token
    return "".join(_LAT2RU.get(ch, ch) for ch in token)


def variants(token: str) -> list[str]:
    """Токен + его транслит-двойник (если отличается): vpn ↦ впн, туннель ↦ tunnel."""
    out = [token]
    other = ru_to_lat(token) if _CYR_RE.search(token) else lat_to_ru(token)
    if other and other != token:
        out.append(other)
    return out


def primary_tokens(text: str) -> list[str]:
    """Стеммингованные токены без стоп-слов — «смысловые» слова текста."""
    out: list[str] = []
    for token in base_tokens(text):
        if is_stopword(token):
            continue
        stemmed = stem(token)
        if stemmed and stemmed not in out:
            out.append(stemmed)
    return out


def normalize(text: str) -> str:
    """Текст для FTS: основные токены (в порядке появления) + блок транслит-вариантов."""
    primaries = primary_tokens(text)
    extra: list[str] = []
    for token in primaries:
        for variant in variants(token)[1:]:
            if variant not in primaries and variant not in extra:
                extra.append(variant)
    return " ".join(primaries + extra)


def query_terms(query: str) -> list[dict]:
    """Термины запроса: основной токен + варианты, по которым ищем в FTS (OR)."""
    terms = []
    for primary in primary_tokens(query):
        terms.append({"primary": primary, "variants": variants(primary)})
    return terms


def query_string_tokens(query: str) -> list[str]:
    """Сырые токены запроса без стемминга — для подстрочного (trigram) поиска."""
    seen: list[str] = []
    for token in base_tokens(query):
        if len(token) >= 3 and not is_stopword(token) and token not in seen:
            seen.append(token)
    return seen


# --------------------------------------------------------------------------- #
# frontmatter
# --------------------------------------------------------------------------- #

_FLOW_RE = re.compile(r"^\[(.*)\]$", re.DOTALL)
_BLOCK_RE = re.compile(r"^([>|])([-+]?)(\d*)$")
_HASHTAG_RE = re.compile(r"#\S+")


def _unquote(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        inner = value[1:-1]
        if value[0] == "'":
            return inner.replace("''", "'")
        return re.sub(r"\\(.)", r"\1", inner)
    return value


def _flow_list(value: str) -> list[str]:
    inner = value[1:-1]
    items, current, quote = [], "", ""
    for ch in inner:
        if quote:
            current += ch
            if ch == quote:
                quote = ""
        elif ch in "\"'":
            quote = ch
            current += ch
        elif ch == ",":
            items.append(current)
            current = ""
        else:
            current += ch
    items.append(current)
    return [item for item in (_unquote(part.strip()) for part in items) if item]


def _closing_quote(value: str, quote: str) -> int:
    """Индекс закрывающей кавычки в скаляре, начинающемся с кавычки (-1 — не закрыт).
    В одинарных кавычках `''` — экранированная кавычка, в двойных — `\\X`."""
    i = 1
    while i < len(value):
        ch = value[i]
        if quote == '"' and ch == "\\":
            i += 2
            continue
        if ch == quote:
            if quote == "'" and value[i + 1 : i + 2] == "'":
                i += 2
                continue
            return i
        i += 1
    return -1


def _consume_quoted(lines: list[str], start: int, rest: str) -> tuple[str, int]:
    """Склеивает многострочный скаляр: перевод строки у YAML сворачивается в пробел."""
    quote = rest[0]
    parts = [rest.rstrip()]
    i = start
    index = _closing_quote(parts[0], quote)
    while index == -1 and i < len(lines):
        parts.append(lines[i].strip())
        i += 1
        index = _closing_quote(" ".join(parts), quote)
    joined = " ".join(parts)
    index = _closing_quote(joined, quote)
    inner = joined[1:index] if index != -1 else joined[1:]
    if quote == "'":
        inner = inner.replace("''", "'")
    else:
        inner = re.sub(r"\\(.)", r"\1", inner)
    return inner.strip(), i


def parse_frontmatter(text: str) -> tuple[dict, str]:
    """Разбор YAML-frontmatter вики: скаляры, многострочные скаляры, `>`/`|`-блоки,
    списки (`[a, b]` и `- пункт`), вложенные словари пропускаются как необязательные."""
    if not text.startswith("---"):
        return {}, text
    end = text.find("\n---", 3)
    if end == -1:
        return {}, text
    head = text[3:end]
    body = text[end + 4 :]
    lines = head.splitlines()
    data: dict = {}
    i = 0
    while i < len(lines):
        line = lines[i]
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            i += 1
            continue
        if line[:1] in (" ", "\t"):
            i += 1
            continue  # вложенность без ключа — не наш случай
        key, sep, rest = line.partition(":")
        if not sep:
            i += 1
            continue
        key = key.strip()
        rest = rest.strip()
        i += 1

        block = _BLOCK_RE.match(rest)
        if block:
            collected, indent = [], None
            while i < len(lines) and (not lines[i].strip() or lines[i][:1] in (" ", "\t")):
                raw = lines[i]
                if not raw.strip():
                    collected.append("")
                else:
                    if indent is None:
                        indent = len(raw) - len(raw.lstrip())
                    collected.append(raw[indent:].rstrip())
                i += 1
            if block.group(1) == ">":
                value = " ".join(part for part in collected if part)
            else:
                value = "\n".join(collected)
            data[key] = value.strip()
            continue

        if rest in ("",):
            items: list[str] = []
            nested = False
            while i < len(lines):
                raw = lines[i]
                if not raw.strip():
                    i += 1
                    continue
                if raw[:1] not in (" ", "\t") and not raw.lstrip().startswith("- "):
                    break
                if raw.lstrip().startswith("- "):
                    items.append(_unquote(raw.lstrip()[2:].strip()))
                    i += 1
                    continue
                nested = True
                i += 1
            data[key] = items if items else ({} if nested else [])
            continue

        if rest.startswith("#") and len(_HASHTAG_RE.findall(rest)) > 1:
            data[key] = [tag.lstrip("#") for tag in _HASHTAG_RE.findall(rest)]
            continue

        flow = _FLOW_RE.match(rest)
        if flow:
            data[key] = _flow_list(rest)
            continue

        if rest[0] in "\"'":
            value, i = _consume_quoted(lines, i, rest)
            data[key] = value
            continue

        # скаляр; многострочный plain-скаляр сворачивается пробелом, « #» — комментарий
        parts = [re.split(r"\s+#", rest, maxsplit=1)[0].strip()]
        while (
            i < len(lines)
            and lines[i][:1] in (" ", "\t")
            and lines[i].strip()
            and not lines[i].lstrip().startswith(("- ", "#"))
        ):
            parts.append(lines[i].strip())
            i += 1
        data[key] = " ".join(part for part in parts if part)
    return data, body.strip()


def tags_of(meta: dict) -> list[str]:
    """Теги из frontmatter в список строк (список, строка через запятую, одиночный тег)."""
    raw = meta.get("tags") or []
    if isinstance(raw, str):
        raw = [part.strip() for part in raw.split(",")]
    return [str(tag).strip() for tag in raw if str(tag).strip()]


def iter_post_paths(root: Path):
    """Пути всех постов вики (без чтения файлов) — (относительный путь, абсолютный путь)."""
    for path in sorted(root.rglob("*.md")):
        rel = path.relative_to(root)
        if path.name in SKIP_FILES or any(part in SKIP_DIRS for part in rel.parts):
            continue
        if len(rel.parts) < 2:
            continue  # посты лежат в тематических папках
        yield rel, path


def iter_posts(root: Path):
    """Все посты вики: (относительный путь, абсолютный путь, текст)."""
    for rel, path in iter_post_paths(root):
        yield rel, path, path.read_text(encoding="utf-8")
