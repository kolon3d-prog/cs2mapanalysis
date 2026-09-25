#!/usr/bin/env python3
"""Таймауты и параллельность моста (аудит 21.09) — три дыры, которые в
живом ресёрче стоят дорого:

1. По таймауту мост убивал живой serve-воркер (вместе с браузером и
   вкладками сессии) и ПОВТОРЯЛ тот же запрос в новом процессе: для
   session_* / research_* это тихое двойное выполнение.
2. Глобальный _worker_lock держался весь вызов: пока research идёт свои
   900с, stats/research_status не обслуживались вовсе.
3. Все действия шли на одном дефолте 120с, хотя check_links = 50×15с.

Здесь мост проверяется на ЗАГЛУШКЕ воркера: она пишет каждый полученный
запрос в лог (по нему считаем повторы) и отвечает в собственном потоке —
так видно, что мост не сериализует вызовы и разбирает ответы по id.
Живой кэш владельца (~/.cache/camoufox-research) и браузер не трогаются.
"""

import contextlib
import io
import json
import os
import queue
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import mock

REPO = str(Path(__file__).resolve().parents[1])
sys.path.insert(0, REPO)

WORKER = str(Path(REPO) / "camoufox_research" / "camoufox_worker.py")

# Заглушка воркера: протокол как у настоящего (JSON-строки в stdin), плюс
# sleep из запроса и лог полученного. STUB_NO_ID=1 — «старый воркер»:
# отвечает без id (проверка обратной совместимости моста).
STUB = '''
import json, os, signal, sys, threading, time

LOG = os.environ["STUB_LOG"]
ECHO_ID = os.environ.get("STUB_NO_ID") != "1"
out_lock = threading.Lock()

# Чистильщики окружения (soak/CI/харнесс) шлют SIGTERM всем «лишним» python
# процессам — это НЕ про мост. Проверяем мы другое: что МОСТ не убивает
# воркер по таймауту. Popen.kill() шлёт SIGKILL, а его игнорировать нельзя,
# значит регресс «мост убил живого воркера» тест поймает всё равно.
for _sig in (signal.SIGTERM, signal.SIGHUP):
    signal.signal(_sig, signal.SIG_IGN)


def log_note(**fields):
    """Заметка самой заглушки (без action) — по ней видно старт и крах."""
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(json.dumps({"_note": True, **fields}) + "\\n")


def log_request(req):
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(json.dumps(req) + "\\n")


def answer(req):
    log_request(req)
    time.sleep(float(req.get("sleep", 0)))
    ans = {"result": "ok:" + str(req.get("action"))}
    if ECHO_ID and req.get("id") is not None:
        ans["id"] = req["id"]
    return ans


def emit(ans):
    with out_lock:
        print(json.dumps(ans), flush=True)


if len(sys.argv) > 1 and sys.argv[1] != "--serve":
    # разовый режим (фолбэк моста): запрос в argv, ответ как у настоящего
    # main() — БЕЗ id (id живёт только в serve-протоколе)
    one = json.loads(sys.argv[1])
    one.pop("id", None)
    log_request(one)
    time.sleep(float(one.get("sleep", 0)))
    emit({"result": "ok:" + str(one.get("action"))})
    sys.exit(0)

# serve: каждый запрос своим потоком — как лёгкая полоса настоящего воркера
log_note(start=os.getpid())
try:
    for _line in sys.stdin:
        _line = _line.strip()
        if _line:
            _req = json.loads(_line)
            threading.Thread(target=lambda r=_req: emit(answer(r)), daemon=True).start()
except BaseException as _e:  # смерть заглушки не должна быть молчаливой
    log_note(crash=type(_e).__name__ + ": " + str(_e))
'''


