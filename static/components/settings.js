// Settings tab — defaults, presets CRUD, brain health check.

import { api } from '../api.js';
import { toast, escape, fillSelect } from '../util.js';

let presets = [];
let settings = {};

export async function render(root) {
  settings = await api.get('/api/settings');
  presets = await api.get('/api/presets');

  root.innerHTML = `
    <div class="settings-section">
      <h3 style="margin-top:0">Brain</h3>
      <div style="display:flex;gap:0.5rem;align-items:center">
        <input type="text" id="server_url" value="${escape(settings.server_url || '')}" placeholder="http://localhost:30010">
        <button class="secondary" id="test-btn">Test</button>
        <span id="health-pill"></span>
      </div>
    </div>

    <div class="settings-section">
      <h3 style="margin-top:0">Defaults</h3>
      <div class="row">
        <div>
          <label>Default size</label>
          <select id="def_size">
            ${fillSelect(['1024x1024','1280x720','720x1280','1536x1024','1024x1536'], settings.default_size || '1024x1024')}
          </select>
        </div>
        <div>
          <label>Default steps</label>
          <input type="number" id="def_steps" min="1" max="100" value="${settings.default_steps || '28'}">
        </div>
        <div>
          <label>Default guidance</label>
          <input type="number" id="def_guidance" min="0" max="20" step="0.1" value="${settings.default_guidance || '4.0'}">
        </div>
        <div>
          <label>Default seed</label>
          <input type="number" id="def_seed" value="${settings.default_seed || '-1'}">
        </div>
        <div>
          <label>Default format</label>
          <select id="def_format">
            ${fillSelect(['png','jpeg','webp'], settings.default_format || 'png')}
          </select>
        </div>
      </div>
      <button class="secondary" id="save-defaults-btn" style="margin-top:0.6rem">Save defaults</button>
    </div>

    <div class="settings-section">
      <h3 style="margin-top:0">Prompt presets</h3>
      <div id="preset-list"></div>
      <div class="row" style="margin-top:1rem">
        <input type="text" id="new-preset-name" placeholder="preset name">
      </div>
      <div class="row" style="margin-top:0.4rem">
        <textarea id="new-preset-prompt" placeholder="prompt text…" rows="3"></textarea>
      </div>
      <button class="secondary" id="add-preset-btn" style="margin-top:0.6rem">+ Add preset</button>
    </div>
  `;

  paintPresets();
  bindToolbar();
  bindBrainTest();
}

function paintPresets() {
  const host = document.getElementById('preset-list');
  if (!presets.length) {
    host.innerHTML = `<div style="color:var(--muted);padding:0.5rem 0">No presets yet.</div>`;
    return;
  }
  host.innerHTML = presets.map(p => `
    <div class="preset-row" data-name="${escape(p.name)}">
      <div class="preset-name">${escape(p.name)}</div>
      <div class="preset-prompt">${escape(p.prompt)}</div>
      <button class="secondary" data-action="load">Load</button>
      <button class="danger" data-action="del">×</button>
    </div>
  `).join('');
  host.querySelectorAll('.preset-row').forEach(row => {
    const name = row.dataset.name;
    row.querySelector('[data-action=load]').addEventListener('click', () => {
      const p = presets.find(x => x.name === name);
      sessionStorage.setItem('gen:last', JSON.stringify({ prompt: p.prompt, negative: '' }));
      document.querySelector('nav.tabs button[data-tab="generate"]').click();
      toast(`Loaded preset "${name}"`, 'success');
    });
    row.querySelector('[data-action=del]').addEventListener('click', async () => {
      if (!confirm(`Delete preset "${name}"?`)) return;
      await api.del(`/api/presets/${encodeURIComponent(name)}`);
      presets = await api.get('/api/presets');
      paintPresets();
      toast('Deleted', 'success');
    });
  });
}

function bindToolbar() {
  document.getElementById('save-defaults-btn').addEventListener('click', async () => {
    const body = {
      default_size: document.getElementById('def_size').value,
      default_steps: parseInt(document.getElementById('def_steps').value, 10),
      default_guidance: parseFloat(document.getElementById('def_guidance').value),
      default_seed: parseInt(document.getElementById('def_seed').value, 10),
      default_format: document.getElementById('def_format').value,
    };
    await api.put('/api/settings', body);
    toast('Defaults saved', 'success');
  });

  document.getElementById('add-preset-btn').addEventListener('click', async () => {
    const name = document.getElementById('new-preset-name').value.trim();
    const prompt = document.getElementById('new-preset-prompt').value.trim();
    if (!name || !prompt) { toast('Name and prompt required', 'error'); return; }
    await api.post('/api/presets', { name, prompt, steps: null, seed: null });
    document.getElementById('new-preset-name').value = '';
    document.getElementById('new-preset-prompt').value = '';
    presets = await api.get('/api/presets');
    paintPresets();
    toast(`Saved "${name}"`, 'success');
  });
}

function bindBrainTest() {
  const serverInput = document.getElementById('server_url');
  const pill = document.getElementById('health-pill');
  // Persist server_url when changed
  serverInput.addEventListener('change', async () => {
    await api.put('/api/settings', { server_url: serverInput.value.trim() });
    toast('Server URL saved', 'success');
  });
  document.getElementById('test-btn').addEventListener('click', async () => {
    pill.innerHTML = '<span class="health-pill">…</span>';
    try {
      // Use the live health endpoint via the backend (which knows the URL)
      const r = await fetch('/api/brain/health');
      const j = await r.json();
      pill.innerHTML = j.ok
        ? '<span class="health-pill ok">● OK</span>'
        : `<span class="health-pill fail">● ${escape(j.error || 'fail')}</span>`;
    } catch (e) {
      pill.innerHTML = `<span class="health-pill fail">● ${escape(e.message)}</span>`;
    }
  });
}
