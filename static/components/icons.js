// Helper for inline Heroicons. Each `icon(NAME, opts)` returns an
// HTML string of the form `<svg …><use href="#icon-NAME"/></svg>`.
//
// The sprite itself is inlined into <body> at the top of the
// document by the server (see server.py `/` route, which reads
// static/icons/sprite.svg and substitutes it for the placeholder).
// That means <use href="#icon-NAME"> resolves by fragment within the
// same document — no extra fetch, no cross-document weirdness.
//
// Icons are stroke-based; currentColor is used so they pick up the
// parent element's `color`. Wrap them in a sized container for layout.

const DEFAULT_OPTS = {
  size: 18,           // px; sets width + height
  cls: "",            // extra class names for CSS hooks
  title: null,        // when set, adds <title> child for tooltip + a11y
  strokeWidth: null,  // override stroke-width on the symbol; default is 1.5
};

/**
 * @param {string} name      Symbol id in sprite.svg (without "icon-" prefix).
 * @param {object} [opts]
 * @returns {string}         Raw HTML to be inserted via innerHTML.
 */
export function icon(name, opts = {}) {
  const o = { ...DEFAULT_OPTS, ...opts };
  const titlePart = o.title
    ? `<title>${escapeHtml(o.title)}</title>`
    : "";
  return (
    `<svg class="icon ${escapeAttr(o.cls)}"` +
    ` width="${o.size}" height="${o.size}"` +
    ` aria-hidden="${o.title ? "false" : "true"}"` +
    (o.title ? ` role="img"` : "") +
    `><use href="#icon-${escapeAttr(name)}"/>${titlePart}</svg>`
  );
}

/** Convenience: returns an icon wrapped in a button-like span. */
export function iconBtn(name, opts = {}) {
  return icon(name, opts);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(s) {
  return escapeHtml(s);
}
