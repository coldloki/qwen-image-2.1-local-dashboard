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
import re
import sqlite3
import sys
import time
import uuid
import zipfile
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


def _detect_build_sha() -> str:
    """Best-effort git short SHA for cache-busting.

    Priority: BUILD_TAG env > git rev-parse > "dev".
    Captured once at import so every response is stamped with the
    same identifier for the lifetime of the process."""
    explicit = os.environ.get("BUILD_TAG")
    if explicit:
        return explicit
    try:
        import subprocess
        out = subprocess.check_output(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=str(ROOT),
            stderr=subprocess.DEVNULL,
            timeout=2,
        )
        sha = out.decode("utf-8", "ignore").strip()
        return sha or "dev"
    except Exception:
        return "dev"


BUILD_SHA = _detect_build_sha()
THUMB_QUALITY = int(os.environ.get("THUMB_QUALITY", "78"))

# ------------------------------------------------------------ Concurrency cap
# The brain (SGLang Diffusion) can technically queue multiple requests on the
# GPU side, but at 1024x1024 + 50 steps two concurrent jobs can push the
# RTX 3090 over its 24GB VRAM ceiling and OOM the whole container. We enforce
# 1 in-flight generation server-side so two clients (or one client + a stuck
# stream) cannot blow up the brain. Subsequent calls get HTTP 409 with a
# Retry-After hint.
_GEN_LOCK = asyncio.Lock()
_GEN_IN_FLIGHT: dict[str, float] = {}  # rid -> started_at (monotonic seconds)
# Detailed per-generation state. Lets the Generate tab pick up a result
# that finished while the user was navigating to History, AND survive
# in-app navigation without killing the brain request.
# Shape:
#   rid: {
#     "started_at": float,        # monotonic seconds (brain-side)
#     "wall_started_at": float,   # unix time.time() — for elapsed display
#     "prompt": str, "negative": str,
#     "size": str, "steps": int, "guidance": float, "seed": int,
#     "format": str, "n": int,
#     "phase": str, "progress": float,  # last SSE values
#     "result_image_ids": list[str],   # populated on success
#     "error": str | None,
#     "finished": bool, "finished_at": float | None,
#   }
_GEN_ACTIVE: dict[str, dict] = {}
_GEN_MAX = int(os.environ.get("MAX_CONCURRENT_GENERATIONS", "1"))

for d in (DATA_DIR, IMAGES_DIR, THUMBS_DIR):
    d.mkdir(parents=True, exist_ok=True)


# ============================================================ Database