class BridgeTimeoutTest(unittest.TestCase):
    """Мост против заглушки: таймаут без убийства, без повторов, без лока."""

    def setUp(self):
        from camoufox_research import camoufox_research_bridge as br

        self.br = br
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.log = Path(self.tmp.name) / "requests.jsonl"
        stub = Path(self.tmp.name) / "stub_worker.py"
        stub.write_text(STUB, encoding="utf-8")
        for patch in (
            mock.patch.object(br, "WORKER", str(stub)),
            # метрика использования — в tmp: живой кэш владельца не трогаем
            mock.patch.object(br, "_usage_file", lambda: Path(self.tmp.name) / "usage.json"),
            mock.patch.object(br, "_worker_state", None),
            mock.patch.object(br, "_RATE_LIMIT_MAX", 0),  # гейт не про этот тест
            mock.patch.object(br, "_AUTH_KEY", ""),
            mock.patch.dict(os.environ, {"STUB_LOG": str(self.log)}),
        ):
            patch.start()
            self.addCleanup(patch.stop)
        self.addCleanup(self._stop_worker)  # РАНЬШЕ прочих: пока виден handle

    def _stop_worker(self):
        state = self.br._worker_state
        if state is not None:
            proc = state["proc"]
            with contextlib.suppress(Exception):
                proc.kill()
            with contextlib.suppress(Exception):
                proc.wait(timeout=5)  # reap: иначе ResourceWarning на Popen
            self.br._worker_state = None

    def _logs(self):
        """Всё, что заглушка записала: запросы + её заметки (_note)."""
        if not self.log.exists():
            return []
        return [
            json.loads(x)
            for x in self.log.read_text(encoding="utf-8").splitlines()
            if x.strip()
        ]

    def _requests(self):
        """Запросы, которые воркер реально получил — счётчик повторов."""
        return [r for r in self._logs() if "action" in r]

    def _assert_worker_alive(self, action):
        """Воркер жив и он ТОТ ЖЕ процесс: мост по таймауту его не убивает.

        Заглушка игнорирует SIGTERM (его шлют чистильщики окружения — soak,
        CI, харнесс; это не про мост), поэтому смерть здесь означает именно
        наш kill: Popen.kill() в мосте/тесте игнорировать нельзя.
        """
        proc = self.br._worker_state["proc"]
        code = proc.poll()
        self.assertIsNone(
            code,
            f"{action}: живой воркер умер (returncode {code}; -9 = его убил "
            f"Popen.kill в мосте, -15 = SIGTERM извне) — мост не должен ни "
            f"убивать воркер по таймауту, ни переигрывать запрос. "
            f"Лог заглушки: {self._logs()}",
        )
        self.assertEqual(self.br._worker_state["proc"].pid, proc.pid)
        return proc.pid

    def test_timeout_on_session_eval_keeps_worker_and_does_not_repeat(self):
        """Таймаут побочного действия: воркер жив, второго запроса нет."""
        out = self.br._call("session_eval", timeout=0.3, expression="1+1", sleep=1.5)
        self.assertTrue(out.startswith(self.br.ERR_PREFIX), out)
        self.assertIn("повтор", out)  # честная ошибка с подсказкой, не тишина
        self.assertEqual([r["action"] for r in self._requests()], ["session_eval"])
        pid = self._assert_worker_alive("session_eval")
        # тот же процесс обслуживает следующий вызов — и получает СВОЙ ответ,
        # а не опоздавший ответ session_eval (в логе он один)
        self.assertEqual(self.br._call("stats", timeout=10), "ok:stats")
        self.assertEqual(self.br._worker_state["proc"].pid, pid, "воркер пересоздан")
        self.assertEqual([r["action"] for r in self._requests()], ["session_eval", "stats"])

    def test_short_call_answered_while_long_one_runs(self):
        """Длинный вызов не держит короткий: ping отвечает, пока research идёт."""
        long_out = {}
        thread = threading.Thread(
            target=lambda: long_out.update(
                r=self.br._call("session_eval", expression="x", timeout=20, sleep=1.2)
            )
        )
        thread.start()
        try:
            time.sleep(0.2)  # длинный запрос уже ушёл в воркер
            t0 = time.monotonic()
            ping = self.br._call("ping", timeout=5)
            waited = time.monotonic() - t0
            self.assertTrue(thread.is_alive(), "длинный вызов успел закончиться")
            self.assertLess(waited, 0.8, f"ping ждал длинный вызов: {waited:.2f}с")
        finally:
            thread.join(30)
        self.assertEqual(ping, "ok:ping")  # ответ дошёл своему вызову
        self.assertEqual(long_out["r"], "ok:session_eval")  # и наоборот — по id

    def test_plain_call_still_works(self):
        """Обычный вызов: результат доезжает, id уходит воркеру в запросе."""
        self.assertEqual(self.br._call("stats", timeout=10), "ok:stats")
        reqs = self._requests()
        self.assertEqual(len(reqs), 1)
        self.assertIsInstance(reqs[0].get("id"), int, reqs[0])

    def test_old_worker_without_id_still_works(self):
        """Совместимость: старый формат (ответ без id) обслуживается как раньше."""
        with mock.patch.dict(os.environ, {"STUB_NO_ID": "1"}):
            self.assertEqual(self.br._call("stats", timeout=10), "ok:stats")

    def test_late_answer_of_timed_out_call_is_not_given_to_another(self):
        """Опоздавший ответ брошенного вызова не подставляется соседу."""
        first = self.br._call("session_eval", timeout=0.3, expression="a", sleep=1.0)
        self.assertTrue(first.startswith(self.br.ERR_PREFIX), first)
        # второй вызов ещё ждёт, когда ответ первого «догоняет» нас в очереди
        second = self.br._call("session_status", timeout=5, sleep=1.2)
        self.assertEqual(second, "ok:session_status")

    def test_readonly_timeout_retries_once_without_killing_worker(self):
        """Действие БЕЗ побочек: разовый повтор разрешён, живой воркер цел."""
        out = self.br._call("crawl", timeout=0.3, url="http://x", sleep=1.5)
        self.assertTrue(out.startswith(self.br.ERR_PREFIX), out)
        self.assertIn("разовом воркере", out)  # честная ошибка, не исключение
        self.assertEqual([r["action"] for r in self._requests()], ["crawl"] * 2)
        pid = self._assert_worker_alive("crawl")
        # живой воркер не пересоздан: тот же процесс отвечает на следующий вызов
        self.assertEqual(self.br._call("stats", timeout=10), "ok:stats")
        self.assertEqual(self.br._worker_state["proc"].pid, pid, "воркер пересоздан")

    def test_long_action_gets_own_timeout(self):
        """Срок берётся у действия; коллизия timeout решается в пользу ACTION."""
        seen = []

        def fake_live(req, timeout, rid=None):
            sent = json.loads(req)
            seen.append((sent.get("action"), timeout, sent.get("timeout")))
            return "ok"

        with mock.patch.object(self.br, "_call_live", side_effect=fake_live):
            self.br._call("check_links", url="u")  # 50 × 15с — свой бюджет
            self.br._call("web_search", query="q")  # дефолт
            self.br._call("web_search", timeout=5, query="q")  # явный бюджет
            self.br._call("check_links", url="u", timeout=30)  # 30 — срок на ссылку
        self.assertEqual(
            seen[0][:2], ("check_links", self.br._ACTION_TIMEOUT["check_links"])
        )
        self.assertEqual(seen[1][:2], ("web_search", self.br.DEFAULT_TIMEOUT))
        self.assertEqual(seen[2][:2], ("web_search", 5))
        self.assertEqual(seen[3][0], "check_links")
        self.assertEqual(seen[3][2], 30)  # уехал в ACTION, а не в бюджет моста
        self.assertGreater(seen[3][1], 30)  # бюджет перекрывает внутренний срок


