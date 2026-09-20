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
        <div>
          <label for="steps">Steps</label>
          <input type="number" id="steps" min="1" max="100" value="${steps}">
        </div>
        <div>
          <label for="guidance">Guidance</label>
          <input type="number" id="guidance" min="0" max="20" step="0.1" value="${guidance}">
        </div>
        <div>
          <label for="seed">Seed (-1 = random)</label>
          <input type="number" id="seed" value="${seed}">
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

  // Preset select wiring
  const presetSelect = document.getElementById('preset-select');
  if (presetSelect) {
    presetSelect.addEventListener('change', () => {
      const name = presetSelect.value;
      if (!name) return;
      const p = presets.find(x => x.name === name);
      if (p) {
        document.getElementById('prompt').value = p.prompt;
        if (p.steps != null) document.getElementById('steps').value = p.steps;
        if (p.seed != null) document.getElementById('seed').value = p.seed;
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