SCHEMA = """
CREATE TABLE IF NOT EXISTS history (
    id                  TEXT PRIMARY KEY,
    ts                  TEXT NOT NULL,
    prompt              TEXT NOT NULL,
    negative            TEXT,
    width               INTEGER NOT NULL,
    height              INTEGER NOT NULL,
    steps               INTEGER NOT NULL,
    guidance            REAL NOT NULL,
    seed                INTEGER,
    output_format       TEXT NOT NULL,
    filename            TEXT NOT NULL,
    elapsed_s           REAL NOT NULL,
    size_bytes          INTEGER NOT NULL,
    has_alpha           INTEGER NOT NULL DEFAULT 0,
    -- Lineage / kind metadata (added for upscale + reference images)
    kind                TEXT NOT NULL DEFAULT 'generate',
    parent_id           TEXT,
    reference_image_ids TEXT
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
    # Advanced — same defaults that GenerateRequest uses
    "default_true_cfg": "1.0",
    "default_teacache": "1",
    # Batch — number of images to produce per request
    "default_n": "1",
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
        # Lightweight column-level migrations for existing DBs
        existing_cols = {
            row["name"] for row in conn.execute("PRAGMA table_info(history)")
        }
        if "has_alpha" not in existing_cols:
            conn.execute(
                "ALTER TABLE history ADD COLUMN has_alpha INTEGER NOT NULL DEFAULT 0"
            )
        # Lineage / kind migrations (added for upscale + reference images)
        if "kind" not in existing_cols:
            conn.execute(
                "ALTER TABLE history ADD COLUMN kind TEXT NOT NULL DEFAULT 'generate'"
            )
        if "parent_id" not in existing_cols:
            conn.execute(
                "ALTER TABLE history ADD COLUMN parent_id TEXT"
            )
        if "reference_image_ids" not in existing_cols:
            conn.execute(
                "ALTER TABLE history ADD COLUMN reference_image_ids TEXT"
            )
        # Now that the columns exist (whether they were created via
        # CREATE TABLE in SCHEMA or via ALTER above), ensure the new
        # indexes are present. CREATE INDEX IF NOT EXISTS is a no-op
        # when the index already exists, but on a legacy DB the
        # column-add + index-create must happen in this order —
        # running CREATE INDEX inline in SCHEMA fails on tables that
        # were created before the columns existed.
        conn.execute(
            "CREATE INDEX IF NOT EXISTS history_parent_idx ON history(parent_id)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS history_kind_idx ON history(kind)"
        )
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
    # Advanced — see collapsible "Advanced" section on Generate page.
    # Defaults chosen so existing API clients keep working unchanged.
    true_cfg_scale: float = Field(1.0, ge=0.0, le=20.0)
    enable_teacache: bool = True
    # Batch — generate N images in one request. Capped at 4 because
    # larger batches inflate VRAM and our slot policy is 1 in flight.
    n: int = Field(1, ge=1, le=4)
    # Reference images (img2img / inpainting flow). When set, the
    # backend routes to the brain's /v1/images/edits endpoint and
    # passes these image_ids as base image input. Empty list (default)
    # means pure txt2img through /v1/images/generations.
    # Capped at 4 because the brain's edits endpoint accepts an
    # array, but more than 4 rarely helps and slows generation a lot.
    reference_image_ids: list[str] = Field(default_factory=list, max_length=4)
    # Mask for inpainting (paired with reference_image_ids[0]).
    # Not exposed in v1 — placeholder for the next round.
    mask_id: str | None = None


class UpscaleRequest(BaseModel):
    """Up-scale an existing history image via the brain's edits
    endpoint with `enable_upscaling: true`.

    The server loads the source image by `history_id`, POSTs it to
    the brain along with the source's prompt (override via
    `prompt` if you want), and persists the result as a new
    history row with `kind='upscale'` and `parent_id=<source>`.
    """
    history_id: str
    scale: int = Field(2, ge=2, le=4)
    prompt: str | None = None  # default = source prompt
    negative: str | None = None  # default = source negative
    steps: int | None = None  # default 20; lower than full gen


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
    default_true_cfg: float | None = None
    default_teacache: bool | None = None
    default_n: int | None = None


# ============================================================ Image helpers

def _ext_for(format_: str) -> str:
    return {"png": "png", "jpeg": "jpg", "webp": "webp"}.get(format_, "png")


def _save_original(raw: bytes, ext: str) -> tuple[str, Path]:
    image_id = uuid.uuid4().hex[:12]
    filename = f"{image_id}.{ext}"
    path = IMAGES_DIR / filename
    path.write_bytes(raw)
    return image_id, path


def _has_real_alpha(img: Image.Image) -> bool:
    """Detect images with actual transparency.

    Qwen-Image 2.1 writes outputs as RGBA PNG even when every pixel is fully
    opaque — the alpha channel exists but min is 255. Checking mode alone
    would tag every generation as transparent, which is wrong.

    Threshold: alpha min < 250 means at least one pixel has meaningful
    transparency. This ignores JPEG-style anti-alias halos (which would
    sit at 254/255) but catches real cutouts (which sit at 0).
    """
    if img.mode == "RGBA":
        return img.split()[-1].getextrema()[0] < 250
    if img.mode == "LA":
        return img.split()[-1].getextrema()[0] < 250
    if img.mode == "P":
        return "transparency" in img.info and img.info["transparency"] is not None
    return False


def _make_thumb(src_path: Path, dest_path: Path) -> None:
    """Thumbnail to WebP at THUMB_MAX_SIDE.

    Preserves alpha when the source has it so transparent PNGs show
    their actual cutouts in the gallery grid. JPEG / opaque PNG sources
    stay RGB. WebP lossless is used for the alpha path so we don't
    smudge edges with chroma subsampling.
    """
    with Image.open(src_path) as img:
        img.load()
        img.thumbnail((THUMB_MAX_SIDE, THUMB_MAX_SIDE), Image.LANCZOS)
        has_alpha = _has_real_alpha(img)
        if has_alpha and img.mode != "RGBA":
            img = img.convert("RGBA")
        if has_alpha:
            img.save(dest_path, format="WEBP", lossless=True, method=4)
        else:
            if img.mode != "RGB":
                img = img.convert("RGB")
            img.save(dest_path, format="WEBP", quality=THUMB_QUALITY, method=4)


def _row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    keys = row.keys()
    # reference_image_ids is stored as a JSON array string; parse to
    # a list for the client. Empty / null → empty list.
    raw_refs = row["reference_image_ids"] if "reference_image_ids" in keys else None
    if raw_refs:
        try:
            refs = json.loads(raw_refs)
        except (ValueError, TypeError):
            refs = []
    else:
        refs = []
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
        "has_alpha": bool(row["has_alpha"]) if "has_alpha" in keys else False,
        # Lineage / kind (added for upscale + reference images)
        "kind": row["kind"] if "kind" in keys and row["kind"] else "generate",
        "parent_id": row["parent_id"] if "parent_id" in keys else None,
        "reference_image_ids": refs,
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

app.mount("/static", StaticFiles(directory=STATIC_DIR, html=False, check_dir=True), name="static")


# Tell browsers NOT to cache the JS/CSS/HTML — we serve from disk, every edit
# should be live within one hard refresh. (Browsers will still validate with
# If-None-Match on the next request thanks to the ETag StaticFiles sends.)
from starlette.middleware.base import BaseHTTPMiddleware


class NoCacheStaticMiddleware(BaseHTTPMiddleware):
    """Add Cache-Control: no-store to /static/* and / so we never serve stale JS."""

    async def dispatch(self, request, call_next):
        response = await call_next(request)
        path = request.url.path
        if path == "/" or path.startswith("/static/"):
            response.headers["Cache-Control"] = "no-store, must-revalidate"
            response.headers["Pragma"] = "no-cache"
        return response


app.add_middleware(NoCacheStaticMiddleware)


def _html_response(body: str):
    from starlette.responses import Response
    return Response(
        content=body,
        media_type="text/html",
        # No-cache: the index.html itself carries no version stamp —
        # its JS/CSS modules carry ?v=<git-sha>. Forcing the browser
        # (and any proxy like Tailscale) to revalidate prevents serving
        # a stale shell that points at deleted modules after a deploy.
        headers={"Cache-Control": "no-cache, no-store, must-revalidate"},
    )


@app.get("/")
async def index():
    """Serve index.html stamped with the current build SHA so the
    browser always loads the matching JS/CSS module graph.

    The browser caches each `?v=<sha>` URL as a separate resource;
    bumping the SHA on every deploy guarantees a fresh graph even
    if the page itself stays open across deploys.

    Also inlines the Heroicons SVG sprite (read from disk each
    request — sprite.svg is ~9 KB and changes rarely) so any
    <svg><use href="#icon-…"/></svg> resolves by fragment without
    a separate fetch."""
    html = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    # Stamp CSS + JS so the browser sees them as new resources.
    html = html.replace(
        'href="/static/styles.css"',
        f'href="/static/styles.css?v={BUILD_SHA}"',
        1,
    )
    html = html.replace(
        'src="/static/app.js"',
        f'src="/static/app.js?v={BUILD_SHA}"',
        1,
    )
    # Also stamp the build meta tag so app.js can read it.
    if '<meta name="build"' not in html:
        html = html.replace(
            "<title>qwen-studio</title>",
            f'<title>qwen-studio</title>\n  '
            f'<meta name="build" content="{BUILD_SHA}">',
            1,
        )
    # Inline the icon sprite so <use href="#icon-…"> resolves inline.
    sprite_path = STATIC_DIR / "icons" / "sprite.svg"
    if sprite_path.exists() and "__ICON_SPRITE__" in html:
        sprite = sprite_path.read_text(encoding="utf-8")
        # Drop XML declaration — inline <svg> doesn't need it.
        sprite = sprite.replace('<?xml version="1.0" encoding="UTF-8"?>', "")
        # Strip the file's top-of-file comment block (between <?xml...?>
        # and the opening <svg>); we don't ship the docstring to clients.
        sprite = re.sub(r"<!--.*?-->", "", sprite, count=1, flags=re.DOTALL)
        m = re.search(r"<svg\b[^>]*>", sprite)
        end = sprite.rfind("</svg>")
        if not m or end <= 0:
            html = html.replace("__ICON_SPRITE__", "", 1)
        else:
            sprite_open = m.group(0)
            sprite_inner = sprite[m.end() : end]
            # Hide the sprite visually — it just registers <symbol>s.
            sprite_open_hidden = sprite_open.replace(
                "<svg", '<svg width="0" height="0" style="position:absolute" aria-hidden="true"', 1)
            new_block = sprite_open_hidden + sprite_inner + "</svg>"
            old_block = re.search(
                r'<svg id="icon-sprite"[^>]*data-placeholder="__ICON_SPRITE__"></svg>',
                html,
            )
            if old_block:
                html = html.replace(old_block.group(0), new_block, 1)
    resp = _html_response(html)
    resp.headers["X-Build"] = BUILD_SHA
    return resp


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


@app.get("/api/generate/status")
async def generate_status() -> dict:
    """How many generations are currently in flight. Used by the
    Generate tab to show a 'busy on another device' banner."""
    async with _GEN_LOCK:
        in_flight = len(_GEN_IN_FLIGHT)
        oldest = min(_GEN_IN_FLIGHT.values()) if _GEN_IN_FLIGHT else None
    return {
        "in_flight": in_flight,
        "max": _GEN_MAX,
        "oldest_age": (int(time.time() - oldest) if oldest is not None else 0),
        "busy": _GEN_MAX > 0 and in_flight >= _GEN_MAX,
    }


@app.get("/api/generate/active")
async def generate_active() -> dict:
    """Snapshot of the most recent in-flight OR just-finished generation,
    so a remount of the Generate tab can pick up where it left off.

    Strategy: surface the most recent rid in _GEN_ACTIVE regardless of
    whether it's still running or has finished in the last 60 seconds.
    The client decides what to do (banner vs. autoload result).
    """
    import time as _t
    now = _t.time()
    async with _GEN_LOCK:
        if not _GEN_ACTIVE:
            return {"active": None}
        # Most recent entry — finished OR running. We don't drop finished
        # entries immediately so a client that briefly navigated away can
        # still see the result. Server cleans them up after 60s.
        rid = max(_GEN_ACTIVE, key=lambda r: _GEN_ACTIVE[r]["wall_started_at"])
        entry = dict(_GEN_ACTIVE[rid])  # shallow copy
    age = now - entry["wall_started_at"]
    # Prune old finished entries (kept around briefly for pickup).
    async with _GEN_LOCK:
        stale = [r for r, e in _GEN_ACTIVE.items()
                 if e.get("finished") and e.get("finished_at")
                 and now - e["finished_at"] > 60]
        for r in stale:
            _GEN_ACTIVE.pop(r, None)
    return {
        "active": {
            "rid": rid,
            "wall_started_at": entry["wall_started_at"],
            "age": round(age, 2),
            "prompt": entry.get("prompt", ""),
            "negative": entry.get("negative", ""),
            "size": entry.get("size", ""),
            "steps": entry.get("steps", 0),
            "guidance": entry.get("guidance", 0.0),
            "seed": entry.get("seed", -1),
            "format": entry.get("format", "png"),
            "n": entry.get("n", 1),
            "phase": entry.get("phase", ""),
            "progress": entry.get("progress", 0.0),
            "finished": entry.get("finished", False),
            "error": entry.get("error"),
            "result_image_ids": list(entry.get("result_image_ids", [])),
        }
    }


@app.post("/api/generate", response_model=None)
async def generate(req: GenerateRequest, request: Request):
    """Proxy to brain, persist result, stream SSE progress.

    Event types: {"phase": "..."} | {"progress": 0..1} | {"result": {...}} | {"error": "..."}
    """
    # ----- Concurrency cap ------------------------------------------------
    # Fast-path check before we start the SSE stream so a rejected client
    # gets a clean HTTP 409 instead of an event stream that ends in
    # {"error": "busy"}.
    rid = f"{int(time.time() * 1000)}-{uuid.uuid4().hex[:6]}"
    async with _GEN_LOCK:
        in_flight = len(_GEN_IN_FLIGHT)
        if 0 < _GEN_MAX and in_flight >= _GEN_MAX:
            # Tell the client how long the oldest in-flight job has been
            # running so the user knows roughly when to retry.
            oldest_started = min(_GEN_IN_FLIGHT.values()) if _GEN_IN_FLIGHT else time.time()
            age = max(1, int(time.time() - oldest_started))
            return JSONResponse(
                status_code=409,
                content={
                    "error": "busy",
                    "detail": f"A generation is already in flight ({in_flight}/{_GEN_MAX}). Please wait.",
                    "retry_after": age,
                    "in_flight": in_flight,
                    "max": _GEN_MAX,
                },
                headers={"Retry-After": str(age)},
            )
        # Reserve a slot for this request.
        _GEN_IN_FLIGHT[rid] = time.time()
        request.state.gen_rid = rid
        # Seed the active-state record so /api/generate/active can show
        # progress + handle remounts that arrive mid-generation.
        _GEN_ACTIVE[rid] = {
            "started_at": time.monotonic(),
            "wall_started_at": time.time(),
            "prompt": req.prompt,
            "negative": req.negative,
            "size": req.size,
            "steps": req.steps,
            "guidance": req.guidance,
            "seed": req.seed,
            "format": req.output_format,
            "n": req.n,
            "phase": "queued",
            "progress": 0.0,
            "result_image_ids": [],
            "error": None,
            "finished": False,
            "finished_at": None,
        }

    server_url = _get_setting("server_url", BRAIN_URL)
    has_refs = bool(req.reference_image_ids)

    # When reference images are provided, route to the brain's edits
    # endpoint (which accepts an image[] multipart payload) instead of
    # the generations endpoint (JSON-only). We load the files here and
    # hand them to _run_brain_and_persist via upload_files.
    upload_files: list[tuple[str, bytes, str]] = []
    if has_refs:
        conn = db()
        try:
            for rid_ref in req.reference_image_ids:
                row = conn.execute(
                    "SELECT filename FROM history WHERE id = ?", (rid_ref,)
                ).fetchone()
                if not row:
                    return JSONResponse(
                        status_code=404,
                        content={"error": f"reference image not found: {rid_ref}"},
                    )
                src_path = IMAGES_DIR / row["filename"]
                if not src_path.exists():
                    return JSONResponse(
                        status_code=404,
                        content={"error": f"reference file missing on disk: {rid_ref}"},
                    )
                ext = src_path.suffix.lstrip(".").lower()
                ftype = {"png": "image/png", "jpg": "image/jpeg",
                         "jpeg": "image/jpeg", "webp": "image/webp"}.get(ext, "image/png")
                upload_files.append((src_path.name, src_path.read_bytes(), ftype))
        finally:
            conn.close()

    payload = {
        "model": "Qwen/Qwen-Image-2.1",
        "prompt": req.prompt,
        "negative_prompt": req.negative,
        "size": req.size,
        "num_inference_steps": req.steps,
        "guidance_scale": req.guidance,
        "true_cfg_scale": req.true_cfg_scale,
        "enable_teacache": req.enable_teacache,
        "n": req.n,
        "seed": None if req.seed < 0 else req.seed,
        "output_format": req.output_format,
    }
    if not req.negative:
        payload.pop("negative_prompt")

    brain_path = "/v1/images/edits" if has_refs else "/v1/images/generations"

    async def event_stream():
        yield _sse({"phase": "connecting", "msg": f"Calling {server_url}…"})
        t0 = time.time()

        # Use a queue so progress ticks flow alongside the response.
        # Progress curve is a gentle ramp — we don't really know where in
        # generation the brain is, so we just give the user a sense of
        # motion while the actual request is in flight.
        queue: asyncio.Queue[str | None] = asyncio.Queue()

        async def pump_ticks(stop: asyncio.Event):
            """Tick every 250ms; push SSE-formatted JSON into queue."""
            while not stop.is_set():
                elapsed = time.time() - t0
                # Two regimes: fast (<=4s) and slow
                if elapsed < 4.0:
                    pct = (elapsed / 4.0) * 0.7
                elif elapsed < 12.0:
                    pct = 0.7 + (elapsed - 4.0) / 8.0 * 0.20
                else:
                    pct = 0.9 + min(0.05, (elapsed - 12.0) / 60.0)
                pct = round(min(0.95, pct), 3)
                await queue.put(_sse({
                    "progress": pct, "elapsed": round(elapsed, 1),
                    "phase": "denoising",
                }))
                try:
                    await asyncio.wait_for(stop.wait(), timeout=0.25)
                except asyncio.TimeoutError:
                    pass

        stop = asyncio.Event()
        tick_task = asyncio.create_task(pump_ticks(stop))

        # Run the brain call + persistence in a SEPARATE task. This is
        # the key to surviving client disconnects: when uvicorn tears
        # down the SSE generator, GeneratorExit propagates through the
        # generator — but the brain_task is independent and continues
        # to completion. It persists the result to disk + DB +
        # _GEN_ACTIVE so the client can pick it up via
        # /api/generate/active on remount.
        brain_task = asyncio.create_task(
            _run_brain_and_persist(
                rid=rid,
                req=req,
                payload=payload,
                server_url=server_url,
                queue=queue,
                stop=stop,
                t0=t0,
                brain_path=brain_path,
                upload_files=upload_files or None,
                reference_image_ids=req.reference_image_ids,
            )
        )

        try:
            # Forward queued events to the SSE consumer. When the
            # brain task completes (or the consumer disconnects), we
            # stop yielding.
            while True:
                try:
                    msg = await asyncio.wait_for(queue.get(), timeout=0.5)
                    if msg:
                        # Mirror every tick into _GEN_ACTIVE so a
                        # client that remounts mid-flight sees fresh
                        # phase + progress values without polling.
                        _mirror_tick_into_active(rid, msg)
                        yield msg
                except asyncio.TimeoutError:
                    if brain_task.done():
                        # Drain any final items the brain task queued
                        # right before completing.
                        while not queue.empty():
                            msg = queue.get_nowait()
                            if msg:
                                _mirror_tick_into_active(rid, msg)
                                yield msg
                        break
        finally:
            # Release the concurrency slot — must happen on every code
            # path (success, error, client disconnect) or the slot
            # stays reserved forever. The brain task may still be
            # running if the consumer disconnected early; that's fine,
            # it owns its own _GEN_ACTIVE cleanup.
            async with _GEN_LOCK:
                _GEN_IN_FLIGHT.pop(request.state.gen_rid, None)
            # Cancel the tick pump; it isn't useful once we're done
            # draining.
            tick_task.cancel()

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


def _mirror_tick_into_active(rid: str, msg: str) -> None:
    """Parse an SSE 'data:' line and update _GEN_ACTIVE[rid] with the
    latest phase/progress so a remounting client sees fresh state."""
    if not msg.startswith("data:"):
        return
    try:
        evt = json.loads(msg[len("data:"):].strip())
    except Exception:
        return
    entry = _GEN_ACTIVE.get(rid)
    if entry is None:
        return
    if "phase" in evt:
        entry["phase"] = evt["phase"]
    if "progress" in evt:
        try:
            entry["progress"] = float(evt["progress"])
        except (TypeError, ValueError):
            pass


async def _run_brain_and_persist(
    *,
    rid: str,
    req,
    payload: dict,
    server_url: str,
    queue: asyncio.Queue,
    stop: asyncio.Event,
    t0: float,
    # Lineage / kind metadata. Defaults match plain txt2img so the
    # existing generate endpoint doesn't need to specify anything.
    # _run_upscale() passes kind="upscale" + parent_id=<source>.
    # _run_generate() with reference images passes
    # reference_image_ids=<list>.
    kind: str = "generate",
    parent_id: str | None = None,
    reference_image_ids: list[str] | None = None,
    # Override the brain URL — _run_upscale routes to /v1/images/edits
    # (multipart upload) instead of /v1/images/generations (JSON).
    brain_path: str = "/v1/images/generations",
    # Optional pre-loaded image bytes + filename — used by _run_upscale
    # to send the source image as multipart form-data to /edits.
    upload_files: list[tuple[str, bytes, str]] | None = None,
) -> None:
    """Call the brain, persist results, update _GEN_ACTIVE.

    Runs as an independent asyncio task — survives SSE consumer
    disconnection because it is awaited by no one. The SSE generator
    just drains the queue this task writes to, but if the consumer
    goes away, the brain call and persistence continue regardless.
    """
    try:
        await queue.put(_sse({
            "phase": "denoising", "msg": f"Running {req.steps} steps…",
            "elapsed": 0.0,
        }))

        async with httpx.AsyncClient(timeout=httpx.Timeout(600.0, connect=10.0)) as c:
            try:
                if upload_files:
                    # Multipart path — used by _run_upscale and by
                    # /generate when reference_image_ids is non-empty.
                    # Brain edits endpoint accepts files under either
                    # 'image' (single) or 'image[]' (multiple).
                    files = []
                    for fname, fbytes, ftype in upload_files:
                        files.append(("image[]", (fname, fbytes, ftype)))
                    # Payload fields go alongside as plain form fields.
                    form = {k: ("" if v is None else str(v)) for k, v in payload.items()}
                    resp = await c.post(
                        f"{server_url.rstrip('/')}{brain_path}",
                        data=form,
                        files=files,
                    )
                else:
                    resp = await c.post(
                        f"{server_url.rstrip('/')}{brain_path}",
                        json=payload,
                    )
            except httpx.RequestError as e:
                err = f"brain unreachable: {type(e).__name__}: {e}"
                await queue.put(_sse({"error": err}))
                if rid in _GEN_ACTIVE:
                    _GEN_ACTIVE[rid]["error"] = err
                    _GEN_ACTIVE[rid]["finished"] = True
                    _GEN_ACTIVE[rid]["finished_at"] = time.time()
                return

            if resp.status_code != 200:
                err = f"brain HTTP {resp.status_code}: {resp.text[:300]}"
                await queue.put(_sse({"error": err}))
                if rid in _GEN_ACTIVE:
                    _GEN_ACTIVE[rid]["error"] = err
                    _GEN_ACTIVE[rid]["finished"] = True
                    _GEN_ACTIVE[rid]["finished_at"] = time.time()
                return

            data = resp.json()
            items = data.get("data") or []
            if not items:
                err = f"empty data in response: {json.dumps(data)[:300]}"
                await queue.put(_sse({"error": err}))
                if rid in _GEN_ACTIVE:
                    _GEN_ACTIVE[rid]["error"] = err
                    _GEN_ACTIVE[rid]["finished"] = True
                    _GEN_ACTIVE[rid]["finished_at"] = time.time()
                return

            # Resolve raw bytes for every image. Brain returns either
            # b64_json directly or a relative URL/path we must follow.
            async with httpx.AsyncClient(timeout=60) as cli:
                raw_list: list[bytes] = []
                for item in items:
                    b64 = item.get("b64_json") or item.get("base64")
                    if not b64:
                        url_or_path = item.get("url") or item.get("file_path")
                        if url_or_path:
                            if url_or_path.startswith("/"):
                                full = BRAIN_URL.rstrip("/") + url_or_path
                            elif url_or_path.startswith("output/"):
                                full = BRAIN_URL.rstrip("/") + "/" + url_or_path
                            else:
                                full = url_or_path
                            r2 = await cli.get(full)
                            r2.raise_for_status()
                            b64 = base64.b64encode(r2.content).decode("ascii")
                    if not b64:
                        err = f"no image bytes in item: {json.dumps(item)[:200]}"
                        await queue.put(_sse({"error": err}))
                        if rid in _GEN_ACTIVE:
                            _GEN_ACTIVE[rid]["error"] = err
                            _GEN_ACTIVE[rid]["finished"] = True
                            _GEN_ACTIVE[rid]["finished_at"] = time.time()
                        return
                    raw_list.append(base64.b64decode(b64))

        elapsed = time.time() - t0
        ext = _ext_for(req.output_format)
        from datetime import datetime
        now_iso = datetime.utcnow().isoformat(timespec="seconds")

        # Persist N rows. One row per image — same pattern as the
        # single-image path so history/download/lightbox keep working
        # without modification.
        image_ids: list[str] = []
        conn = db()
        try:
            for raw in raw_list:
                with Image.open(io.BytesIO(raw)) as im:
                    w, h = im.size
                    has_alpha = _has_real_alpha(im)
                image_id, path = _save_original(raw, ext)
                thumb_path = THUMBS_DIR / f"{image_id}.webp"
                try:
                    _make_thumb(path, thumb_path)
                except Exception as e:
                    print(f"[thumb] {image_id}: {e}", file=sys.stderr)
                conn.execute(
                    """INSERT INTO history
                       (id, ts, prompt, negative, width, height, steps, guidance,
                        seed, output_format, filename, elapsed_s, size_bytes,
                        has_alpha, kind, parent_id, reference_image_ids)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                               ?, ?, ?)""",
                    (
                        image_id,
                        now_iso,
                        req.prompt,
                        req.negative,
                        w, h, req.steps, req.guidance,
                        None if req.seed < 0 else req.seed,
                        req.output_format,
                        path.name,
                        round(elapsed, 2),
                        len(raw),
                        1 if has_alpha else 0,
                        # Lineage / kind — passed in by the caller
                        # (the generate handler passes defaults;
                        # _run_upscale passes kind="upscale" + parent_id).
                        kind,
                        parent_id,
                        json.dumps(reference_image_ids or []),
                    ),
                )
                image_ids.append(image_id)
            conn.commit()
        finally:
            conn.close()

        # Now that rows are committed, build entries for the SSE payload.
        entries = [_build_entry(iid) for iid in image_ids]
        await queue.put(_sse({
            "progress": 1.0, "elapsed": round(elapsed, 1), "phase": "done",
        }))
        for entry in entries:
            await queue.put(_sse({"result": entry}))

        # Mark the active record finished so a remounting client can
        # pick the result up even if it missed the SSE.
        if rid in _GEN_ACTIVE:
            _GEN_ACTIVE[rid]["result_image_ids"] = image_ids
            _GEN_ACTIVE[rid]["phase"] = "done"
            _GEN_ACTIVE[rid]["progress"] = 1.0
            _GEN_ACTIVE[rid]["finished"] = True
            _GEN_ACTIVE[rid]["finished_at"] = time.time()
    except Exception as e:
        # Catch-all so the active state always gets marked finished
        # and a remounting client can see what happened.
        err = f"{type(e).__name__}: {e}"
        try:
            await queue.put(_sse({"error": err}))
        except Exception:
            pass
        if rid in _GEN_ACTIVE:
            _GEN_ACTIVE[rid]["error"] = err
            _GEN_ACTIVE[rid]["finished"] = True
            _GEN_ACTIVE[rid]["finished_at"] = time.time()
    finally:
        # Stop the tick pump once we know the brain is done (success
        # or failure).
        stop.set()


@app.post("/api/upscale", response_model=None)
async def upscale(req: UpscaleRequest, request: Request):
    """Up-scale an existing history image via brain's edits endpoint.

    Loads the source by `req.history_id`, sends it to
    `POST /v1/images/edits` with `enable_upscaling: true` and
    `upscaling_scale: req.scale`. SSE stream of progress events.
    The result is persisted as a new history row with
    `kind='upscale'` and `parent_id=<source>`.

    Note on the brain: in sglang 0.5.20cu130, enable_upscaling
    triggers a known bug -- the upscaler receives a 16-channel latent
    instead of decoded RGB and crashes. The /api/upscale code path
    is complete; until the upstream fix, requests return brain
    HTTP 500 at the final 'upscaling' phase after the diffusion
    itself runs fine.
    """
    # Look up the source row first - we need its prompt, negative,
    # width, height before we can claim a slot. We don't claim the
    # slot until after this lookup so a bad history_id returns 404
    # without burning the in-flight budget.
    conn = db()
    try:
        src = conn.execute(
            "SELECT id, prompt, negative, width, height, output_format, filename "
            "FROM history WHERE id = ?", (req.history_id,)
        ).fetchone()
    finally:
        conn.close()
    if not src:
        return JSONResponse(
            status_code=404,
            content={"error": f"history_id not found: {req.history_id}"},
        )
    src_path = IMAGES_DIR / _row_filename(src)
    if not src_path.is_file():
        return JSONResponse(
            status_code=404,
            content={"error": f"source file missing on disk: {req.history_id}"},
        )

    # Same in-flight cap as /api/generate.
    rid = f"{int(time.time() * 1000)}-{uuid.uuid4().hex[:6]}"
    async with _GEN_LOCK:
        in_flight = len(_GEN_IN_FLIGHT)
        if 0 < _GEN_MAX and in_flight >= _GEN_MAX:
            oldest_started = min(_GEN_IN_FLIGHT.values()) if _GEN_IN_FLIGHT else time.time()
            age = max(1, int(time.time() - oldest_started))
            return JSONResponse(
                status_code=409,
                content={
                    "error": "busy",
                    "detail": f"A generation is already in flight ({in_flight}/{_GEN_MAX}). Please wait.",
                    "retry_after": age,
                    "in_flight": in_flight,
                    "max": _GEN_MAX,
                },
                headers={"Retry-After": str(age)},
            )
        _GEN_IN_FLIGHT[rid] = time.time()
        request.state.gen_rid = rid
        prompt = req.prompt if req.prompt is not None else src["prompt"]
        negative = req.negative if req.negative is not None else (src["negative"] or "")
        steps = req.steps if req.steps is not None else 20
        _GEN_ACTIVE[rid] = {
            "started_at": time.monotonic(),
            "wall_started_at": time.time(),
            "prompt": prompt,
            "negative": negative,
            "size": f"{src['width'] * req.scale}x{src['height'] * req.scale}",
            "steps": steps,
            "guidance": 1.0,
            "seed": None,
            "format": src["output_format"],
            "n": 1,
            "phase": "queued",
            "progress": 0.0,
            "result_image_ids": [],
            "error": None,
            "finished": False,
            "finished_at": None,
        }

    server_url = _get_setting("server_url", BRAIN_URL)
    src_ext = src_path.suffix.lstrip(".").lower()
    src_ftype = {"png": "image/png", "jpg": "image/jpeg",
                 "jpeg": "image/jpeg", "webp": "image/webp"}.get(src_ext, "image/png")
    upload_files = [(src_path.name, src_path.read_bytes(), src_ftype)]

    payload = {
        "model": "Qwen/Qwen-Image-2.1",
        "prompt": prompt,
        "negative_prompt": negative,
        "size": f"{src['width'] * req.scale}x{src['height'] * req.scale}",
        "num_inference_steps": steps,
        "guidance_scale": 1.0,  # upscale uses CFG=1 — guided diffusion
        "true_cfg_scale": 1.0,  #   re-introduces artifacts at this stage
        "enable_teacache": True,
        "n": 1,
        "output_format": src["output_format"],
        "enable_upscaling": True,
        "upscaling_scale": req.scale,
    }
    if not negative:
        payload.pop("negative_prompt")

    async def event_stream():
        yield _sse({
            "phase": "connecting",
            "msg": f"Upscaling {req.scale}x via {server_url}…",
        })
        t0 = time.time()
        queue: asyncio.Queue[str | None] = asyncio.Queue()

        async def pump_ticks(stop: asyncio.Event):
            while not stop.is_set():
                elapsed = time.time() - t0
                if elapsed < 4.0:
                    pct = (elapsed / 4.0) * 0.7
                elif elapsed < 12.0:
                    pct = 0.7 + (elapsed - 4.0) / 8.0 * 0.20
                else:
                    pct = 0.9 + min(0.05, (elapsed - 12.0) / 60.0)
                pct = round(min(0.95, pct), 3)
                await queue.put(_sse({
                    "progress": pct, "elapsed": round(elapsed, 1),
                    "phase": "upscaling",
                }))
                try:
                    await asyncio.wait_for(stop.wait(), timeout=0.25)
                except asyncio.TimeoutError:
                    pass

        stop = asyncio.Event()
        tick_task = asyncio.create_task(pump_ticks(stop))

        brain_task = asyncio.create_task(
            _run_brain_and_persist(
                rid=rid,
                # req is unused inside _run_brain_and_persist for
                # fields beyond prompt/negative/steps/seed/format —
                # which we already folded into the payload. Pass a
                # minimal shim that exposes those attrs.
                req=type("_Req", (), {
                    "prompt": prompt,
                    "negative": negative,
                    "size": payload["size"],
                    "steps": steps,
                    "guidance": 1.0,
                    "seed": -1,
                    "output_format": src["output_format"],
                    "true_cfg_scale": 1.0,
                    "enable_teacache": True,
                    "n": 1,
                    "reference_image_ids": [req.history_id],
                })(),
                payload=payload,
                server_url=server_url,
                queue=queue,
                stop=stop,
                t0=t0,
                kind="upscale",
                parent_id=req.history_id,
                brain_path="/v1/images/edits",
                upload_files=upload_files,
            )
        )

        try:
            while True:
                try:
                    msg = await asyncio.wait_for(queue.get(), timeout=0.5)
                    if msg:
                        # Mirror into _GEN_ACTIVE so a remount mid-flight
                        # picks up the latest phase + progress without
                        # polling the brain.
                        _mirror_tick_into_active(rid, msg)
                        yield msg
                except asyncio.TimeoutError:
                    if brain_task.done():
                        # Drain any final items the brain task queued
                        # right before completing.
                        while not queue.empty():
                            msg = queue.get_nowait()
                            if msg:
                                yield msg
                        if brain_task.exception():
                            err = f"internal: {brain_task.exception()}"
                            yield _sse({"error": err})
                        break
        finally:
            stop.set()
            tick_task.cancel()
            try:
                await tick_task
            except (asyncio.CancelledError, Exception):
                pass
            # Cleanup slot
            async with _GEN_LOCK:
                _GEN_IN_FLIGHT.pop(rid, None)
            # Mark active as done (success or failure).
            if rid in _GEN_ACTIVE:
                _GEN_ACTIVE[rid]["finished"] = True
                _GEN_ACTIVE[rid]["finished_at"] = time.time()

    return StreamingResponse(event_stream(), media_type="text/event-stream")


def _row_filename(row) -> str:
    """Extract the filename field from a sqlite3 Row, guarding the
    column-missing case for legacy DBs (same defensive pattern as
    elsewhere in this file).
    """
    try:
        return row["filename"]
    except (KeyError, IndexError):
        return ""


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


@app.get("/api/lineage/{image_id}")
async def get_lineage(image_id: str) -> dict:
    """Return ancestors (parents) and descendants (children) of an item.

    A parent is any row whose `parent_id == image_id`. We also walk the
    reference_image_ids chain backwards: each referenced id is a logical
    ancestor. Self-references (item referencing itself) are skipped.

    Children are found by parent_id == image_id. Multiple upscaled
    versions of the same source are returned as separate children.
    """
    conn = db()
    try:
        # Find the item itself first (needed to start the walk).
        self_row = conn.execute(
            "SELECT * FROM history WHERE id = ?", (image_id,)
        ).fetchone()
        if not self_row:
            raise HTTPException(404, "not found")

        seen = {image_id}
        ancestors: list[dict] = []

        # Walk back through parent_id.
        cursor_id = self_row["parent_id"]
        while cursor_id and cursor_id not in seen:
            seen.add(cursor_id)
            row = conn.execute(
                "SELECT * FROM history WHERE id = ?", (cursor_id,)
            ).fetchone()
            if not row:
                break
            ancestors.append(_row_to_dict(row))
            cursor_id = row["parent_id"]

        # Walk back through reference_image_ids (each is a logical source).
        refs_json = self_row["reference_image_ids"]
        if refs_json:
            import json as _json
            try:
                ref_ids = _json.loads(refs_json)
            except Exception:
                ref_ids = []
            for ref_id in ref_ids:
                if ref_id in seen:
                    continue
                seen.add(ref_id)
                row = conn.execute(
                    "SELECT * FROM history WHERE id = ?", (ref_id,)
                ).fetchone()
                if row:
                    ancestors.append(_row_to_dict(row))

        # Walk forward through descendants (parent_id == image_id).
        descendants = [
            _row_to_dict(r) for r in conn.execute(
                "SELECT * FROM history WHERE parent_id = ? ORDER BY ts DESC",
                (image_id,),
            ).fetchall()
        ]

        return {
            "self": _row_to_dict(self_row),
            "ancestors": ancestors,
            "descendants": descendants,
        }
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


class DownloadRequest(BaseModel):
    ids: list[str]


@app.post("/api/history/download")
async def download_history(req: DownloadRequest) -> StreamingResponse:
    """Bundle a set of history items into a ZIP and stream it back.

    Request:  { "ids": ["uuid1", "uuid2", …] }
    Response: application/zip, attachment; filename=qwen-studio-<ts>.zip

    Filenames inside the ZIP use the original `filename` (which is
    already `qwen_<ts>_<n>.<ext>`), but if a duplicate name would
    collide we suffix a counter. We never refuse — we just skip
    rows whose original files are missing from disk.
    """
    if not req.ids:
        raise HTTPException(400, "ids must be non-empty")
    conn = db()
    try:
        placeholders = ",".join("?" * len(req.ids))
        rows = conn.execute(
            f"SELECT id, filename FROM history WHERE id IN ({placeholders})",
            req.ids,
        ).fetchall()
    finally:
        conn.close()

    if not rows:
        raise HTTPException(404, "no matching ids")

    buf = io.BytesIO()
    used_names: set[str] = set()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for r in rows:
            src = IMAGES_DIR / r["filename"]
            if not src.exists():
                continue
            name = r["filename"]
            # Disambiguate
            base = name
            i = 1
            while name in used_names:
                stem, _, ext = base.rpartition(".")
                name = f"{stem}_{i}.{ext}"
                i += 1
            used_names.add(name)
            zf.write(src, arcname=name)

    buf.seek(0)
    ts = int(time.time())
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="qwen-studio-{ts}.zip"',
            "X-File-Count": str(len(used_names)),
        },
    )


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
        "build": BUILD_SHA,
        "brain_url": BRAIN_URL,
    }


# ============================================================ Entrypoint

if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8000"))
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")
