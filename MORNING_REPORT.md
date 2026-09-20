# qwen-studio — morning report (2026-09-21)

## TL;DR

The new app is **live at `http://localhost:8000`**. Streamlit (8501) still
running untouched, as you asked. All E2E tests pass. Pick whichever you want
to use.

## What I built

Two-container architecture, as you proposed:

| Tier | Tech | Role |
| --- | --- | --- |
| **Brain** (`qwen-image-sglang:30010`) | SGLang Diffusion | Generates images. **Unchanged.** |
| **Web** (`qwen-studio:8000`) | FastAPI + vanilla JS + SQLite | UI, state, proxy on generate |

```
Browser ──> :8000 studio (vanilla JS, FastAPI, SQLite)
                  └─> :30010 brain (only called on Generate)
```

Why vanilla JS over Streamlit: no iframe sandbox, no widget API roulette
(`width=` vs `use_container_width`), no HTML sanitization eating our scripts,
real `<dialog>` for lightbox, real CSS Grid masonry.

## What works

- ✅ Generate via SSE — 51.8s for 1024×1024 / 28 steps, 7.8s for 512×512 / 4 steps
- ✅ History tab — masonry 3-col / 2-col / 1-col responsive grid
- ✅ Click-to-open lightbox with prev/next, keyboard arrows, ESC, click-backdrop
- ✅ Per-tile 🎲 reroll (loads params into Generate tab)
- ✅ Re-roll from latest result (button on result card)
- ✅ Presets — add/list/delete, load preset into form
- ✅ Settings — defaults, brain URL, theme
- ✅ Theme toggle (dark/light) via CSS variables, persisted to localStorage
- ✅ Image bytes served with correct `Content-Type` (image/webp for thumbs)
- ✅ Delete history entries (removes original + thumb from disk)
- ✅ Mobile (412px viewport) — single column, all tabs work

## Where it lives

```
C:/Users/dcuki/qwen-studio/
├── server.py              # FastAPI app, 590 lines
├── static/
│   ├── index.html         # 33 lines, 3 tabs
│   ├── styles.css         # single file, theme via CSS vars
│   ├── app.js             # main controller (52 lines)
│   ├── api.js             # fetch + SSE helpers
│   ├── util.js            # escape/toast/fillSelect
│   └── components/
│       ├── generate.js    # form, SSE submit, progress, result
│       ├── history.js     # gallery + lightbox + reroll
│       └── settings.js    # defaults + presets + brain URL
├── tests/
│   ├── test_api.py        # REST + generation E2E
│   ├── test_e2e_ui.py     # Playwright UI walk
│   └── test_mobile.py     # 412px viewport smoke
├── data/
│   ├── studio.db          # SQLite (history, presets, settings)
│   ├── images/            # original outputs (1.7MB PNG per gen)
│   └── thumbs/            # WEBP 384px q=78 (~30KB)
├── Dockerfile             # ready for compose
└── README.md
```

## Test results

```
tests/test_api.py         ✅ ALL PASS (8.0s generation, full CRUD roundtrip)
tests/test_e2e_ui.py      ✅ ALL PASS (Playwright: load → theme → preset → generate → history → lightbox → keyboard → settings → delete)
tests/test_mobile.py      ✅ PASS (412x915 viewport, 1-col grid)
```

## Git history (this repo at `C:\Users\dcuki\qwen-studio\.git`)

```
f2f1012 add: API + mobile tests, README, container Dockerfile
39f1d4c chore: gitignore test artifacts
3f3141b fix: image media-types, more sizes, history paint null-safety
7cdd419 scaffold: FastAPI backend + vanilla JS frontend
c60c1ad Initial commit
```

## Try it

```
http://localhost:8000                    (host)
http://192.168.1.29:8000                 (LAN / phone)
```

Compared to the old `http://192.168.1.29:8501` (Streamlit), you'll notice:

- No iframe
- Page loads instantly (no Streamlit websocket handshake)
- Lightbox is a real native `<dialog>`
- Tabs switch with no flicker
- Mobile is single column automatically

## What's NOT done (candidates for next pass)

- **Bulk generation**: 1 image per request currently. Brain supports N via
  `num_images`. Could be a "Generate 4 variations" button.
- **Search history**: by prompt text, by seed, by date range. Trivial SQL
  queries; needs a search box UI.
- **Image viewer zoom/pan**: nice-to-have for inspecting 1024×1024.
- **Settings export/import**: presets + defaults JSON dump.
- **docker-compose wiring**: Dockerfile is ready but I haven't added the
  service to `qwen-image/docker-compose.yml` yet — wanted your sign-off first.

## When you decide to cut over

1. `docker compose stop qwen-gui` (kills Streamlit on 8501)
2. Add `qwen-studio` service to compose file (snippet in README)
3. `docker compose up -d qwen-studio`
4. Open `:8000` instead of `:8501`

Or just keep both running on different ports and use whichever you want.
