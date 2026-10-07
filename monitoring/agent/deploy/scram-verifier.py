#!/usr/bin/env python3
"""Print a PostgreSQL SCRAM-SHA-256 verifier for the password read from stdin.

The deploy workflow sets the etg_monitor password with this verifier
(ALTER ROLE ... PASSWORD 'SCRAM-SHA-256$4096:...'), so the plaintext never
reaches Postgres. Same construction as PostgreSQL's scram_build_secret():
PBKDF2-HMAC-SHA-256 with a random 16-byte salt and 4096 iterations.

Only printable ASCII without spaces is accepted, where SASLprep (which the
server applies at login) leaves the password unchanged.
"""

import base64
import hashlib
import hmac
import os
import sys

ITERATIONS = 4096


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def main() -> int:
    password = sys.stdin.buffer.read()
    if not password or any(b < 0x21 or b > 0x7E for b in password):
        print("password must be non-empty printable ASCII without spaces", file=sys.stderr)
        return 1
    salt = os.urandom(16)
    salted = hashlib.pbkdf2_hmac("sha256", password, salt, ITERATIONS)
    client_key = hmac.new(salted, b"Client Key", hashlib.sha256).digest()
    stored_key = hashlib.sha256(client_key).digest()
    server_key = hmac.new(salted, b"Server Key", hashlib.sha256).digest()
    sys.stdout.write(
        f"SCRAM-SHA-256${ITERATIONS}:{b64(salt)}${b64(stored_key)}:{b64(server_key)}\n"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
