"""qwen-studio backend.

FastAPI app that:
  * serves the static frontend from /static
  * proxies generation requests to the SGLang Diffusion brain
  * persists history + presets + settings in SQLite
  * serves image bytes from /data via /images/{id}/{kind}

Layout:
  /
    server.py             # this file
    /static               # vanilla HTML + ES module JS
    /data
      /images/{uuid}.ext  # original outputs
      /thumbs/{uuid}.webp # generated thumbnails
      studio.db           # SQLite (single user)
"""
from __future__ import annotations

import asyncio
import base64
import io
import json
import os
import sqlite3
import sys
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import httpx
import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image
from pydantic import BaseModel, Field

# ============================================================ Config

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
IMAGES_DIR = DATA_DIR / "images"
THUMBS_DIR = DATA_DIR / "thumbs"
STATIC_DIR = ROOT / "static"
DB_PATH = DATA_DIR / "studio.db"

# Brain (SGLang Diffusion) — overridable via env so the same image
# runs in dev (localhost:30010) and in docker-compose (service name).
BRAIN_URL = os.environ.get("BRAIN_URL", "http://localhost:30010")

THUMB_MAX_SIDE = int(os.environ.get("THUMB_MAX_SIDE", "384"))
THUMB_QUALITY = int(os.environ.get("THUMB_QUALITY", "78"))

for d in (DATA_DIR, IMAGES_DIR, THUMBS_DIR):
    d.mkdir(parents=True, exist_ok=True)


# ============================================================ Database

SCHEMA = """
CREATE TABLE IF NOT EXISTS history (
    id            TEXT PRIMARY KEY,
    ts            TEXT NOT NULL,
    prompt        TEXT NOT NULL,
    negative      TEXT,
    width         INTEGER NOT NULL,
    height        INTEGER NOT NULL,
    steps         INTEGER NOT NULL,
    guidance      REAL NOT NULL,
    seed          INTEGER,
    output_format TEXT NOT NULL,
    filename      TEXT NOT NULL,
    elapsed_s     REAL NOT NULL,
    size_bytes    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS history_ts_idx ON history(ts DESC);

CREATE TABLE IF NOT EXISTS presets (
    name    TEXT PRIMARY KEY,
    prompt  TEXT NOT NULL,
    steps   INTEGER,
    seed    INTEGER
);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""

DEFAULT_SETTINGS = {
    "server_url": BRAIN_URL,
    "default_size": "1024x1024",
    "default_steps": "28",
    "default_guidance": "4.0",
    "default_seed": "-1",
    "default_format": "png",
}


def db() -> sqlite3.Connection:
    """Per-request connection. row_factory = sqlite3.Row."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    conn = db()
    try:
        conn.executescript(SCHEMA)
        for k, v in DEFAULT_SETTINGS.items():
            conn.execute(
                "INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)",
                (k, v),
            )
        conn.execute(
            "INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)",
            ("schema_version", "1"),
        )
        conn.commit()
    finally:
        conn.close()


# ============================================================ Models

SIZES = [
    "1024x1024", "1280x720", "720x1280",
    "1536x1024", "1024x1536",
    "512x512", "768x768",
]

OUTPUT_FORMATS = ["png", "jpeg", "webp"]


class GenerateRequest(BaseModel):
    prompt: str
    negative: str = ""
    size: str = "1024x1024"
    steps: int = Field(28, ge=1, le=100)
    guidance: float = Field(4.0, ge=0.0, le=20.0)
    seed: int = -1
    output_format: str = "png"


class PresetIn(BaseModel):
    name: str
    prompt: str
    steps: int | None = None
    seed: int | None = None


class SettingsIn(BaseModel):
    server_url: str | None = None
    default_size: str | None = None
    default_steps: int | None = None
    default_guidance: float | None = None
    default_seed: int | None = None
    default_format: str | None = None


# ============================================================ Image helpers

def _ext_for(format_: str) -> str:
    return {"png": "png", "jpeg": "jpg", "webp": "webp"}.get(format_, "png")


def _save_original(raw: bytes, ext: str) -> tuple[str, Path]:
    image_id = uuid.uuid4().hex[:12]
    filename = f"{image_id}.{ext}"
    path = IMAGES_DIR / filename
    path.write_bytes(raw)
    return image_id, path