class WorkerLanesTest(unittest.TestCase):
    """Полосы воркера: наблюдаемость отвечает, пока тяжёлое действие идёт
    (иначе stats/research_status стоят в stdin за research'ом), а тяжёлое
    исполняется в потоке-владельце браузера (sync-API Playwright
    потокопривязан: из пула — «Cannot switch to a different thread»)."""

    def test_light_action_answered_while_heavy_runs(self):
        from camoufox_research import camoufox_worker_ext as we

        def slow(**kwargs):
            time.sleep(1.0)
            return "тяжёлое готово"

        we.ACTIONS["__slow_probe"] = slow
        self.addCleanup(we.ACTIONS.pop, "__slow_probe", None)
        heavy_q: queue.Queue = queue.Queue()
        light = ThreadPoolExecutor(max_workers=4)
        self.addCleanup(light.shutdown, True)
        out_lock = threading.Lock()

        def owner():  # как главный поток _serve: только тяжёлые по одному
            while True:
                req = heavy_q.get()
                if req is None:
                    return
                we._run_request(req, out_lock, True)

        requests = (
            json.dumps({"action": "__slow_probe", "id": 1})
            + "\n"
            + json.dumps({"action": "stats", "id": 2})
            + "\n"
        )
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            owner_thread = threading.Thread(target=owner)
            owner_thread.start()
            threading.Thread(
                target=we._pump,
                args=(io.StringIO(requests), heavy_q, light, out_lock, True),
            ).start()
            deadline = time.monotonic() + 0.9  # тяжёлое спит 1.0с
            early = False
            while time.monotonic() < deadline:
                if any(
                    json.loads(x).get("id") == 2
                    for x in out.getvalue().splitlines()
                    if x
                ):
                    early = True  # лёгкое ответило, пока тяжёлое ещё спит
                    break
                time.sleep(0.02)
            owner_thread.join(10)
            light.shutdown(wait=True)  # ответ тяжёлого тоже ловим в перехват
        lines = [json.loads(x) for x in out.getvalue().splitlines() if x]
        self.assertTrue(early, f"stats не ответил, пока heavy спал: {lines}")
        answers = {a["id"]: a for a in lines}
        self.assertIn("вызовов", answers[2]["result"])  # это ответ stats, не чужой
        self.assertIn("тяжёлое готово", answers[1]["result"])


