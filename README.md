# qwen-studio

A clean, fast, responsive web dashboard for a local
[SGLang Diffusion](https://github.com/sgl-project/sglang) brain running
**Qwen-Image-2.1**.

Built as a single-user replacement for a Streamlit prototype that had become
buggy. Two-tier architecture: a fast, lightweight web tier (this repo) that
proxies to the GPU brain only on generate.

```
Browser ──▶ :8000  qwen-studio  (FastAPI + vanilla JS + SQLite)
                  └─▶ :30010  qwen-image-sglang  (SGLang Diffusion, generate only)
```

The web tier persists **history, presets, and settings** in SQLite. Original
images are written to `data/images/`; thumbnails (≤384 px WEBP q=78, with alpha
preserved) to `data/thumbs/`. Both are served by FastAPI as static files.

---

## Features

### Generate
- Two-column desktop layout: prompt + negative prompt + last generated image
  on the left, sliders + selectors on the right. Collapses to single column
  on mobile (<900 px).
- Steps / Guidance / Seed sliders, size + format selectors.
- Negative prompt in a collapsible row to keep the layout calm.
- "Random seed" checkbox plus a visible seed badge.
- **Server-Sent Events** stream real progress (denoising phase + percentage)
  while the brain runs.
- **In-flight generation cap** (default 1, env `MAX_CONCURRENT_GENERATIONS`):
  concurrent requests from multiple devices get a clean **HTTP 409** with a
  `Retry-After` hint instead of OOMing the GPU.
- **Client-disconnect cancellation**: closing the tab mid-generation cancels
  the brain request so GPU time isn't wasted.

### History
- Masonry gallery (auto-fill 260 px, 2 cols on tablet, 1 on mobile).
- Search by prompt text, sort by newest / oldest / largest.
- **Bulk select mode** for download / delete. Select toggle reveals a
  bulk-action bar that's hidden by default.
- **Lightbox** (native `<dialog>`) with keyboard navigation (← / → / Esc),
  alpha-checker backdrop for transparent images, and three actions:
  Download · Re-roll · Delete.
- **Re-roll** re-seeds and re-runs with the same parameters as the source
  image. **Download** writes the full-resolution original with a slugged
  filename `<prompt>-<id8>.<ext>`.
- ZIP bulk download via `POST /api/history/download`.

### Settings
- Defaults: default size, default format, default steps / guidance / seed.
- Prompt presets: name + full generation payload, with **Load** button that
  swaps to the Generate tab and populates the form.
- Server URL field — points the brain connection at any reachable SGLang
  Diffusion endpoint.

### UX details
- **Heroicons v2** outline icons throughout (no emoji).
- Build SHA cache-bust: every page load stamps `?v=<git short sha>` on CSS
  and JS links, so a code change is picked up on the next reload without
  server restart (but the SHA banner still requires a restart to refresh).
- **Active nav state** is just a subtle accent-tinted background pill —
  no underline.
- **Theme button** is icon-only.
- Orange (`#e96e00`) + magenta (`#c72e60`) accent palette. Light + dark
  themes, both use the same warm accent pair.
- Responsive down to 360 px viewport.

---

## Stack

| Layer    | Choice                                                    |
| -------- | --------------------------------------------------------- |
| Backend  | Python 3.11, FastAPI 0.115, uvicorn, httpx, Pillow, SQLite |
| Frontend | Vanilla HTML, ES modules, CSS variables — no build step    |
| Icons    | Heroicons v2 outline (MIT)                                |
| Storage  | SQLite for state, filesystem for image bytes              |
| Lightbox | Native `<dialog>` element                                 |
| Progress | Server-Sent Events                                        |

No bundler, no framework, no transpiler. Edit a JS file → reload.

---

## File layout

```
.
├── server.py                  # FastAPI app: API, SSE, SQLite, image storage
├── requirements.txt
├── Dockerfile
├── data/                      # created at runtime, gitignored
│   ├── studio.db              # history, presets, settings
│   ├── images/<uuid>.png      # originals
│   └── thumbs/<uuid>.webp     # thumbnails (≤384 px, alpha-preserving)
├── static/
│   ├── index.html             # single-page shell with <svg> sprite inline
│   ├── app.js                 # tab router, dynamic imports, theme button
│   ├── styles.css             # all CSS (themes, layout, lightbox, mobile)
│   ├── api.js                 # fetch + streamGenerate (SSE) wrappers
│   ├── util.js                # toast(), escape(), fillSelect()
│   ├── icons/sprite.svg       # Heroicons v2 outline sprite (source of truth)
│   └── components/
│       ├── icons.js           # icon(NAME, {size, cls}) helper
│       ├── generate.js        # Generate tab
│       ├── history.js         # History tab + lightbox
│       └── settings.js        # Settings tab
└── tests/
    ├── test_api.py            # REST + real generation, no browser
    ├── test_e2e_ui.py         # Playwright walk, ~30 s
    └── test_mobile.py         # Pixel 7 viewport smoke, ~5 s
```

---

## API

| Method | Path                          | Purpose                                  |
| ------ | ----------------------------- | ---------------------------------------- |
| GET    | `/api/meta`                   | build tag, brain URL                     |
| GET    | `/api/brain/health`           | brain `/health` proxied                  |
| GET    | `/api/settings`               | current defaults                         |
| PUT    | `/api/settings`               | update defaults                          |
| GET    | `/api/presets`                | list prompt presets                      |
| POST   | `/api/presets`                | add preset                               |
| DELETE | `/api/presets/{name}`         | delete preset                            |
| GET    | `/api/history`                | list history                             |
| GET    | `/api/history/{id}`           | single entry                             |
| DELETE | `/api/history/{id}`           | delete + remove files                    |
| POST   | `/api/history/download`       | ZIP bulk download (ids in body)          |
| GET    | `/api/generate/status`        | in-flight count + oldest age + busy flag |
| POST   | `/api/generate`               | generate (SSE stream)                    |
| GET    | `/images/{id}/original`       | full-resolution image bytes              |
| GET    | `/images/{id}/thumb`          | thumbnail bytes                          |

`POST /api/generate` streams Server-Sent Events with payloads of the form:

```json
{"phase": "denoising", "progress": 0.42, "elapsed": 12.3}
{"result": {...history entry...}}
{"error": "..."}
```

When the in-flight cap is hit, returns `409 Conflict` with `Retry-After`:

```json
{
  "error": "busy",
  "detail": "A generation is already in flight (1/1). Please wait.",
  "retry_after": 17,
  "in_flight": 1,
  "max": 1
}
```

---

## Environment variables

| Variable                     | Default                         | Purpose                                                    |
| ---------------------------- | ------------------------------- | ---------------------------------------------------------- |
| `BRAIN_URL`                  | `http://localhost:30010`        | SGLang Diffusion endpoint                                  |
| `MAX_CONCURRENT_GENERATIONS` | `1`                             | Cap for in-flight `/api/generate` (0 = unlimited, careful) |
| `THUMB_MAX_SIDE`             | `384`                           | Thumbnail longest-side cap, in pixels                      |
| `THUMB_QUALITY`              | `78`                            | WEBP quality for thumbnails                                |
| `BUILD_TAG`                  | git short SHA, or `unknown`     | Stamped into `/api/meta` and the page header               |

`BRAIN_URL` can also be overridden at runtime from the **Settings tab** (stored
in the `settings` table). The env var is the boot-time default.

---

## Run (host)

```bash
pip install -r requirements.txt
# Start the SGLang Diffusion brain separately on :30010
python -m uvicorn server:app --host 0.0.0.0 --port 8000
# open http://localhost:8000
```

## Run (docker-compose)

Add this service to the compose file that already runs the brain:

```yaml
qwen-studio:
  build: ./qwen-studio
  restart: unless-stopped
  ports: ["8000:8000"]
  environment:
    BRAIN_URL: "http://qwen-image-sglang:30010"
    MAX_CONCURRENT_GENERATIONS: "1"
    THUMB_QUALITY: "78"
  volumes:
    - ./qwen-studio/data:/app/data:rw
  depends_on:
    sglang-diffusion: { condition: service_healthy }
```

Then:

```bash
docker compose up -d qwen-studio
# open http://localhost:8000
```

The brain (`qwen-image-sglang`) container is unchanged — this repo only
replaces the previous Streamlit dashboard.

---

## Tests

```bash
python tests/test_api.py        # REST + one real generation, ~10 s
python tests/test_e2e_ui.py     # Playwright UI walk, ~30 s
python tests/test_mobile.py     # Mobile-viewport smoke, ~5 s
```

`tests/test_e2e_ui.py` and `tests/test_mobile.py` use Playwright; set
`PLAYWRIGHT_BROWSERS_PATH` to a directory containing chromium-1228 or
newer if the default cache misses. Screenshots land in
`tests/artifacts/`.

---

## Notes for contributors

- **No auth.** This dashboard is designed for a trusted LAN. If you expose
  it to the internet, put it behind a reverse proxy with auth.
- **Single in-flight cap is intentional.** Two concurrent jobs at 1024×1024
  can push a 24 GB consumer GPU over its VRAM ceiling and OOM the brain
  container. The 409-with-`Retry-After` response is the safe behaviour.
- **Build SHA in `/api/meta`** is captured at process import, not per
  request, so a fresh commit needs a server restart for the banner to
  reflect the new SHA. The CSS / JS cache-bust via `?v=<sha>` picks up
  the new code on the next page reload either way.
- **Heroicons sprite** is inlined into `index.html` at server render time.
  Edit `static/icons/sprite.svg` (the source of truth) — the next page
  load picks up the change.
