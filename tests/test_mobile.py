"""Mobile viewport smoke test."""
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

BASE = "http://localhost:8000"
ART = Path(__file__).parent / "artifacts"
ART.mkdir(exist_ok=True)


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        # Pixel 7
        ctx = browser.new_context(viewport={"width": 412, "height": 915})
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))

        page.goto(BASE, wait_until="networkidle")
        page.screenshot(path=str(ART / "mobile-01-generate.png"), full_page=True)

        # Tab navigation
        page.click('button[data-tab="history"]')
        page.wait_for_selector("#gallery-host", state="visible")
        page.screenshot(path=str(ART / "mobile-02-history.png"), full_page=True)

        # Verify grid is single column at this width
        cols = page.evaluate("""
            () => {
              const el = document.querySelector('.masonry');
              if (!el) return null;
              return getComputedStyle(el).gridTemplateColumns.split(' ').length;
            }
        """)
        print(f"mobile grid columns: {cols}")
        if cols is None or cols != 1:
            print(f"WARN: expected 1 column on mobile, got {cols}")

        # Settings
        page.click('button[data-tab="settings"]')
        page.wait_for_selector("#preset-list", state="visible")
        page.screenshot(path=str(ART / "mobile-03-settings.png"), full_page=True)

        browser.close()

        if errors:
            print("PAGE ERRORS:", errors)
            sys.exit(1)
        print("✅ MOBILE SMOKE PASS")


if __name__ == "__main__":
    main()
