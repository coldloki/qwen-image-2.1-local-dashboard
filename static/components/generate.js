// Generate tab — form, validation, SSE submit, progress, latest result.

import { api, streamGenerate } from '../api.js';
import { toast, fillSelect } from '../util.js';

let presets = [];
let currentRequest = null;  // AbortController

export async function render(root) {
  const settings = await api.get('/api/settings');
  presets = await api.get('/api/presets');
  const last = sessionStorage.getItem('gen:last');
  const prompt = last ? JSON.parse(last).prompt : '';
  const neg = last ? JSON.parse(last).negative : '';
  const size = settings.default_size || '1024x1024';
  const steps = parseInt(settings.default_steps || '28', 10);
  const guidance = parseFloat(settings.default_guidance || '4.0');
  const seed = parseInt(settings.default_seed || '-1', 10);
  const format = settings.default_format || 'png';

  root.innerHTML = `
    <form class="gen-form" id="gen-form">
      <div>
        <label for="prompt">Prompt</label>
        <textarea id="prompt" name="prompt" rows="4"
          placeholder="A small red cat sitting on a wooden chair by a sunlit window."
        >${escape(prompt)}</textarea>
      </div>

      <div class="row" id="preset-row" style="display:none">
        <select id="preset-select">
          <option value="">— Load preset —</option>
          ${presets.map(p => `<option value="${escape(p.name)}">${escape(p.name)}</option>`).join('')}
        </select>
      </div>

      <div>
        <label for="negative">Negative prompt (optional)</label>
        <textarea id="negative" name="negative" rows="2"
          placeholder="blurry, low quality, watermark">${escape(neg)}</textarea>
      </div>

      <div class="row">
        <div>
          <label for="size">Size</label>
          <select id="size">
            ${fillSelect(['1024x1024','1280x720','720x1280','1536x1024','1024x1536','768x768','512x512'], size)}
          </select>
        </div>
        <div class="slider-wrap">
          <div class="slider-label-row">
            <label for="steps">
              Steps
              <span class="hint" title="Denoising iterations. 1 (fast, rough) → 100 (slow, detailed). 28 is a good default.">?</span>
            </label>
            <span class="slider-value" id="steps-val">${steps}</span>
          </div>
          <input type="range" id="steps" min="1" max="100" step="1" value="${steps}">
          <div class="slider-ticks">
            <span>1</span><span>25</span><span>50</span><span>75</span><span>100</span>
          </div>
        </div>
        <div class="slider-wrap">
          <div class="slider-label-row">
            <label for="guidance">
              Guidance
              <span class="hint" title="Classifier-free guidance scale. 0 (let model decide) → 20 (strict prompt adherence). 4 is balanced.">?</span>
            </label>
            <span class="slider-value" id="guidance-val">${guidance.toFixed(1)}</span>
          </div>
          <input type="range" id="guidance" min="0" max="20" step="0.1" value="${guidance}">
          <div class="slider-ticks">
            <span>0</span><span>5</span><span>10</span><span>15</span><span>20</span>
          </div>
        </div>
        <div class="slider-wrap">
          <div class="slider-label-row">
            <label for="seed">
              Seed
              <span class="hint" title="Random seed for reproducibility. -1 (or empty) = a new random seed each generation.">?</span>
            </label>
            <span class="slider-value" id="seed-val">${seed < 0 ? 'random' : seed}</span>
          </div>
          <input type="range" id="seed" min="-1" max="999999999" step="1" value="${seed}">
          <label class="seed-random-toggle">
            <input type="checkbox" id="seed-random" ${seed < 0 ? 'checked' : ''}>
            Random each time
          </label>
        </div>
        <div>
          <label for="format">Format</label>
          <select id="format">
            ${fillSelect(['png','jpeg','webp'], format)}
          </select>
        </div>
      </div>

      <button type="submit" class="primary" id="submit-btn">Generate</button>

      <div id="progress-area" hidden>
        <div class="progress-bar"><div id="progress-fill"></div></div>
        <div class="progress-info" id="progress-info">Starting…</div>
      </div>

      <div id="result-area"></div>
    </form>
  `;

  // Show preset row if any exist
  if (presets.length) {
    document.getElementById('preset-row').style.display = '';
  }

  // Live-update slider value badges + sync seed-random checkbox
  function paintBadge(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  }
  const stepsEl = document.getElementById('steps');
  const guidanceEl = document.getElementById('guidance');
  const seedEl = document.getElementById('seed');
  const seedRandom = document.getElementById('seed-random');
  stepsEl.addEventListener('input', () => paintBadge('steps-val', stepsEl.value));
  guidanceEl.addEventListener('input', () =>
    paintBadge('guidance-val', parseFloat(guidanceEl.value).toFixed(1))
  );
  function paintSeed() {
    const v = parseInt(seedEl.value, 10);
    paintBadge('seed-val', seedRandom.checked || v < 0 ? 'random' : v);
  }
  seedEl.addEventListener('input', paintSeed);
  seedRandom.addEventListener('change', () => {
    if (seedRandom.checked) seedEl.value = -1;
    paintSeed();
  });

  // Preset select wiring
  const presetSelect = document.getElementById('preset-select');
  if (presetSelect) {
    presetSelect.addEventListener('change', () => {
      const name = presetSelect.value;
      if (!name) return;
      const p = presets.find(x => x.name === name);
      if (p) {
        document.getElementById('prompt').value = p.prompt;
        if (p.steps != null) {
          document.getElementById('steps').value = p.steps;
          document.getElementById('steps-val').textContent = p.steps;
        }
        if (p.seed != null) {
          document.getElementById('seed').value = p.seed;
          const random = p.seed < 0;
          document.getElementById('seed-random').checked = random;
          document.getElementById('seed-val').textContent = random ? 'random' : p.seed;
        }
        toast(`Loaded preset "${name}"`, 'success');
      }
    });
  }

  // Form submit
  document.getElementById('gen-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (currentRequest) {
      // Allow cancel: abort the in-flight fetch.
      currentRequest.abort();
      currentRequest = null;
      toast('Cancelled');
      document.getElementById('submit-btn').textContent = 'Generate';
      return;
    }
    const promptVal = document.getElementById('prompt').value.trim();
    if (!promptVal) { toast('Prompt is required', 'error'); return; }

    const req = {
      prompt: promptVal,
      negative: document.getElementById('negative').value,
      size: document.getElementById('size').value,
      steps: parseInt(document.getElementById('steps').value, 10),
      guidance: parseFloat(document.getElementById('guidance').value),
      seed: parseInt(document.getElementById('seed').value, 10),
      output_format: document.getElementById('format').value,
    };

    sessionStorage.setItem('gen:last', JSON.stringify({
      prompt: req.prompt, negative: req.negative,
    }));

    currentRequest = new AbortController();
    document.getElementById('submit-btn').textContent = 'Cancel';
    document.getElementById('progress-area').hidden = false;
    document.getElementById('progress-fill').style.width = '0%';
    document.getElementById('progress-info').textContent = 'Starting…';
    document.getElementById('result-area').innerHTML = '';

    try {
      // SSE doesn't support AbortController in the same way — but we can
      // race it against a timeout/abort. For now we just iterate.
      for await (const evt of streamGenerate(req)) {
        if (evt.phase) {
          document.getElementById('progress-info').textContent =
            evt.msg || evt.phase;
        }
        if (typeof evt.progress === 'number') {
          document.getElementById('progress-fill').style.width =
            (evt.progress * 100) + '%';
          if (evt.elapsed != null) {
            document.getElementById('progress-info').textContent =
              `⏱ ${evt.elapsed.toFixed(1)}s · ${evt.phase || 'denoising'}`;
          }
        }
        if (evt.error) {
          toast(evt.error, 'error');
          break;
        }
        if (evt.result) {
          renderResult(evt.result);
          // Notify history tab if mounted
          window.dispatchEvent(new CustomEvent('history:invalidate'));
        }
      }
    } catch (e) {
      toast(e.message || String(e), 'error');
    } finally {
      currentRequest = null;
      document.getElementById('submit-btn').textContent = 'Generate';
      document.getElementById('progress-fill').style.width = '100%';
    }
  });
}

