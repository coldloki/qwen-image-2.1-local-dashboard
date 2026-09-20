// History tab — masonry gallery + lightbox + per-tile reroll.

import { api } from '../api.js';
import { toast, escape } from '../util.js';
import { consumeReroll } from './generate.js';

let items = [];
let activeIndex = -1;
let dialog = null;
let imgEl = null;
let counterEl = null;
let barEl = null;

export async function render(root) {
  items = await api.get('/api/history');
  root.innerHTML = `
    <div class="history-toolbar">
      <div class="count" id="count"></div>
      <div>
        <button class="secondary" id="refresh-btn">↻ Refresh</button>
        <button class="danger" id="clear-btn">Clear all</button>
      </div>
    </div>
    <div id="gallery-host"></div>
    <dialog class="lightbox" id="lightbox">
      <div class="lb-body">
        <button class="lb-close" id="lb-close" aria-label="Close">✕</button>
        <div class="lb-counter" id="lb-counter"></div>
        <button class="lb-nav lb-prev" id="lb-prev" aria-label="Previous">‹</button>
        <img id="lb-img" alt="">
        <button class="lb-nav lb-next" id="lb-next" aria-label="Next">›</button>
        <div class="lb-bar" id="lb-bar"></div>
      </div>
    </dialog>
  `;

  dialog = document.getElementById('lightbox');
  imgEl = document.getElementById('lb-img');
  counterEl = document.getElementById('lb-counter');
  barEl = document.getElementById('lb-bar');

  bindLightbox();
  bindToolbar();
  paint();
}

function paint() {
  const host = document.getElementById('gallery-host');
  const count = document.getElementById('count');
  count.textContent = `${items.length} generation${items.length === 1 ? '' : 's'}`;
  if (!items.length) {
    host.innerHTML = `<div class="empty">No history yet. Generate something on the 🎨 tab.</div>`;
    return;
  }
  host.innerHTML = `
    <div class="masonry">
      ${items.map((it, i) => tileHtml(it, i)).join('')}
    </div>
  `;
  host.querySelectorAll('.tile').forEach((el, i) => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.tile-reroll')) return;
      openLightbox(i);
    });
    const rerollBtn = el.querySelector('.tile-reroll');
    rerollBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      reroll(items[i]);
    });
  });
}

function tileHtml(it, i) {
  const ts = (it.ts || '').replace('T', ' ').slice(0, 16);
  return `
    <div class="tile" data-i="${i}" data-id="${it.id}">
      <img src="${it.thumb_url}" alt="" loading="lazy">
      <button class="tile-reroll" title="Re-roll this generation">🎲</button>
      <div class="tile-meta">${escape(ts)} · ${it.width}×${it.height} · seed ${it.seed ?? '?'}</div>
    </div>
  `;
}

function bindLightbox() {
  document.getElementById('lb-close').addEventListener('click', () => dialog.close());
  document.getElementById('lb-prev').addEventListener('click', () => nav(-1));
  document.getElementById('lb-next').addEventListener('click', () => nav(+1));
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close();
  });
  document.addEventListener('keydown', (e) => {
    if (!dialog.open) return;
    if (e.key === 'Escape') dialog.close();
    else if (e.key === 'ArrowLeft') nav(-1);
    else if (e.key === 'ArrowRight') nav(+1);
  });
}

function bindToolbar() {
  document.getElementById('refresh-btn').addEventListener('click', async () => {
    items = await api.get('/api/history');
    paint();
    toast('Refreshed', 'success');
  });
  document.getElementById('clear-btn').addEventListener('click', async () => {
    if (!confirm('Delete ALL history? This cannot be undone.')) return;
    await api.del('/api/history');
    items = [];
    paint();
    toast('History cleared', 'success');
  });
}

function openLightbox(i) {
  if (i < 0 || i >= items.length) return;
  activeIndex = i;
  const it = items[i];
  imgEl.src = it.image_url;
  imgEl.alt = it.prompt;
  counterEl.textContent = `${i + 1} / ${items.length}`;
  barEl.textContent =
    `${it.ts} · ${it.width}×${it.height} · ${it.steps} steps · ` +
    `seed ${it.seed ?? '?'} · ${it.elapsed_s}s\n${it.prompt}`;
  dialog.showModal();
}

function nav(delta) {
  if (!items.length) return;
  activeIndex = (activeIndex + delta + items.length) % items.length;
  openLightbox(activeIndex);
}

function reroll(it) {
  sessionStorage.setItem('gen:reroll', JSON.stringify(it));
  document.dispatchEvent(new CustomEvent('reroll:from-history', { detail: it }));
}

// External: when a new generation completes, refresh in the background
window.addEventListener('history:invalidate', async () => {
  items = await api.get('/api/history');
  paint();
});

// External: switch tab + populate generate
document.addEventListener('reroll:from-history', async (e) => {
  document.querySelector('nav.tabs button[data-tab="generate"]').click();
  // Give generate tab a tick to render
  setTimeout(() => {
    const detail = e.detail;
    if (!detail) return;
    const p = document.getElementById('prompt');
    if (p) {
      p.value = detail.prompt || '';
      document.getElementById('steps').value = detail.steps || 28;
      document.getElementById('seed').value = -1;  // always re-randomize
      document.getElementById('size').value =
        `${detail.width}x${detail.height}`;
      document.getElementById('format').value = detail.output_format || 'png';
      document.getElementById('guidance').value = detail.guidance || 4.0;
      toast('Loaded into Generate. Press Generate to re-roll.', 'success');
    }
  }, 100);
});

export { consumeReroll };
