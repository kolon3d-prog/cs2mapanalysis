#!/usr/bin/env bash
set -euo pipefail

SECRET="${TOTP_SECRET:-}"
if [ -z "$SECRET" ]; then
  read -rsp "base32 secret: " SECRET
  echo
fi

if command -v python3 >/dev/null 2>&1; then
  TOTP_SECRET="$SECRET" exec python3 - <<'PY'
import base64, hashlib, hmac, os, struct, time

secret = "".join(os.environ["TOTP_SECRET"].split()).upper()
secret += "=" * ((-len(secret)) % 8)
key = base64.b32decode(secret)
counter = int(time.time()) // 30
digest = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
offset = digest[-1] & 0x0F
value = struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF
print(f"{value % 1000000:06d}  ({30 - int(time.time()) % 30}s left)")
PY
fi

if command -v oathtool >/dev/null 2>&1; then
  exec oathtool --totp -b "$(printf '%s' "$SECRET" | tr -d ' ')"
fi

echo "need python3 or oathtool" >&2
exit 1