function renderResult(entry) {
  document.getElementById('result-area').innerHTML = `
    <div class="result-card">
      <img src="${entry.image_url}" alt="${escape(entry.prompt)}">
      <div class="result-meta">
        <span><strong>${entry.width}×${entry.height}</strong></span>
        <span>${entry.steps} steps</span>
        <span>seed ${entry.seed ?? 'random'}</span>
        <span>${entry.elapsed_s}s</span>
        <span>${entry.output_format.toUpperCase()}</span>
      </div>
      <details style="margin-top:0.5rem">
        <summary style="cursor:pointer;color:var(--muted)">Prompt</summary>
        <div style="margin-top:0.3rem">${escape(entry.prompt)}</div>
      </details>
      <div style="margin-top:0.6rem">
        <button class="secondary" id="reroll-btn" data-id="${entry.id}">🎲 Re-roll this</button>
        <a class="secondary" href="${entry.image_url}" download="${entry.filename}" style="text-decoration:none;display:inline-block">⬇ Download</a>
      </div>
    </div>
  `;
  document.getElementById('reroll-btn').addEventListener('click', () => {
    sessionStorage.setItem('gen:reroll', JSON.stringify(entry));
    document.dispatchEvent(new CustomEvent('reroll:from-result', { detail: entry }));
  });
}

function escape(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

// Public hook for history-tab reroll
export function consumeReroll() {
  const raw = sessionStorage.getItem('gen:reroll');
  if (!raw) return null;
  sessionStorage.removeItem('gen:reroll');
  return JSON.parse(raw);
}
