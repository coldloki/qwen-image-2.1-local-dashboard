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

## Setup

This project is a thin web UI on top of a brain container that runs
[SGLang Diffusion](https://github.com/sgl-project/sglang). You need **two**
containers running side-by-side:

| Container         | This repo | Image                                  | Port  |
| ----------------- | --------- | -------------------------------------- | ----- |
| `qwen-image-sglang` | sibling project | `lmsysorg/sglang:v0.5.20-cu130`        | 30010 |
| `qwen-studio`     | this repo | built from `./Dockerfile`              | 8000  |

### Prerequisites

- NVIDIA GPU with **≥ 24 GB VRAM** (RTX 3090, 4090, 5090; tested on RTX 3090)
- Docker with the **NVIDIA Container Toolkit** installed (so containers can
  pass-through the GPU)
- **AMD64 host.** The SGLang image does not work on ARM. If you're on Apple
  Silicon or an ARM server, the manifest still resolves to arm64 by default —
  you must `platform: linux/amd64` in your compose file.
- ~50 GB of disk for the model weights (bf16), plus ~10 GB for the SGLang
  container's diffusion extras installed on first boot.
- ~16 GB of shared memory — `shm_size: 16g` in the brain container is mandatory
  for SGLang's PyTorch internals.

### 1. Get the model weights

SGLang Diffusion loads from a **diffusers-style** directory layout:

```
models/Qwen-Image-2.1/
├── model_index.json
├── transformer/
├── text_encoder/
├── tokenizer/
├── vae/
└── ...
```

The bf16 transformer is ~14 GB. The repo ID on Hugging Face is
`Qwen/Qwen-Image-2.1` (check for the latest revisions). Download it once and
mount it read-only:

```yaml
volumes:
  - ./models/Qwen-Image-2.1:/models/Qwen-Image-2.1:ro
```

> **A note on GGUF quantised weights:** they exist for this model
> (e.g. `qwen-image-2.1-Q4_K_M.gguf`, ~4 GB) but **SGLang's GGUF loader is
> missing `.qweight` support for 5 transformer layers** in this model
> (`modulation.1`, `norm_out.linear`, `proj_out`,
> `time_text_embed.timestep_embedder.linear_{1,2}`) and currently raises
> `Unsupported new parameter`. Stick with the bf16 diffusers layout.

### 2. Start the brain (`qwen-image-sglang`)

A complete `docker-compose.yml` for the brain side, with an entrypoint that
boots SGLang on a 24 GB card:

**`docker-compose.yml`** (in a sibling directory, e.g. `qwen-image/`):

```yaml
services:
  sglang-diffusion:
    # v0.5.20-cu130 ships CUDA 13 + PyTorch + the SGLang runtime preinstalled.
    # First boot also installs "python[diffusion]" extras — see entrypoint.
    image: lmsysorg/sglang:v0.5.20-cu130
    platform: linux/amd64          # pin x86_64; default manifest picks arm64
    container_name: qwen-image-sglang
    restart: unless-stopped
    ports:
      - "30010:30010"             # main HTTP server
      - "30011:30011"             # OpenAI-compatible API docs / UI
    volumes:
      - ./models/Qwen-Image-2.1:/models/Qwen-Image-2.1:ro
      - ./output:/output:rw
      - ./cache:/root/.cache/huggingface:rw
      - ./sglang-entrypoint.sh:/sglang-entrypoint.sh:ro
    environment:
      NVIDIA_VISIBLE_DEVICES: "0"
      HF_HUB_DISABLE_TELEMETRY: "1"
      TRANSFORMERS_OFFLINE: "1"
      SGLANG_DISABLE_VERSION_CHECK: "1"
    entrypoint: ["/bin/bash", "/sglang-entrypoint.sh"]
    deploy:
      resources:
        reservations:
          devices:
            - capabilities: ["gpu"]
              count: 1
              driver: nvidia
    shm_size: "16g"
    healthcheck:
      test: ["CMD-SHELL", "curl -fsS http://localhost:30010/health || exit 1"]
      interval: 30s
      timeout: 10s
      retries: 30
      start_period: 300s   # diffusion install can take 5–10 min on first boot
```

**`sglang-entrypoint.sh`** (in the same directory):

```bash
#!/bin/bash
# Container entrypoint for SGLang Diffusion serving Qwen-Image 2.1.
# RTX 3090 / 4090 24 GB recipe: layerwise offload + memory performance mode.
set -uo pipefail

GCC_SENTINEL="/root/.gcc-installed"
DIFF_SENTINEL="/root/.diffusion-installed"
MODEL_PATH="/models/Qwen-Image-2.1"
OUTPUT_DIR="/output"

mkdir -p "$OUTPUT_DIR"
echo "[entrypoint] $(date -Iseconds) — starting sglang diffusion server"

# Verify the model layout
if [[ ! -f "$MODEL_PATH/model_index.json" ]]; then
  echo "[entrypoint] FATAL: model_index.json not found in $MODEL_PATH"
  ls -la "$MODEL_PATH" 2>/dev/null || true
  exit 1
fi

# Triton JIT may need gcc at runtime
if [[ ! -f "$GCC_SENTINEL" ]]; then
  if ! command -v gcc >/dev/null 2>&1; then
    echo "[entrypoint] Installing gcc (Triton JIT requires it)"
    apt-get update -qq && apt-get install -y --no-install-recommends gcc
  fi
  touch "$GCC_SENTINEL"
fi

# Install diffusion extras on first boot (5–10 min)
if [[ ! -f "$DIFF_SENTINEL" ]]; then
  echo "[entrypoint] Installing sglang[diffusion] extras (one-time)…"
  pip install --upgrade pip setuptools wheel
  cd /root
  [[ -d sglang ]] || git clone --depth 1 https://github.com/sgl-project/sglang.git
  cd /root/sglang
  pip install -e "python[diffusion]"
  touch "$DIFF_SENTINEL"
fi

# Boot sglang serve with the 24 GB recipe
cd /root
exec python3 -m sglang.multimodal_gen.runtime.entrypoints.cli.main serve \
  --model-path "$MODEL_PATH" \
  --model-id Qwen-Image-2.1 \
  --num-gpus 1 \
  --host 0.0.0.0 --port 30010 \
  --attention-backend fa \
  --performance-mode memory \
  --layerwise-offload-components dit,text_encoder \
  --dit-offload-prefetch-size 1 \
  --dit-layerwise-resident-layers 0 \
  --enable-torch-compile false \
  --output-path "$OUTPUT_DIR"
```

Why these specific flags:

- `--attention-backend fa` — FlashAttention 2. Compatible with RTX 30xx;
  torch SDPA fails on this model.
- `--performance-mode memory` — preferring low VRAM over raw speed.
- `--layerwise-offload-components dit,text_encoder` — stream the DiT and text
  encoder from CPU to GPU per layer. **Without this you OOM at 1024×1024 on a
  24 GB card.**
- `--dit-offload-prefetch-size 1` and `--dit-layerwise-resident-layers 0` —
  minimum-residence tuning so VRAM is freed aggressively.
- `--enable-torch-compile false` — saves ~2 minutes of startup and a chunk of
  VRAM, with little perceptible quality cost on consumer cards.

Bring it up:

```bash
docker compose up -d sglang-diffusion
# Tail the logs until you see "Application startup complete" (~5 min)
docker compose logs -f sglang-diffusion
# Sanity check
curl -sS http://localhost:30010/health
# {"status":"ok"}
```

### 3. Add `qwen-studio` (this repo) to the same compose file

Drop this service into the same `docker-compose.yml`:

```yaml
  qwen-studio:
    build: ./qwen-studio            # clone this repo to ./qwen-studio
    container_name: qwen-studio
    restart: unless-stopped
    ports:
      - "8000:8000"
    environment:
      BRAIN_URL: "http://qwen-image-sglang:30010"
      MAX_CONCURRENT_GENERATIONS: "1"
      THUMB_QUALITY: "78"
    volumes:
      - ./qwen-studio/data:/app/data:rw   # persists history across restarts
    depends_on:
      sglang-diffusion:
        condition: service_healthy
```

Then:

```bash
docker compose up -d qwen-studio
# open http://localhost:8000
```

The compose service name `qwen-image-sglang` is reachable on
`http://qwen-image-sglang:30010` from inside the network — that's what
`BRAIN_URL` resolves to.

### 4. Or run qwen-studio on the host (no container)

```bash
git clone https://github.com/coldloki/qwen-image-2.1-local-dashboard.git
cd qwen-image-2.1-local-dashboard
pip install -r requirements.txt
BRAIN_URL=http://localhost:30010 python -m uvicorn server:app --host 0.0.0.0 --port 8000
# open http://localhost:8000
```

The brain always runs in a container — it needs the NVIDIA runtime + 16 GB
shm. Only the web tier can run on the host.

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

## License & credits

MIT — see [`LICENSE`](LICENSE). You can copy, modify, and redistribute this
code (including for commercial purposes) as long as the copyright notice is
preserved. Contributions back are welcome but not required.

Built on:

- [SGLang Diffusion](https://github.com/sgl-project/sglang) (Apache 2.0) — the
  inference server that loads and runs Qwen-Image.
- [FastAPI](https://fastapi.tiangolo.com/) (MIT), [uvicorn](https://www.uvicorn.org/)
  (BSD), [httpx](https://www.python-httpx.org/) (BSD), [Pillow](https://python-pillow.org/)
  (HPND), SQLite (public domain).
- [Heroicons](https://heroicons.com/) v2 outline icons (MIT) — bundled in
  `static/icons/sprite.svg`.
- The `Qwen/Qwen-Image-2.1` model weights themselves are governed by the
  upstream model license; review it before any redistribution.

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
