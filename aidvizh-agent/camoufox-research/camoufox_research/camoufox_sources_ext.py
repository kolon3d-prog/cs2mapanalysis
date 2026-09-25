#!/usr/bin/env python3
# Источник: t.me/aidvizhenie · admin h-i-l-artem · канал и гиг: aidvizh_hub

"""Расширение реестра доменов: разбор батчей, термы для follow-up
волны (вырезано из camoufox_sources.py, canon FILE-SIZE.md); ядро
(tier/ранжирование) — в _core. Стоп-слова — в camoufox_stopwords."""

import re

try:
    from camoufox_research.camoufox_stopwords import _STOP
except ImportError:
    from camoufox_stopwords import _STOP

_MIN_LEN = 5
_TERM_MAX = 5
# Терм обязан встретиться в ≥_DF_MIN РАЗНЫХ источниках: одинокое редкое
# слово (df=1) — это шум, а не подтема (урок 21.09).
_DF_MIN = 2
_WORD_RX = r"[A-Za-zА-Яа-я0-9][A-Za-zА-Яа-я0-9\-]{3,}"
_PHRASE_RX = r"\b([A-Z][A-Za-z0-9]{2,}(?:[ -][A-Z][A-Za-z0-9]{2,}){1,3})\b"

def _batch_texts(batch):
    """'--- URL: u\\ntext\\n\\n--- URL: ...' → [{'url', 'text'}] (для JSON)."""
    texts = []
    for chunk in batch.strip().split("\n--- URL: "):
        u, _, t = chunk.partition("\n")
        u = u.strip().replace("--- URL: ", "", 1) if u else ""
        if u:
            texts.append({"url": u, "text": t.strip()})
    return texts

def extract_terms(texts, base_queries):
    """Редкие/именные термы первой волны → follow-up запросы.

    texts: заголовки+сниппеты первой волны; base_queries: исходные
    запросы (их слова исключаем, они же — якорь для одиночных термов).

    Три правила (урок 21.09: волна из голых слов «check · blend · audio ·
    built · evade» ушла в музыкальные сайты — счётчик доменов рос,
    релевантность падала, а tier 0 ставил мусор первым в цитатах):
      1) терм обязан встретиться в ≥_DF_MIN РАЗНЫХ источниках (df), а не
         просто «редко» — одиночное упоминание это шум;
      2) одиночное слово НЕ уходит запросом само: только вместе с якорем
         базового запроса («audio antidetect browser fingerprint …»);
      3) фразы Capwords («Dolphin Anty») идут первыми — они уже несут тему
         и не требуют якоря.
    Нет базовых запросов → нет якоря → одиночные термы не отдаём вовсе.
    """
    base_queries = [q for q in (base_queries or []) if str(q).strip()]
    base_tokens = set()
    for q in base_queries:
        base_tokens |= {w.lower() for w in re.findall(r"[A-Za-z0-9]{3,}", q)}
    # df: в скольких РАЗНЫХ текстах встретился терм (не сколько раз всего)
    df: dict[str, int] = {}
    for t in texts:
        for w in set(re.findall(_WORD_RX, t)):
            lw = w.lower()
            if (lw in base_tokens or lw in _STOP or len(lw) < _MIN_LEN
                    or lw.isdigit()):
                continue
            df[lw] = df.get(lw, 0) + 1
    corpus = " ".join(texts)
    anchor = " ".join(str(base_queries[0]).split())[:80] if base_queries else ""
    out: list[str] = []
    # 3) фразы первыми: они сами по себе тематичны
    for p in re.findall(_PHRASE_RX, corpus):
        pl = p.lower()
        if pl in base_tokens or any(pl == o.lower() for o in out):
            continue
        if sum(1 for t in texts if pl in t.lower()) < _DF_MIN:
            continue
        out.append(p)
        if len(out) >= 2:
            break
    # 2) одиночные термы — только с якорем темы; сортировка по df desc
    # (чем в большем числе источников встретился, тем он тематичнее),
    # при равном df — по алфавиту (детерминизм: тест не должен мигать)
    if anchor:
        # только термы из ≥_DF_MIN источников: одинокое упоминание = шум
        # («blend» из одной статьи уводил волну целиком),
        for w in sorted((w for w, d in df.items() if d >= _DF_MIN),
                        key=lambda x: (-df[x], x)):
            if len(out) >= _TERM_MAX:
                break
            out.append(f"{w} {anchor}".strip())
    return out[:_TERM_MAX]
