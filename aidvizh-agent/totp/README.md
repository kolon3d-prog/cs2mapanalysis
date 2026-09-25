# totp

One secret in, one six-digit code out. Codes rotate every 30 seconds, the remaining time is printed next to the code.

Nothing is stored anywhere: the secret is read from an environment variable or typed into a hidden prompt.

## Linux / macOS

    TOTP_SECRET=EXAMPLE_TOTP_SECRET_BASE32 ./totp.sh

Or run it with no variable set and type the secret when asked.

## Any OS with python3

    TOTP_SECRET=EXAMPLE_TOTP_SECRET_BASE32 ./totp.py

## Windows

    set TOTP_SECRET=EXAMPLE_TOTP_SECRET_BASE32 && powershell -NoProfile -ExecutionPolicy Bypass -File totp.ps1

Or run `totp.ps1` and type the secret at the hidden prompt.

## Notes

The secret may contain spaces or lowercase letters, it is cleaned up automatically.
Keep the real secret in a password manager, not in shell history or a text file.

---

**AGGG [Distro] Firmware** · автор и владелец — **@hilartem** (Telegram), разработчик и CEO — AGGG-omp.
Сообщества: [список](https://t.me/addlist/5mU_0C6bqxY4MDky) · [группа](https://t.me/aidvizh_hub) · [lab](https://t.me/aidvizh_lab) · [канал](https://t.me/aidvizhenie) · [форум](https://t.me/dvizhforum)
Сделано для AGGG [Distro] Firmware. Запрещено распространять. Максимальная эффективность — в сообществе AGGG [Distro] Firmware и INSIDER AGGG (с чатом) или при личном общении: без знания системы и опыта это лишь референс. Полный текст — `NOTICE.md`.
