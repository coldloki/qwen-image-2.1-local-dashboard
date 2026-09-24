"""qwen-studio brain watchdog.

SGLang v0.5.20cu130 on a 24 GB card (RTX 3090) eventually hits a
``CUDA error: unknown error`` in the layerwise-offload engine after
enough requests. Once that fires, every subsequent generation
returns HTTP 500 with the body ``Internal Server Error`` and the
container looks alive but the CUDA context is corrupted.

This watchdog runs alongside uvicorn and:
  1. Polls the brain with a 512x512 4-step probe every N seconds.
  2. On success: nothing.
  3. On HTTP 500 or 5 consecutive communication errors: issue
     ``docker restart qwen-image-sglang`` and wait until it is back.
  4. Log every action to stdout so it shows up in the user-facing
     terminal that's running the studio.

Usage::

    python watchdog.py [--interval 30] [--container qwen-image-sglang]

It is intentionally separate from server.py so a `docker restart`
of the brain doesn't take down the studio (which is exactly when
you need the watchdog most).
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request

PROBE_PROMPT = "small red apple"
PROBE_BODY = json.dumps({
    "model": "Qwen/Qwen-Image-2.1",
    "prompt": PROBE_PROMPT,
    "size": "512x512",
    "num_inference_steps": 4,
    "seed": 1,
    "n": 1,
}).encode()


def probe(host: str = "http://localhost:30010", timeout: float = 90.0) -> tuple[bool, str]:
    """Return (ok, reason). ok is True only on HTTP 200 with bytes."""
    req = urllib.request.Request(
        f"{host}/v1/images/generations",
        data=PROBE_BODY,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read()
        if not body:
            return False, "empty response"
        # SGLang returns either {"data":[{"b64_json":...}]} or {"url":...}
        if b'"error"' in body and b'"data"' not in body:
            return False, "error in body"
        return True, "ok"
    except urllib.error.HTTPError as e:
        return False, f"HTTP {e.code}"
    except urllib.error.URLError as e:
        return False, f"connect-error: {e.reason}"
    except Exception as e:
        return False, f"probe-error: {type(e).__name__}: {e}"


def container_restart(name: str) -> None:
    print(f"[watchdog] docker restart {name}", flush=True)
    try:
        subprocess.run(
            ["docker", "restart", name],
            check=True,
            timeout=60,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except Exception as e:
        print(f"[watchdog] docker restart failed: {e}", flush=True)


def wait_healthy(host: str = "http://localhost:30010", max_s: int = 240) -> bool:
    start = time.time()
    while time.time() - start < max_s:
        try:
            with urllib.request.urlopen(f"{host}/health_generate", timeout=3) as r:
                if r.read() == b'{"status":"ok"}':
                    print(f"[watchdog] brain healthy after {int(time.time()-start)}s", flush=True)
                    return True
        except Exception:
            pass
        time.sleep(5)
    return False


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--interval", type=int, default=30, help="seconds between probes")
    parser.add_argument("--container", default="qwen-image-sglang")
    parser.add_argument("--brain", default="http://localhost:30010")
    parser.add_argument("--once", action="store_true",
                        help="run one probe and exit (for cron / ci)")
    args = parser.parse_args()

    print(f"[watchdog] watching {args.brain} every {args.interval}s; container={args.container}", flush=True)

    if args.once:
        ok, why = probe(args.brain)
        print(f"[watchdog] probe -> {why}")
        return 0 if ok else 1

    consecutive_failures = 0
    while True:
        ok, why = probe(args.brain, timeout=60.0)
        if ok:
            consecutive_failures = 0
        else:
            consecutive_failures += 1
            print(f"[watchdog] probe failed ({consecutive_failures}x): {why}", flush=True)
            # Restart on either: persistent failures (CUDA corrupted) OR
            # immediate HTTP 500 (likely layerwise-offload crash).
            if consecutive_failures >= 1 and ("HTTP 500" in why or "CUDA" in why or "empty response" in why):
                container_restart(args.container)
                wait_healthy(args.brain)
                consecutive_failures = 0
            elif consecutive_failures >= 6:
                # Sustained connection errors — brain might be down.
                # Try restart as last resort.
                container_restart(args.container)
                wait_healthy(args.brain)
                consecutive_failures = 0
        time.sleep(args.interval)


if __name__ == "__main__":
    sys.exit(main())