def _make_thumb(src_path: Path, dest_path: Path) -> None:
    with Image.open(src_path) as img:
        img.load()
        img.thumbnail((THUMB_MAX_SIDE, THUMB_MAX_SIDE), Image.LANCZOS)
        if img.mode != "RGB":
            img = img.convert("RGB")
        img.save(dest_path, format="WEBP", quality=THUMB_QUALITY, method=4)


def _row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "ts": row["ts"],
        "prompt": row["prompt"],
        "negative": row["negative"] or "",
        "width": row["width"],
        "height": row["height"],
        "steps": row["steps"],
        "guidance": row["guidance"],
        "seed": row["seed"],
        "output_format": row["output_format"],
        "filename": row["filename"],
        "elapsed_s": row["elapsed_s"],
        "size_bytes": row["size_bytes"],
        "thumb_url": f"/images/{row['id']}/thumb",
        "image_url": f"/images/{row['id']}/original",
    }


# ============================================================ App lifespan

@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield


app = FastAPI(title="qwen-studio", lifespan=lifespan)


# ============================================================ Static + images

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/images/{image_id}/{kind}")
async def serve_image(image_id: str, kind: str) -> FileResponse:
    if kind not in ("original", "thumb"):
        raise HTTPException(400, "kind must be 'original' or 'thumb'")
    conn = db()
    try:
        row = conn.execute(
            "SELECT filename, output_format FROM history WHERE id = ?", (image_id,)
        ).fetchone()
    finally:
        conn.close()
    if not row:
        raise HTTPException(404, "not found")
    if kind == "thumb":
        path = THUMBS_DIR / f"{image_id}.webp"
        media_type = "image/webp"
    else:
        path = IMAGES_DIR / row["filename"]
        ext = (row["output_format"] or "").lower()
        media_type = {
            "png": "image/png",
            "jpg": "image/jpeg",
            "jpeg": "image/jpeg",
            "webp": "image/webp",
        }.get(ext, "application/octet-stream")
    if not path.exists():
        raise HTTPException(404, "file missing on disk")
    return FileResponse(path, media_type=media_type)


# ============================================================ Brain proxy

@app.get("/api/brain/health")
async def brain_health() -> dict:
    """Check brain reachability. Used by Settings tab to verify config."""
    try:
        async with httpx.AsyncClient(timeout=5) as c:
            r = await c.get(f"{BRAIN_URL}/health")
        return {"ok": r.status_code == 200, "status": r.status_code, "body": r.text[:200]}
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


