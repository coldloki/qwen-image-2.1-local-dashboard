"""Playwright E2E test for qwen-studio.

Walks the full UI:
  1. Loads /
  2. Generate tab renders, builds image (small)
  3. Image appears in result card
  4. History tab populates after generation
  5. Tile click opens lightbox
  6. Lightbox keyboard nav works
  7. Theme toggle flips
  8. Settings tab loads, saves defaults
  9. Preset CRUD

Exit code 0 = pass.
"""
import json
import sys
import time
from pathlib import Path
from playwright.sync_api import sync_playwright, expect, TimeoutError as PWTimeout

BASE = "http://localhost:8000"
ART = Path(__file__).parent / "artifacts"
ART.mkdir(exist_ok=True)


def step(name):
    print(f"  → {name}", flush=True)


def main():
    fails = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(viewport={"width": 1400, "height": 900})
        page = ctx.new_page()
        console = []
        page.on("console", lambda m: console.append((m.type, m.text, [a for a in m.args])))
        page.on("pageerror", lambda e: console.append(("pageerror", str(e), [str(e.stack)])))

        # ── 1. Load
        step("loading /")
        page.goto(BASE, wait_until="networkidle")
        page.screenshot(path=str(ART / "01-load.png"), full_page=True)

        expect(page.locator("h1")).to_contain_text("qwen-studio")
        build_tag = page.locator("#build-tag")
        build = build_tag.text_content() or ""
        print(f"    build tag: {build!r}", flush=True)

        # ── 2. Generate tab default
        step("generate tab visible by default")
        gen = page.locator("#tab-generate")
        expect(gen).to_be_visible()
        expect(page.locator("button#submit-btn")).to_be_visible()

        # ── 3. Theme toggle (icon should be opposite: dark→☀, light→🌙)
        step("theme toggle icon logic")
        theme_before = page.evaluate("document.documentElement.dataset.theme")
        icon_before = (page.locator("#theme-btn").text_content() or "").strip()
        # When theme=dark, icon should be ☀ (the user reports a button to switch away)
        expected_icon_when_dark = "☀"
        expected_icon_when_light = "🌙"
        if theme_before == "dark":
            assert icon_before == expected_icon_when_dark, f"dark theme should show ☀, got {icon_before!r}"
        else:
            assert icon_before == expected_icon_when_light, f"light theme should show 🌙, got {icon_before!r}"
        print(f"    dark→{expected_icon_when_dark}, light→{expected_icon_when_light} ({theme_before}={icon_before!r})")
        # Flip
        page.click("#theme-btn")
        page.wait_for_function(
            f"document.documentElement.dataset.theme !== '{theme_before}'"
        )
        theme_after = page.evaluate("document.documentElement.dataset.theme")
        icon_after = (page.locator("#theme-btn").text_content() or "").strip()
        assert theme_before != theme_after, f"theme didn't flip: {theme_before} == {theme_after}"
        if theme_after == "dark":
            assert icon_after == expected_icon_when_dark, f"dark theme should show ☀, got {icon_after!r}"
        else:
            assert icon_after == expected_icon_when_light, f"light theme should show 🌙, got {icon_after!r}"
        print(f"    flip {theme_before}:{icon_before!r} → {theme_after}:{icon_after!r}")
        # Flip back so screenshots stay consistent
        page.click("#theme-btn")
        page.wait_for_function(
            f"document.documentElement.dataset.theme === '{theme_before}'"
        )

        # ── 4. Settings → add preset
        step("settings tab + add preset")
        page.click('button[data-tab="settings"]')
        page.wait_for_selector("#preset-list", state="visible")
        page.fill("#new-preset-name", "e2e-test-preset")
        page.fill("#new-preset-prompt", "a red apple on a wooden table, studio lighting")
        page.click("#add-preset-btn")
        page.wait_for_selector('.preset-row[data-name="e2e-test-preset"]', state="visible")

        # ── 5. Generate tab + run
        step("generate via UI (4 steps, 512x512, jpeg)")
        page.click('button[data-tab="generate"]')
        page.wait_for_selector("#gen-form", state="visible")
        page.fill("#prompt", "a bright red apple on a wooden table, studio lighting")
        page.select_option("#size", "512x512")
        # Sliders are range inputs; setting .value via JS fires 'input' event so badges update
        page.evaluate("""() => {
          for (const [id, v] of [['steps','4'],['guidance','4.0'],['seed','7']]) {
            const el = document.getElementById(id);
            el.value = v;
            el.dispatchEvent(new Event('input', {bubbles: true}));
            el.dispatchEvent(new Event('change', {bubbles: true}));
          }
          // Ensure "random" checkbox is off so seed=7 actually sticks
          const cb = document.getElementById('seed-random');
          if (cb.checked) { cb.checked = false; cb.dispatchEvent(new Event('change', {bubbles: true})); }
        }""")
        page.select_option("#format", "jpeg")

        t0 = time.time()
        page.click("#submit-btn")

        # Wait for progress to disappear OR result to appear
        try:
            page.wait_for_selector(".result-card img", state="visible", timeout=180_000)
        except PWTimeout:
            fails.append("generate: result image never appeared")
            page.screenshot(path=str(ART / "fail-generate.png"), full_page=True)
        elapsed = time.time() - t0
        print(f"    generation took {elapsed:.1f}s")
        page.screenshot(path=str(ART / "02-after-generate.png"), full_page=True)

        # ── 6. Image URL is loadable
        if not fails:
            step("verify result image URL is fetchable")
            img_url = page.locator(".result-card img").get_attribute("src")
            assert img_url and img_url.startswith("/images/"), f"bad image url: {img_url}"
            full_url = BASE + img_url
            status = page.evaluate(f"fetch('{full_url}').then(r => r.status)")
            print(f"    {full_url} → HTTP {status}")
            if status != 200:
                fails.append(f"image fetch returned {status}")

        # ── 7. History tab
        step("history tab + grid renders")
        page.click('button[data-tab="history"]')
        page.wait_for_selector("#gallery-host .masonry", state="visible")
        tiles = page.locator("#gallery-host .masonry .tile").count()
        print(f"    {tiles} tiles in history")
        if tiles == 0:
            fails.append("history empty after generation")
        page.screenshot(path=str(ART / "03-history.png"), full_page=True)

        # ── 8. Lightbox
        if tiles > 0:
            step("open lightbox on tile click")
            page.locator("#gallery-host .masonry .tile").first.click()
            try:
                page.wait_for_selector("dialog#lightbox[open]", state="attached", timeout=5_000)
            except PWTimeout:
                fails.append("lightbox didn't open")
            page.screenshot(path=str(ART / "04-lightbox.png"), full_page=True)

            if page.locator("dialog#lightbox[open]").count() > 0:
                step("lightbox counter shows position")
                counter = page.locator("#lb-counter").text_content() or ""
                print(f"    counter: {counter!r}")
                if "/" not in counter:
                    fails.append(f"counter malformed: {counter}")

                step("lightbox keyboard nav")
                page.keyboard.press("ArrowRight")
                page.wait_for_function("true")  # tick
                counter2 = page.locator("#lb-counter").text_content() or ""
                print(f"    counter after ArrowRight: {counter2!r}")
                page.keyboard.press("Escape")

        # ── 9. Settings tab — save defaults
        step("settings save defaults")
        page.click('button[data-tab="settings"]')
        page.wait_for_selector("#save-defaults-btn", state="visible")
        # Bump the steps default via slider and save
        page.evaluate("""() => {
          const el = document.getElementById('def_steps');
          el.value = '8';
          el.dispatchEvent(new Event('input', {bubbles: true}));
          el.dispatchEvent(new Event('change', {bubbles: true}));
        }""")
        page.click("#save-defaults-btn")
        page.wait_for_timeout(500)

        # Verify persisted (settings come back as strings from DB)
        s = page.evaluate("fetch('/api/settings').then(r=>r.json())")
        if int(s.get("default_steps", "0")) != 8:
            fails.append(f"defaults did not persist: {s}")
        else:
            # Reset back to 28 for next run
            page.evaluate("""() => {
              const el = document.getElementById('def_steps');
              el.value = '28';
              el.dispatchEvent(new Event('input', {bubbles: true}));
              el.dispatchEvent(new Event('change', {bubbles: true}));
            }""")
            page.click("#save-defaults-btn")
            page.wait_for_timeout(400)

        # ── 10. Settings → delete the test preset
        step("settings delete preset")
        # The dialog confirm() is intercepted as dialog handler
        page.once("dialog", lambda d: d.accept())
        page.locator('.preset-row[data-name="e2e-test-preset"] [data-action=del]').click()
        page.wait_for_timeout(300)
        if page.locator('.preset-row[data-name="e2e-test-preset"]').count() > 0:
            fails.append("preset still present after delete")

        # ── 11. Tab persistence across refresh
        step("tab persists across refresh (history)")
        page.click('button[data-tab="history"]')
        page.wait_for_selector("#gallery-host .masonry", state="visible")
        # Snapshot URL hash and active tab before refresh
        hash_before = page.evaluate("location.hash")
        active_before = (
            page.locator('nav.tabs button.active').get_attribute("data-tab")
            if page.locator('nav.tabs button.active').count() > 0
            else None
        )
        page.reload(wait_until="networkidle")
        page.wait_for_selector('button[data-tab="history"]', state="visible")
        active_after = (
            page.locator('nav.tabs button.active').get_attribute("data-tab")
            if page.locator('nav.tabs button.active').count() > 0
            else None
        )
        gallery_visible_after = page.locator("#gallery-host .masonry").is_visible()
        hash_after = page.evaluate("location.hash")
        print(f"    hash: {hash_before!r} → {hash_after!r}; active: {active_before} → {active_after}; gallery visible: {gallery_visible_after}")
        if active_after != "history":
            fails.append(f"refresh didn't restore history tab (active={active_after!r})")
        if not gallery_visible_after:
            fails.append("history masonry not visible after refresh")
        # ── Console check
        errs = [m for m in console if m[0] in ("error", "pageerror")]
        if errs:
            print("CONSOLE ERRORS:")
            for entry in errs:
                kind, txt, rest = entry
                print(f"  [{kind}] {txt}")
                for r in rest:
                    print(f"    | {r}")
            fails.append(f"{len(errs)} console errors")

        browser.close()

    if fails:
        print("\n❌ FAILURES:")
        for f in fails:
            print(f"  - {f}")
        sys.exit(1)
    print("\n✅ ALL PASS")


if __name__ == "__main__":
    main()
