#!/usr/bin/env bats
# health_pulse.py: уведомление на рабочий стол — только по явному согласию.
#
# Требование владельца 21.09: «спамит — прекрати просто в системе». У пульса
# три забора: HEALTH_PULSE_NOTIFY (по умолчанию выключено), наличие экрана и
# шины (у крона их нет) и дедуп по СМЫСЛУ вердикта (то же состояние молчит).
# Здесь они проверяются на ЖИВОМ скрипте: фальшивый `notify-send` в PATH
# пишет файл-маркер, реальный нотификатор недостижим.
#
# Тонкость: питоновские моки умеют проверять только вызовы (см.
# tests/test_health_pulse_notify.py), но там же прячется пустой тест —
# «уведомление не ушло» зеленеет и тогда, когда пульс вообще не добрался до
# _notify. Поэтому положительный контроль (тест с экраном) стоит рядом и
# доказывает, что в этой самой песочнице путь уведомления достижим.

setup() {
  REPO="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  SCRIPT="$REPO/scripts/health_pulse.py"
  if [ -x "$REPO/.venv/bin/python" ]; then
    PY="$REPO/.venv/bin/python"
  else
    PY="$(command -v python3)"
  fi
  STUB="$BATS_TEST_TMPDIR/bin"
  MARKER="$BATS_TEST_TMPDIR/notify-send.log"
  CACHE="$BATS_TEST_TMPDIR/cache"
  HOME_STUB="$BATS_TEST_TMPDIR/home"
  mkdir -p "$STUB" "$CACHE" "$HOME_STUB"

  cat > "$STUB/notify-send" <<EOF
#!/bin/sh
printf '%s\n' "\$*" >> "$MARKER"
EOF
  chmod +x "$STUB/notify-send"
}

pulse() { # аргументы — env-переменные вида ИМЯ=ЗНАЧЕНИЕ
  [ -x "$PY" ] || skip "нет python для запуска пульса"
  # Экран/шину и согласие ГАСИМ явно: иначе окружение владельца (живая
  # графическая сессия) просочится в тест и «молчание» станет случайным.
  run env PATH="$STUB:/usr/bin:/bin" HOME="$HOME_STUB" \
      CAMOUFOX_CACHE_DIR="$CACHE" CAMOUFOX_PIDFILE="$BATS_TEST_TMPDIR/no.pid" \
      DISPLAY= WAYLAND_DISPLAY= DBUS_SESSION_BUS_ADDRESS= HEALTH_PULSE_NOTIFY= \
      "$@" "$PY" "$SCRIPT"
}

# Пульс обязан быть живым: без вердикта в логе «нет уведомления» ничего не значит.
ran() {
  grep -q "PULSE" "$CACHE/health-pulse.log"
}

@test "без согласия (экран и шина ЕСТЬ) уведомление всё равно не спавнится" {
  # Экран/шину даём специально: иначе тест не отличит выключенное согласие
  # от отсутствия дисплея, и «молчание» окажется заслугой не того забора.
  pulse DISPLAY=:99 DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/fake-bus

  ran
  [ ! -e "$MARKER" ]
}

@test "HEALTH_PULSE_NOTIFY=1 без экрана и шины (крон) — тоже не спавнится" {
  pulse HEALTH_PULSE_NOTIFY=1

  ran
  [ ! -e "$MARKER" ]
}

@test "с экраном и шиной уведомление уходит — и только один раз на состояние" {
  pulse HEALTH_PULSE_NOTIFY=1 DISPLAY=:99 \
        DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/fake-bus \
        HEALTH_PULSE_NOTIFY_REPEAT_MIN=1440

  ran
  [ -s "$MARKER" ] # положительный контроль: путь уведомления достижим
  grep -q -- "-u " "$MARKER" # argv как у notify-send: -u <urgency> <title> <msg>
  grep -q "Кауфми-пульс" "$MARKER"
  [ "$(wc -l < "$MARKER")" -eq 1 ]

  pulse HEALTH_PULSE_NOTIFY=1 DISPLAY=:99 \
        DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/fake-bus \
        HEALTH_PULSE_NOTIFY_REPEAT_MIN=1440

  ran
  [ "$(wc -l < "$MARKER")" -eq 1 ] # тот же смысл вердикта — молчим
}
