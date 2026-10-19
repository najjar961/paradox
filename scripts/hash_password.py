"""Print a users.yaml line for a new user.

    python scripts/hash_password.py alice
"""
import getpass
import sys

import bcrypt

if len(sys.argv) != 2:
    sys.exit("usage: python scripts/hash_password.py <username>")

user = sys.argv[1]
pw = getpass.getpass(f"Password for {user}: ")
if len(pw) < 10:
    sys.exit("Use at least 10 characters.")
if pw != getpass.getpass("Repeat: "):
    sys.exit("Passwords do not match.")
digest = bcrypt.hashpw(pw.encode()[:72], bcrypt.gensalt(rounds=12)).decode()
print(f'  {user}: "{digest}"')
