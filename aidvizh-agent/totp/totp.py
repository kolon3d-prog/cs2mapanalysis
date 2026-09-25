#!/usr/bin/env python3
"""TOTP code from a base32 secret; secret comes from TOTP_SECRET or a hidden prompt."""
import base64
import hashlib
import hmac
import os
import struct
import sys
import time

DIGITS = 6
PERIOD = 30
ENV_VAR = "TOTP_SECRET"


def normalize(secret: str) -> str:
    compact = "".join(secret.split()).upper()
    return compact + "=" * ((-len(compact)) % 8)


def code_at(secret: str, timestamp: float) -> str:
    key = base64.b32decode(normalize(secret))
    counter = int(timestamp) // PERIOD
    digest = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    value = struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF
    return f"{value % 10**DIGITS:0{DIGITS}d}"


def read_secret() -> str:
    secret = os.environ.get(ENV_VAR, "").strip()
    if secret:
        return secret
    import getpass
    return getpass.getpass("base32 secret: ")


def main() -> int:
    secret = read_secret()
    if not secret:
        print(f"set {ENV_VAR} or type the secret at the prompt", file=sys.stderr)
        return 1
    now = time.time()
    print(f"{code_at(secret, now)}  ({PERIOD - int(now) % PERIOD}s left)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
