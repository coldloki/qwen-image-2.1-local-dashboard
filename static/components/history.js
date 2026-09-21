// History tab — masonry gallery + lightbox + select mode for bulk actions.
//
// Toolbar layout (left → right):
//   [ Search prompt ▢ ]   Sort: [Newest ▾]   [Refresh]   [Select]   [Clear all…]
//
// In Select mode:
//   • Tiles gain a checkbox overlay.
//   • Toolbar swaps "Select" → "Cancel" + reveals [Download N] and
//     [Delete N] buttons.
//   • Header counter shows how many are selected.
//
// Click a tile in Select mode toggles its selection (doesn't open lightbox).

import { api } from '../api.js';
import { toast } from '../util.js';
import { icon } from './icons.js';

let items = [];          // full list from server
let view = [];           // filtered + sorted view
let activeIndex = -1;
let dialog = null;
let imgEl = null;
let counterEl = null;
let barEl = null;

let ui = {
  selectMode: false,
  selected: new Set(),    // ids
  query: '',
  sort: 'newest',         // 'newest' | 'oldest' | 'biggest'
};

export async function render(root) {
  items = await api.get('/api/history');
  root.innerHTML = `
    <div class="history-section">
    <div class="history-toolbar">
      <div class="ht-left">
        <div class="search-wrap">
          <span class="search-icon">${icon('adjustments', { size: 14 })}</span>
          <input type="search" id="hist-search" placeholder="Search prompts…" autocomplete="off">
        </div>
        <label class="sort-wrap">
          <span class="sort-label">Sort</span>
          <select id="hist-sort">
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="biggest">Largest first</option>
          </select>
        </label>
      </div>
      <div class="ht-right">
        <button class="iconbtn" id="refresh-btn" title="Refresh">
          ${icon('arrow-path', { size: 15 })}
          <span>Refresh</span>
        </button>
        <button class="iconbtn" id="select-btn" title="Enter select mode">
          ${icon('squares', { size: 15 })}
          <span>Select</span>
        </button>
        <button class="iconbtn danger" id="clear-btn" title="Delete all history">
          ${icon('trash', { size: 15 })}
          <span>Clear all</span>
        </button>
      </div>
    </div>

    <!-- Select-mode bulk action bar (shown only when ui.selectMode) -->
    <div class="bulk-bar" id="bulk-bar" hidden>
      <span id="bulk-count">0 selected</span>
      <div class="bulk-actions">
        <button class="iconbtn" id="bulk-download" disabled>
          ${icon('arrow-down-tray', { size: 15 })}
          <span id="bulk-download-label">Download</span>
        </button>
        <button class="iconbtn danger" id="bulk-delete" disabled>
          ${icon('trash', { size: 15 })}
          <span id="bulk-delete-label">Delete</span>
        </button>
        <button class="iconbtn" id="bulk-cancel">
          ${icon('x-mark', { size: 15 })}
          <span>Cancel</span>
        </button>
      </div>
    </div>
    </div>

    <div id="gallery-host"></div>

    <dialog class="lightbox" id="lightbox">
      <div class="lb-body">
        <button class="lb-close" id="lb-close" aria-label="Close">
          ${icon('x-mark', { size: 18 })}
        </button>
        <div class="lb-counter" id="lb-counter"></div>
        <button class="lb-nav lb-prev" id="lb-prev" aria-label="Previous">
          ${icon('chevron-down', { size: 22, cls: 'lb-chevron-left' })}
        </button>
        <img id="lb-img" alt="">
        <button class="lb-nav lb-next" id="lb-next" aria-label="Next">
          ${icon('chevron-down', { size: 22, cls: 'lb-chevron-right' })}
        </button>
        <div class="lb-actions">
          <button class="iconbtn primary" id="lb-download" title="Download this image">
            ${icon('arrow-down-tray', { size: 15 })}
            <span>Download</span>
          </button>
          <button class="iconbtn" id="lb-reroll" title="Re-roll with these params">
            ${icon('arrow-path', { size: 15 })}
            <span>Re-roll</span>
          </button>
          <button class="iconbtn danger" id="lb-delete" title="Delete this image">
            ${icon('trash', { size: 15 })}
            <span>Delete</span>
          </button>
        </div>
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

/** Filter `items` by `ui.query`, sort by `ui.sort`, write to `view`. */
function rebuildView() {
  const q = ui.query.trim().toLowerCase();
  view = items.filter(it => !q || (it.prompt || '').toLowerCase().includes(q));
  // The server returns `ts` as an ISO 8601 string; parse it to a
  // numeric epoch ms here so the comparator is robust against either
  // a number or a string in the payload.
  const ts = (it) => {
    if (typeof it.ts_ms === 'number') return it.ts_ms;
    const n = Date.parse(it.ts);
    return Number.isFinite(n) ? n : 0;
  };
  switch (ui.sort) {
    case 'oldest':
      view.sort((a, b) => ts(a) - ts(b));
      break;
    case 'biggest':
      view.sort((a, b) => (b.width * b.height) - (a.width * a.height));
      break;
    case 'newest':
    default:
      view.sort((a, b) => ts(b) - ts(a));
  }
}

function paint() {
  const host = document.getElementById('gallery-host');
  if (!host) return;
  rebuildView();
  if (!view.length) {
    host.innerHTML = `<div class="empty">${
      ui.query
        ? 'No images match your search.'
        : 'No history yet. Generate something on the Generate tab.'
    }</div>`;
    return;
  }
  host.innerHTML = `
    <div class="masonry">
      ${view.map((it, i) => tileHtml(it, i)).join('')}
    </div>
  `;
  host.querySelectorAll('.tile').forEach((el, i) => {
    el.addEventListener('click', (e) => {
      if (ui.selectMode) {
        toggleSelect(view[i].id);
        return;
      }
      openLightbox(i);
    });
  });
  refreshBulkBar();
}

function tileHtml(it, i) {
  const alpha = it.has_alpha ? ' tile--alpha' : '';
  const checked = ui.selected.has(it.id) ? ' tile--checked' : '';
  const selectable = ui.selectMode ? ' tile--selectable' : '';
  return `
    <div class="tile${alpha}${checked}${selectable}" data-i="${i}" data-id="${it.id}">
      <img src="${it.thumb_url}" alt="" loading="lazy">
      <span class="tile-check">${icon('check', { size: 14 })}</span>
    </div>
  `;
}

function bindLightbox() {
  document.getElementById('lb-close').addEventListener('click', () => dialog.close());
  document.getElementById('lb-prev').addEventListener('click', () => nav(-1));
  document.getElementById('lb-next').addEventListener('click', () => nav(+1));
  document.getElementById('lb-download').addEventListener('click', () => {
    if (activeIndex < 0) return;
    const it = view[activeIndex];
    // The /images/<id>/thumb endpoint returns the thumbnail — use the
    // /images/<id>/original endpoint for the full-resolution file.
    const url = `/images/${it.id}/original`;
    const a = document.createElement('a');
    a.href = url;
    // Filename: <prompt-slug>-<id>.<ext>  (ext falls back to png).
    const slug = (it.prompt || 'image')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'image';
    const ext = (it.format || 'png').toLowerCase().replace(/^jpe?g$/, 'jpg');
    a.download = `${slug}-${it.id.slice(0, 8)}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  });
  document.getElementById('lb-reroll').addEventListener('click', () => {
    if (activeIndex >= 0) reroll(view[activeIndex]);
  });
  document.getElementById('lb-delete').addEventListener('click', async () => {
    if (activeIndex < 0) return;
    const it = view[activeIndex];
    if (!confirm(`Delete this image?\n\n"${(it.prompt || '').slice(0, 80)}${(it.prompt||'').length>80?'…':''}"`)) return;
    await api.del(`/api/history/${it.id}`);
    items = items.filter(x => x.id !== it.id);
    if (ui.selected.has(it.id)) ui.selected.delete(it.id);
    if (!items.length) {
      dialog.close();
      activeIndex = -1;
      paint();
      toast('Deleted', 'success');
      return;
    }
    activeIndex = Math.min(activeIndex, view.length - 1);
    if (activeIndex < 0) {
      dialog.close();
    } else {
      openLightbox(activeIndex);
    }
    paint();
  });
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
    // Drop selections that no longer exist
    const ids = new Set(items.map(x => x.id));
    for (const id of [...ui.selected]) if (!ids.has(id)) ui.selected.delete(id);
    paint();
    toast('Refreshed', 'success');
  });

  const selectBtn = document.getElementById('select-btn');
  selectBtn.addEventListener('click', () => {
    setSelectMode(!ui.selectMode);
  });

  document.getElementById('bulk-cancel').addEventListener('click', () => {
    setSelectMode(false);
  });

  document.getElementById('bulk-delete').addEventListener('click', async () => {
    const n = ui.selected.size;
    if (!n) return;
    if (!confirm(`Delete ${n} image${n===1?'':'s'} from history? This cannot be undone.`)) return;
    const ids = [...ui.selected];
    let ok = 0;
    for (const id of ids) {
      try { await api.del(`/api/history/${id}`); ok++; }
      catch { /* skip */ }
    }
    items = items.filter(x => !ui.selected.has(x.id));
    ui.selected.clear();
    setSelectMode(false);
    paint();
    toast(`Deleted ${ok} image${ok===1?'':'s'}`, 'success');
  });

  document.getElementById('bulk-download').addEventListener('click', async () => {
    const ids = [...ui.selected];
    if (!ids.length) return;
    const targets = items.filter(x => ids.includes(x.id));
    if (targets.length === 1) {
      // Single image — direct download via anchor
      const it = targets[0];
      const a = document.createElement('a');
      a.href = it.image_url;
      a.download = it.filename || `${it.id}.${it.output_format || 'png'}`;
      a.click();
      return;
    }
    // Multi — request a zip from the server.
    try {
      toast(`Preparing ${targets.length} images…`, 'success');
      const res = await fetch('/api/history/download', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `qwen-studio-${Date.now()}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast(`Downloaded ${targets.length} images`, 'success');
    } catch (e) {
      toast(`Download failed: ${e.message}`, 'error');
    }
  });

  document.getElementById('clear-btn').addEventListener('click', async () => {
    if (!items.length) {
      toast('History is already empty', 'success');
      return;
    }
    if (!confirm(
      `Delete ALL ${items.length} image${items.length===1?'':'s'} from history?\n\n` +
      'This will remove every saved generation and its files. This cannot be undone.',
    )) return;
    await api.del('/api/history');
    items = [];
    ui.selected.clear();
    setSelectMode(false);
    paint();
    toast(`Cleared ${items.length} images`.replace('0', ''), 'success');
  });

  document.getElementById('hist-search').addEventListener('input', (e) => {
    ui.query = e.target.value;
    paint();
  });
  document.getElementById('hist-sort').addEventListener('change', (e) => {
    ui.sort = e.target.value;
    paint();
  });
}

function setSelectMode(on) {
  ui.selectMode = on;
  if (!on) ui.selected.clear();
  document.getElementById('bulk-bar').hidden = !on;
  document.body.classList.toggle('select-mode', on);
  const selectBtn = document.getElementById('select-btn');
  if (on) {
    selectBtn.innerHTML =
      `${icon('x-mark', { size: 15 })}<span>Done</span>`;
  } else {
    selectBtn.innerHTML =
      `${icon('squares', { size: 15 })}<span>Select</span>`;
  }
  paint();
}

function toggleSelect(id) {
  if (ui.selected.has(id)) ui.selected.delete(id);
  else ui.selected.add(id);
  // Update only the affected tile + bulk bar without re-rendering everything
  const el = document.querySelector(`.tile[data-id="${CSS.escape(id)}"]`);
  if (el) el.classList.toggle('tile--checked', ui.selected.has(id));
  refreshBulkBar();
}

function refreshBulkBar() {
  const n = ui.selected.size;
  const countEl = document.getElementById('bulk-count');
  if (countEl) countEl.textContent = `${n} selected`;
  const downloadBtn = document.getElementById('bulk-download');
  const deleteBtn = document.getElementById('bulk-delete');
  if (downloadBtn) downloadBtn.disabled = n === 0;
  if (deleteBtn) deleteBtn.disabled = n === 0;
  const dlLabel = document.getElementById('bulk-download-label');
  if (dlLabel) dlLabel.textContent = n > 0 ? `Download ${n}` : 'Download';
  const delLabel = document.getElementById('bulk-delete-label');
  if (delLabel) delLabel.textContent = n > 0 ? `Delete ${n}` : 'Delete';
}

function openLightbox(i) {
  if (i < 0 || i >= view.length) return;
  activeIndex = i;
  const it = view[i];
  imgEl.src = it.image_url;
  imgEl.alt = it.prompt;
  if (it.has_alpha) {
    imgEl.classList.add('lb-img--alpha');
    dialog.classList.add('lightbox--alpha');
  } else {
    imgEl.classList.remove('lb-img--alpha');
    dialog.classList.remove('lightbox--alpha');
  }
  counterEl.textContent = `${i + 1} / ${view.length}`;
  barEl.textContent =
    `${it.ts} · ${it.width}×${it.height} · ${it.steps} steps · ` +
    `seed ${it.seed ?? '?'} · ${it.elapsed_s}s\n${it.prompt}`;
  dialog.showModal();
}

function nav(delta) {
  if (!view.length) return;
  activeIndex = (activeIndex + delta + view.length) % view.length;
  openLightbox(activeIndex);
}

function reroll(it) {
  // Hand the entry to the generate tab and switch.
  sessionStorage.setItem('gen:reroll', JSON.stringify(it));
  const generateLink = document.querySelector('[data-tab="generate"]');
  if (generateLink) generateLink.click();
}

// External: when a new generation completes, refresh in the background.
window.addEventListener('history:invalidate', async () => {
  items = await api.get('/api/history');
  const ids = new Set(items.map(x => x.id));
  for (const id of [...ui.selected]) if (!ids.has(id)) ui.selected.delete(id);
  paint();
});

// Re-export consumeReroll so app.js can read it (used elsewhere; harmless).
export function consumeReroll() {
  const raw = sessionStorage.getItem('gen:reroll');
  if (!raw) return null;
  sessionStorage.removeItem('gen:reroll');
  try { return JSON.parse(raw); } catch { return null; }
}