@app.post("/api/generate")
async def generate(req: GenerateRequest) -> StreamingResponse:
    """Proxy to brain, persist result, stream SSE progress.

    Event types: {"phase": "..."} | {"progress": 0..1} | {"result": {...}} | {"error": "..."}
    """
    server_url = _get_setting("server_url", BRAIN_URL)
    payload = {
        "model": "Qwen/Qwen-Image-2.1",
        "prompt": req.prompt,
        "negative_prompt": req.negative,
        "size": req.size,
        "num_inference_steps": req.steps,
        "guidance_scale": req.guidance,
        "num_images": 1,
        "seed": None if req.seed < 0 else req.seed,
        "output_format": req.output_format,
    }
    if not req.negative:
        payload.pop("negative_prompt")

    async def event_stream():
        # Phase: connecting
        yield _sse({"phase": "connecting", "msg": f"Calling {server_url}…"})
        t0 = time.time()
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(600.0, connect=10.0)) as c:
                # We can't truly stream progress from SGLang without modifying
                # the upstream protocol. For now we poll elapsed-time and
                # report the phase as 'denoising' once we see bytes flowing.
                yield _sse({"phase": "denoising", "msg": f"Running {req.steps} steps…", "elapsed": 0.0})
                # Last-resort: send a synthetic progress tick loop on a parallel
                # task that stops once the request returns. The real end
                # timestamp is the time the response arrives.
                tick_stop = asyncio.Event()

                async def pulse():
                    while not tick_stop.is_set():
                        await asyncio.sleep(0.5)
                        if tick_stop.is_set():
                            break
                        elapsed = time.time() - t0
                        # Assume ~90s budget for a 28-step 1024x1024 run.
                        pct = min(0.95, elapsed / 90.0)
                        yield _sse({"progress": round(pct, 3), "elapsed": round(elapsed, 1)})

                # We can't yield mid-async-with easily; do a single long-poll
                # request and emit one tick per second before/after.
                async def tick_loop():
                    while not tick_stop.is_set():
                        elapsed = time.time() - t0
                        yield _sse({"progress": round(min(0.95, elapsed / 90.0), 3),
                                    "elapsed": round(elapsed, 1)})
                        try:
                            await asyncio.wait_for(tick_stop.wait(), timeout=1.0)
                        except asyncio.TimeoutError:
                            pass

                tick_gen = tick_loop()
                resp_task = asyncio.create_task(c.post(
                    f"{server_url.rstrip('/')}/v1/images/generations",
                    json=payload,
                ))
                # Pump ticks until response arrives.
                while not resp_task.done():
                    try:
                        msg = await asyncio.wait_for(tick_gen.__anext__(), timeout=1.0)
                        yield msg
                    except (asyncio.TimeoutError, StopAsyncIteration):
                        pass
                tick_stop.set()
                resp = await resp_task
                if resp.status_code != 200:
                    yield _sse({"error": f"brain HTTP {resp.status_code}: {resp.text[:300]}"})
                    return
                data = resp.json()
                item = (data.get("data") or [{}])[0]
                b64 = item.get("b64_json") or item.get("base64")
                if not b64:
                    # Brain returns a URL instead of b64. Follow it.
                    url_or_path = item.get("url") or item.get("file_path")
                    if url_or_path:
                        # Resolve relative URL against BRAIN_URL
                        if url_or_path.startswith("/"):
                            full = BRAIN_URL.rstrip("/") + url_or_path
                        elif url_or_path.startswith("output/"):
                            full = BRAIN_URL.rstrip("/") + "/" + url_or_path
                        else:
                            full = url_or_path
                        async with httpx.AsyncClient(timeout=60) as cli:
                            r2 = await cli.get(full)
                            r2.raise_for_status()
                            b64 = base64.b64encode(r2.content).decode("ascii")
                if not b64:
                    yield _sse({"error": f"no b64_json in response: {json.dumps(data)[:300]}"})
                    return
                raw = base64.b64decode(b64)
                elapsed = time.time() - t0
                # Decode dimensions
                with Image.open(io.BytesIO(raw)) as im:
                    w, h = im.size
                ext = _ext_for(req.output_format)
                image_id, path = _save_original(raw, ext)
                thumb_path = THUMBS_DIR / f"{image_id}.webp"
                try:
                    _make_thumb(path, thumb_path)
                except Exception as e:
                    print(f"[thumb] {image_id}: {e}", file=sys.stderr)
                # Persist row
                from datetime import datetime
                conn = db()
                try:
                    conn.execute(
                        """INSERT INTO history
                           (id, ts, prompt, negative, width, height, steps, guidance,
                            seed, output_format, filename, elapsed_s, size_bytes)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                        (
                            image_id,
                            datetime.utcnow().isoformat(timespec="seconds"),
                            req.prompt,
                            req.negative,
                            w, h, req.steps, req.guidance,
                            None if req.seed < 0 else req.seed,
                            req.output_format,
                            path.name,
                            round(elapsed, 2),
                            len(raw),
                        ),
                    )
                    conn.commit()
                finally:
                    conn.close()
                yield _sse({"progress": 1.0, "elapsed": round(elapsed, 1), "phase": "done"})
                yield _sse({"result": _build_entry(image_id)})
        except httpx.RequestError as e:
            yield _sse({"error": f"brain unreachable: {type(e).__name__}: {e}"})

    return StreamingResponse(event_stream(), media_type="text/event-stream")


def _build_entry(image_id: str) -> dict:
    conn = db()
    try:
        row = conn.execute("SELECT * FROM history WHERE id = ?", (image_id,)).fetchone()
        return _row_to_dict(row) if row else {}
    finally:
        conn.close()


def _sse(obj: dict) -> str:
    return f"data: {json.dumps(obj)}\n\n"


# ============================================================ History API

@app.get("/api/history")
async def list_history(limit: int = 200, offset: int = 0) -> list[dict]:
    conn = db()
    try:
        rows = conn.execute(
            "SELECT * FROM history ORDER BY ts DESC LIMIT ? OFFSET ?",
            (limit, offset),
        ).fetchall()
        return [_row_to_dict(r) for r in rows]
    finally:
        conn.close()


@app.get("/api/history/{image_id}")
async def get_history(image_id: str) -> dict:
    conn = db()
    try:
        row = conn.execute("SELECT * FROM history WHERE id = ?", (image_id,)).fetchone()
        if not row:
            raise HTTPException(404, "not found")
        return _row_to_dict(row)
    finally:
        conn.close()


@app.delete("/api/history/{image_id}")
async def delete_history(image_id: str) -> dict:
    conn = db()
    try:
        row = conn.execute("SELECT filename FROM history WHERE id = ?", (image_id,)).fetchone()
        if not row:
            raise HTTPException(404, "not found")
        # Delete files
        for p in (IMAGES_DIR / row["filename"], THUMBS_DIR / f"{image_id}.webp"):
            try:
                p.unlink()
            except FileNotFoundError:
                pass
        conn.execute("DELETE FROM history WHERE id = ?", (image_id,))
        conn.commit()
        return {"deleted": image_id}
    finally:
        conn.close()


@app.delete("/api/history")
async def clear_history() -> dict:
    conn = db()
    try:
        rows = conn.execute("SELECT id, filename FROM history").fetchall()
        for r in rows:
            for p in (IMAGES_DIR / r["filename"], THUMBS_DIR / f"{r['id']}.webp"):
                try:
                    p.unlink()
                except FileNotFoundError:
                    pass
        conn.execute("DELETE FROM history")
        conn.commit()
        return {"cleared": len(rows)}
    finally:
        conn.close()


# ============================================================ Presets API

@app.get("/api/presets")
async def list_presets() -> list[dict]:
    conn = db()
    try:
        rows = conn.execute("SELECT name, prompt, steps, seed FROM presets ORDER BY name").fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


@app.post("/api/presets")
async def add_preset(p: PresetIn) -> dict:
    if not p.name.strip() or not p.prompt.strip():
        raise HTTPException(400, "name and prompt required")
    conn = db()
    try:
        conn.execute(
            "INSERT OR REPLACE INTO presets(name, prompt, steps, seed) VALUES (?, ?, ?, ?)",
            (p.name.strip(), p.prompt.strip(), p.steps, p.seed),
        )
        conn.commit()
        return {"saved": p.name}
    finally:
        conn.close()


@app.delete("/api/presets/{name}")
async def delete_preset(name: str) -> dict:
    conn = db()
    try:
        cur = conn.execute("DELETE FROM presets WHERE name = ?", (name,))
        conn.commit()
        if cur.rowcount == 0:
            raise HTTPException(404, "not found")
        return {"deleted": name}
    finally:
        conn.close()


# ============================================================ Settings API

def _get_setting(key: str, default: str = "") -> str:
    conn = db()
    try:
        row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
        return row["value"] if row else default
    finally:
        conn.close()


@app.get("/api/settings")
async def get_settings() -> dict:
    conn = db()
    try:
        rows = conn.execute("SELECT key, value FROM settings").fetchall()
        return {r["key"]: r["value"] for r in rows}
    finally:
        conn.close()


@app.put("/api/settings")
async def update_settings(s: SettingsIn) -> dict:
    updates = s.model_dump(exclude_none=True)
    if not updates:
        return {"updated": 0}
    conn = db()
    try:
        for k, v in updates.items():
            conn.execute(
                "INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)",
                (k, str(v)),
            )
        conn.commit()
        return {"updated": len(updates)}
    finally:
        conn.close()


# ============================================================ Static meta

@app.get("/api/meta")
async def meta() -> dict:
    """Build info for the frontend to display."""
    return {
        "name": "qwen-studio",
        "version": "0.1.0",
        "build": os.environ.get("BUILD_TAG", "dev"),
        "brain_url": BRAIN_URL,
    }


# ============================================================ Entrypoint

if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8000"))
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")
