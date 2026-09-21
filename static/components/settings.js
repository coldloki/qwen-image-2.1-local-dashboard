// Settings tab — defaults, presets CRUD, brain health check.

import { api } from '../api.js';
import { toast, escape, fillSelect } from '../util.js';
import { icon } from './icons.js';

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
      <div class="defaults-grid">
        <div class="field">
          <label>Default size</label>
          <select id="def_size">
            ${fillSelect(['1024x1024','1280x720','720x1280','1536x1024','1024x1536','768x768','512x512'], settings.default_size || '1024x1024')}
          </select>
        </div>
        <div class="field">
          <label>Default format</label>
          <select id="def_format">
            ${fillSelect(['png','jpeg','webp'], settings.default_format || 'png')}
          </select>
        </div>
        <div class="slider-wrap">
          <div class="slider-label-row">
            <label>
              Default steps
              <span class="hint" title="How many denoising passes the model takes. More steps = higher quality and slower. 28 is a good balance; 4–8 for fast previews; 50 for max fidelity.">?</span>
            </label>
            <span class="slider-value" id="def_steps-val">${settings.default_steps ?? 28}</span>
          </div>
          <input type="range" id="def_steps" min="1" max="50" step="1" value="${settings.default_steps ?? 28}">
          <div class="slider-ticks"><span>1</span><span>25</span><span>50</span></div>
        </div>
        <div class="slider-wrap">
          <div class="slider-label-row">
            <label>
              Default guidance
              <span class="hint" title="How strictly the model follows your prompt. Lower = more creative, higher = more literal. Try 3–5. Qwen-Image defaults to 4.0.">?</span>
            </label>
            <span class="slider-value" id="def_guidance-val">${parseFloat(settings.default_guidance || 4.0).toFixed(1)}</span>
          </div>
          <input type="range" id="def_guidance" min="0" max="20" step="0.1" value="${settings.default_guidance ?? 4.0}">
          <div class="slider-ticks"><span>0</span><span>10</span><span>20</span></div>
        </div>
        <div class="slider-wrap">
          <div class="slider-label-row">
            <label>
              Default seed
              <span class="hint" title="The random seed for reproducibility. Set -1 (or tick 'Random') for a fresh seed every generation.">?</span>
            </label>
            <span class="slider-value" id="def_seed-val">${(settings.default_seed ?? -1) < 0 ? 'random' : (settings.default_seed ?? -1)}</span>
          </div>
          <input type="range" id="def_seed" min="-1" max="9999" step="1" value="${settings.default_seed ?? -1}">
          <div class="slider-ticks"><span>-1</span><span>5000</span><span>9999</span></div>
        </div>
      </div>
      <button class="primary" id="save-defaults-btn" style="margin-top:var(--space-4); width:auto; padding:0.7rem 1.4rem">Save defaults</button>
    </div>

    <div class="settings-section">
      <h3 style="margin-top:0">Prompt presets</h3>
      <div id="preset-list"></div>
      <div class="new-preset-form">
        <div class="new-preset-label">New preset</div>
        <input type="text" id="new-preset-name" placeholder="preset name">
        <textarea id="new-preset-prompt" placeholder="prompt text…" rows="3"></textarea>
      </div>
      <button class="primary" id="add-preset-btn" style="margin-top:var(--space-3); width:auto; padding:0.7rem 1.4rem">+ Add preset</button>
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
      <div class="preset-info">
        <div class="preset-name">${escape(p.name)}</div>
        <div class="preset-prompt">${escape(p.prompt)}</div>
      </div>
      <div class="preset-actions">
        <button class="secondary" data-action="load" title="Open in Generate tab">
          ${icon('arrow-right', { size: 14 })}<span>Load</span>
        </button>
        <button class="iconbtn danger" data-action="del" title="Delete preset" aria-label="Delete preset">
          ${icon('trash', { size: 14 })}
        </button>
      </div>
    </div>
  `).join('');
  host.querySelectorAll('.preset-row').forEach(row => {
    const name = row.dataset.name;
    row.querySelector('[data-action=load]').addEventListener('click', () => {
      const p = presets.find(x => x.name === name);
      // Hand the preset to generate.js via sessionStorage. Clear
      // gen:last too so the explicit preset takes priority over the
      // sticky "last generated" snapshot — otherwise a previous
      // generation's prompt would win and the preset would appear
      // to "do nothing".
      sessionStorage.removeItem('gen:last');
      sessionStorage.setItem(
        'gen:reroll',
        JSON.stringify({
          prompt: p.prompt,
          steps: p.steps ?? null,
          seed: p.seed ?? null,
          guidance: null,
          size: null,
          output_format: null,
          // Mark as preset-load so generate.js knows to clear any
          // sticky state and use these values verbatim.
          source: 'preset',
        }),
      );
      const link = document.querySelector('[data-tab="generate"]');
      if (link) link.click();
      toast(`Loaded preset "${name}" — press Generate to run`, 'success');
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
  // Live-update slider value badges in Settings → Defaults
  const defSteps = document.getElementById('def_steps');
  const defGuidance = document.getElementById('def_guidance');
  const defSeed = document.getElementById('def_seed');
  defSteps.addEventListener('input', () => {
    document.getElementById('def_steps-val').textContent = defSteps.value;
  });
  defGuidance.addEventListener('input', () => {
    document.getElementById('def_guidance-val').textContent =
      parseFloat(defGuidance.value).toFixed(1);
  });
  defSeed.addEventListener('input', () => {
    const v = parseInt(defSeed.value, 10);
    document.getElementById('def_seed-val').textContent = v < 0 ? 'random' : v;
  });

  document.getElementById('save-defaults-btn').addEventListener('click', async () => {
    const body = {
      default_size: document.getElementById('def_size').value,
      default_steps: parseInt(defSteps.value, 10),
      default_guidance: parseFloat(defGuidance.value),
      default_seed: parseInt(defSeed.value, 10),
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
