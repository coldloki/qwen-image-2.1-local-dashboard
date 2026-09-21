"""Read a token from .env, log into gh, and push to the public repo.

One-shot script. Run from the project root: `python push_to_public.py`.

Safety:
- The script never echoes the token to stdout.
- It refuses to run if .env is missing or has no token.
- After push it logs out of `gh` so the token doesn't sit in the
  Windows credential store after you walk away from the machine.

Usage:
    # 1) Create .env with one line:
    #      GH_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx
    # 2) Run:
    #      python push_to_public.py
"""
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ENV_FILE = ROOT / ".env"
REMOTE = "public"               # git remote name in this repo
BRANCH = "main"


def load_token() -> str:
    if not ENV_FILE.exists():
        raise SystemExit(f".env not found at {ENV_FILE}")
    for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("GH_TOKEN="):
            token = line.split("=", 1)[1].strip().strip('"').strip("'")
            if not token:
                raise SystemExit("GH_TOKEN is empty in .env")
            if not token.startswith(("ghp_", "ghs_", "github_pat_")):
                raise SystemExit("GH_TOKEN does not look like a GitHub PAT")
            return token
    raise SystemExit("GH_TOKEN=<token> not found in .env")


def run(cmd: list[str], **kw) -> None:
    print(f"+ {' '.join(cmd[:3])} ...")
    subprocess.run(cmd, check=True, **kw)


def main() -> int:
    token = load_token()
    print("Loaded GH_TOKEN from .env (not printing).")

    # 1) Login to gh non-interactively
    run(["gh", "auth", "login", "--with-token", "--hostname", "github.com"],
        input=token, text=True)

    # 2) Wire git's credential helper to gh so subsequent pushes don't prompt
    run(["gh", "auth", "setup-git"])

    # 3) Confirm identity
    run(["gh", "auth", "status"])

    # 4) Push
    run(["git", "push", REMOTE, BRANCH])

    # 5) Verify what landed on the remote
    run(["git", "log", "--oneline", f"{REMOTE}/{BRANCH}", "-5"])

    print("\nPush verified. Logging out of gh so the token doesn't linger.")
    run(["gh", "auth", "logout", "--hostname", "github.com"], input="y", text=True)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except subprocess.CalledProcessError as e:
        print(f"\nFAILED at step exit={e.returncode}", file=sys.stderr)
        try:
            subprocess.run(["gh", "auth", "logout", "--hostname", "github.com"],
                           input="y", text=True, check=False)
        except Exception:
            pass
        sys.exit(2)