class WorkerThreadAffinityTest(unittest.TestCase):
    """Тяжёлое действие обязано исполниться в потоке, который поднял браузер.

    Playwright sync API потокопривязан (проверено живьём: вызов драйвера из
    чужого потока → «Cannot switch to a different thread»), поэтому попытка
    выполнять browser-действия в пуле ломает ВСЕ браузерные тулы разом.
    Здесь работает настоящий _serve с подменённым запуском браузера: у
    тяжёлого действия виден поток, у «браузера» — поток его создания.
    """

    def test_heavy_action_runs_in_browser_owner_thread(self):
        from camoufox_research import camoufox_worker_ext as we

        seen = {}

        class FakeCam:
            browser = types.SimpleNamespace(contexts=[])

            def start(self):
                seen["owner"] = threading.get_ident()

            def __exit__(self, *exc):
                return None

        def heavy(**kwargs):
            seen["action"] = threading.get_ident()
            return "тяжёлое готово"

        we.ACTIONS["__heavy_probe"] = heavy
        self.addCleanup(we.ACTIONS.pop, "__heavy_probe", None)
        stdin = io.StringIO(
            json.dumps({"action": "__heavy_probe", "id": 1})
            + "\n"
            + json.dumps({"action": "stats", "id": 2})
            + "\n"
        )
        out = io.StringIO()
        with (
            mock.patch.object(we, "_launch", FakeCam),
            mock.patch.object(we, "init_session", lambda getter: None),
            mock.patch.object(we, "init_browser", lambda getter: None),
            mock.patch.object(we, "_close_pages", lambda browser: None),
            mock.patch.object(we.sys, "stdin", stdin),
            contextlib.redirect_stdout(out),
        ):
            we._serve()
        self.assertEqual(
            seen["action"],
            seen["owner"],
            "тяжёлое действие ушло из потока браузера (Playwright даст "
            "«Cannot switch to a different thread»)",
        )
        self.assertEqual(seen["owner"], threading.get_ident())  # _serve = владелец
        answers = {json.loads(x).get("id"): json.loads(x) for x in out.getvalue().splitlines() if x}
        self.assertIn("вызовов", answers[2]["result"])  # лёгкая полоса тоже жива


class WorkerServeIdTest(unittest.TestCase):
    """Реальный serve-воркер без браузера: id возвращается в ответе и НЕ
    уезжает аргументом в действие (иначе TypeError на каждом вызове),
    а ответ без id (старый формат) продолжает работать."""

    def test_id_echoed_and_not_forwarded(self):
        with tempfile.TemporaryDirectory() as td:
            env = {
                **os.environ,
                "CAMOUFOX_NO_BROWSER": "1",
                "CAMOUFOX_CAMPAIGN_DB": os.path.join(td, "c.db"),
            }
            proc = subprocess.Popen(
                [sys.executable, WORKER, "--serve"],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                env=env,
            )
            try:
                proc.stdin.write(json.dumps({"action": "stats", "id": 7}) + "\n")
                proc.stdin.write(json.dumps({"action": "stats"}) + "\n")
                proc.stdin.flush()
                answers = [json.loads(proc.stdout.readline()) for _ in range(2)]
            finally:
                proc.stdin.close()
                proc.wait(timeout=30)
            self.assertEqual(proc.returncode, 0, proc.stderr.read()[-300:])
        by_id = {a.get("id"): a for a in answers}
        self.assertIn(7, by_id, answers)
        self.assertIn("вызовов", by_id[7]["result"])  # id не попал в аргументы
        self.assertIn(None, by_id, answers)  # старый формат без id жив
        self.assertIn("вызовов", by_id[None]["result"])


if __name__ == "__main__":
    unittest.main()
