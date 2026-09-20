# qwen-studio

A clean, fast, responsive web UI for the local SGLang Diffusion brain (Qwen-Image-2.1).

## Architecture

Two containers, talking over HTTP:

- **Brain**: `qwen-image-sglang` (SGLang Diffusion, OpenAI-compatible `/v1/images/generations`)
- **Web**: `qwen-studio` (FastAPI + vanilla JS, SQLite for state, proxies to brain only on generate)

```
Browser ──> :8000 studio (HTML/JS, API, SSE)
                  └─> :30010 brain (SGLang Diffusion, on generate only)
```

The web tier persists history, presets, and settings in SQLite. Original images
are written to disk under `data/images/`; thumbnails (384px WEBP q=78) to
`data/thumbs/`. Both are served by FastAPI as static files.

## Stack

- **Backend**: Python 3.11, FastAPI, SQLite, Pillow, httpx
- **Frontend**: vanilla HTML, ES modules, CSS variables (no framework, no build step)
- **Lightbox**: native `<dialog>` element with keyboard + click-backdrop dismiss
- **Masonry**: CSS Grid `repeat(auto-fill, minmax(...))` — 3 cols / 2 / 1
- **Progress**: Server-Sent Events streamed from brain through studio

## API

| Method | Path | Purpose |
| --- | --- | --- |
| GET    | `/api/meta`            | build tag, brain URL |
| GET    | `/api/brain/health`    | brain `/health` proxied |
| GET    | `/api/settings`        | current defaults |
| PUT    | `/api/settings`        | update defaults |
| GET    | `/api/presets`         | list prompt presets |
| POST   | `/api/presets`         | add preset |
| DELETE | `/api/presets/{name}`  | delete preset |
| GET    | `/api/history`         | list history |
| POST   | `/api/generate`        | generate (SSE stream) |
| GET    | `/api/history/{id}`    | single entry |
| DELETE | `/api/history/{id}`    | delete + remove files |
| GET    | `/images/{id}/original` | full image bytes |
| GET    | `/images/{id}/thumb`    | thumbnail bytes |

## Run (host)

```bash
pip install -r requirements.txt
python -m uvicorn server:app --host 0.0.0.0 --port 8000
# open http://localhost:8000
```

## Run (docker-compose)

Add to the existing `qwen-image` compose file:

```yaml
qwen-studio:
  build: ./qwen-studio
  restart: unless-stopped
  ports: ["8000:8000"]
  environment:
    BRAIN_URL: "http://qwen-image-sglang:30010"
    BUILD_TAG: "v0.1"
  volumes:
    - ./qwen-studio/data:/app/data:rw
  depends_on:
    sglang-diffusion: {condition: service_healthy}
```

Then `docker compose up -d qwen-studio` and open `http://localhost:8000`.

## Tests

```bash
python tests/test_api.py        # REST + generation, ~10s
python tests/test_e2e_ui.py     # Playwright UI walk, ~30s
python tests/test_mobile.py     # Pixel 7 viewport smoke, ~5s
```

Artifacts (screenshots) land in `tests/artifacts/`.
