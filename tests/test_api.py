"""Pure-API E2E for qwen-studio.

Validates all REST endpoints + a real generation, no browser required.
"""
import json
import sys
import time
from pathlib import Path

import httpx

BASE = "http://localhost:8000"
TIMEOUT = 600


def main():
    fails = []
    c = httpx.Client(base_url=BASE, timeout=30)

    # ── meta
    r = c.get("/api/meta")
    if r.status_code != 200:
        fails.append(f"meta: HTTP {r.status_code}")
    else:
        m = r.json()
        print(f"meta: build={m['build']} brain_url={m['brain_url']}")

    # ── brain health
    r = c.get("/api/brain/health")
    if r.status_code != 200 or not r.json().get("ok"):
        fails.append(f"brain/health: {r.text}")
    else:
        print(f"brain/health: ok")

    # ── settings GET / PUT
    r = c.get("/api/settings")
    s = r.json()
    print(f"settings: {s}")
    new_steps = "16"
    r = c.put("/api/settings", json={"default_steps": int(new_steps)})
    if r.status_code != 200:
        fails.append(f"settings PUT: {r.status_code} {r.text}")
    # Verify the PUT took effect
    r = c.get("/api/settings")
    if r.json().get("default_steps") != new_steps:
        fails.append(f"settings PUT did not persist: got {r.json()}")
    else:
        print(f"settings PUT persisted: default_steps={new_steps}")
    # Reset
    c.put("/api/settings", json={"default_steps": 28})

    # ── presets CRUD
    name = f"api-test-{int(time.time())}"
    r = c.post("/api/presets", json={"name": name, "prompt": "a white cat"})
    if r.status_code != 200:
        fails.append(f"presets POST: {r.status_code} {r.text}")
    r = c.get("/api/presets")
    presets = r.json()
    if not any(p["name"] == name for p in presets):
        fails.append(f"preset not listed: {name}")
    r = c.delete(f"/api/presets/{name}")
    if r.status_code != 200:
        fails.append(f"presets DELETE: {r.status_code} {r.text}")
    r = c.get("/api/presets")
    if any(p["name"] == name for p in r.json()):
        fails.append(f"preset not deleted: {name}")
    print(f"presets CRUD: ok ({name} created and deleted)")

    # ── generation
    print("generation: requesting 512x512 / 4 steps / jpeg...")
    t0 = time.time()
    image_id = None
    with httpx.stream(
        "POST", f"{BASE}/api/generate",
        json={
            "prompt": "a tiny white flower in snow, soft light",
            "size": "512x512",
            "steps": 4,
            "guidance": 4.0,
            "seed": 99,
            "output_format": "jpeg",
        },
        timeout=TIMEOUT,
    ) as r:
        if r.status_code != 200:
            fails.append(f"generate: HTTP {r.status_code}")
            r.read()
        for line in r.iter_lines():
            if line.startswith("data:"):
                evt = json.loads(line[5:].strip())
                if "result" in evt:
                    res = evt["result"]
                    image_id = res["id"]
                    print(f"  → id={image_id} {res['width']}x{res['height']} "
                          f"{res['elapsed_s']}s {res['size_bytes']}B")

    elapsed = time.time() - t0
    print(f"generation: done in {elapsed:.1f}s")

    if not image_id:
        fails.append("no image_id produced")
        c.close()
        sys.exit(1)

    # ── image fetch
    for kind, expect_ct in (("original", "image/jpeg"), ("thumb", "image/webp")):
        r = c.get(f"/images/{image_id}/{kind}")
        if r.status_code != 200:
            fails.append(f"{kind}: HTTP {r.status_code}")
            continue
        ct = r.headers.get("content-type", "").split(";")[0].strip()
        if ct != expect_ct:
            fails.append(f"{kind}: content-type={ct}, expected {expect_ct}")
        else:
            print(f"{kind}: {len(r.content)}B {ct}")

    # ── history list
    r = c.get("/api/history")
    history = r.json()
    if not any(h["id"] == image_id for h in history):
        fails.append("history missing latest entry")
    else:
        print(f"history: {len(history)} entries, latest={image_id}")

    # ── history delete
    r = c.delete(f"/api/history/{image_id}")
    if r.status_code != 200:
        fails.append(f"history DELETE: {r.status_code} {r.text}")
    else:
        # Verify files gone
        if Path(f"data/images/{image_id}.jpg").exists():
            fails.append(f"image file still on disk: {image_id}.jpg")
        elif Path(f"data/thumbs/{image_id}.webp").exists():
            fails.append(f"thumb file still on disk: {image_id}.webp")
        else:
            print(f"history delete: ok")

    c.close()

    if fails:
        print("\n❌ FAILURES:")
        for f in fails:
            print(f"  - {f}")
        sys.exit(1)
    print("\n✅ API E2E PASS")


if __name__ == "__main__":
    main()
