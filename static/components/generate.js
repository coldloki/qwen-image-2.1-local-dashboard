// Generate tab — two-column desktop layout:
//   Left  : Prompt / Negative prompt / description + last generated image below
//   Right : Sliders + selectors + Generate button
// On mobile (<800px) collapses to single column.

import { api, streamGenerate } from '../api.js';
import { toast, fillSelect } from '../util.js';
import { icon } from './icons.js';

let presets = [];
let currentRequest = null;  // AbortController
let lastResult = null;       // last successful generation (for reload)
let refImageIds = [];        // up to 4 history ids selected as img2img references

export async function render(root) {
  const settings = await api.get('/api/settings');
  presets = await api.get('/api/presets');

  // Pick up any reroll target from the history/preset button. We
  // read this FIRST so an explicit user action (load preset / reroll)
  // overrides the sticky "last generated" snapshot.
  const reroll = consumeReroll();
  // Loading a reroll discards any previously-selected refs (a reroll
  // is meant to reproduce the original — refs would silently change
  // the result). Clear refs explicitly when a reroll lands.
  if (reroll) refImageIds = [];

  // Sticky "last generated" snapshot — used as the initial value when
  // nothing else has set a target. We only honour this when there's
  // no explicit reroll, otherwise the reroll silently loses.
  const last = reroll ? null : sessionStorage.getItem('gen:last');
  const prompt = last ? JSON.parse(last).prompt : '';
  const neg = last ? JSON.parse(last).negative : '';
  const size = settings.default_size || '1024x1024';
  // Add two panoramic options to the dropdown. The model handles 3:1
  // ratios fine; anything more extreme starts to distort.
  const allSizes = ['1024x1024','1280x720','720x1280','1536x1024','1024x1536','1920x768','2048x512','768x768','512x512'];
  const steps = parseInt(settings.default_steps || '28', 10);
  const guidance = parseFloat(settings.default_guidance || '4.0');
  const seed = parseInt(settings.default_seed || '-1', 10);
  const format = settings.default_format || 'png';
  // Advanced defaults — wired below as collapsible section.
  const trueCfg = parseFloat(settings.default_true_cfg ?? '1.0');
  const teacache = settings.default_teacache === undefined
    ? true
    : !!settings.default_teacache;
  const defaultN = parseInt(settings.default_n ?? '1', 10);

  const rerollPrompt = reroll?.prompt ?? '';
  const rerollNeg = reroll?.negative ?? '';
  // Only override the form when the reroll payload actually carries
  // a value — null/undefined means "leave the default alone".
  const initPrompt = reroll ? rerollPrompt : (prompt || '');
  const initNeg = reroll ? rerollNeg : (neg || '');
  const initSize = reroll?.size || size;
  const initSteps = reroll?.steps ?? steps;
  const initGuidance = reroll?.guidance ?? guidance;
  const initSeed = reroll?.seed ?? seed;
  const initFormat = reroll?.output_format || format;
  const initTrueCfg = reroll?.true_cfg_scale ?? trueCfg;
  const initTeacache = reroll?.enable_teacache ?? teacache;
  const initN = [1,2,4].includes(reroll?.n) ? reroll.n : defaultN;

  root.innerHTML = `
    <form class="gen-form" id="gen-form">
      <!-- LEFT COLUMN — what to generate + last result -->
      <div class="col col-left">
        <section class="card">
          <h2 class="card-title">
            ${icon('sparkles', { size: 16 })}
            <span>Prompt</span>
          </h2>
          <p class="card-hint">
            Describe what you want. Be specific about subject, composition,
            lighting, mood, style. Long prompts work well — the model can use
            up to a few hundred words.
          </p>
          <textarea id="prompt" name="prompt" rows="5"
            placeholder="A small red cat sitting on a wooden chair by a sunlit window, soft morning light, photorealistic."
          >${escape(initPrompt)}</textarea>

          <details class="advanced" id="neg-details">
            <summary>
              <span class="advanced-label">Negative prompt</span>
              <span class="advanced-hint">things to avoid — opens</span>
            </summary>
            <textarea id="negative" name="negative" rows="2"
              placeholder="blurry, low quality, watermark, text, extra fingers"
            >${escape(initNeg)}</textarea>
          </details>
        </section>

        <section class="card" id="result-area">
          <div class="card-empty">
            ${icon('photo', { size: 28 })}
            <p>Last generated image will appear here.</p>
          </div>
        </section>
      </div>

      <!-- RIGHT COLUMN — controls -->
      <div class="col col-right">
        <section class="card">
          <h2 class="card-title">
            ${icon('adjustments', { size: 16 })}
            <span>Controls</span>
          </h2>

          ${presets.length ? `
          <div class="row preset-row">
            <label for="preset-select">Preset</label>
            <select id="preset-select">
              <option value="">— Load preset —</option>
              ${presets.map(p =>
                `<option value="${escape(p.name)}">${escape(p.name)}</option>`
              ).join('')}
            </select>
          </div>` : ''}

          <div class="row">
            <div class="field">
              <label for="size">Size</label>
              <select id="size">
                ${fillSelect(allSizes, initSize)}
              </select>
            </div>
            <div class="field">
              <label for="format">Format</label>
              <select id="format">
                ${fillSelect(['png','jpeg','webp'], initFormat)}
              </select>
            </div>
          </div>

          <div class="slider-wrap">
            <div class="slider-label-row">
              <label for="steps">
                Steps
                <span class="hint" title="Denoising iterations. 1 (fast, rough) → 100 (slow, detailed). 28 is a good default.">?</span>
              </label>
              <span class="slider-value" id="steps-val">${initSteps}</span>
            </div>
            <input type="range" id="steps" min="1" max="100" step="1" value="${initSteps}">
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
              <span class="slider-value" id="guidance-val">${Number(initGuidance).toFixed(1)}</span>
            </div>
            <input type="range" id="guidance" min="0" max="20" step="0.1" value="${initGuidance}">
            <div class="slider-ticks">
              <span>0</span><span>5</span><span>10</span><span>15</span><span>20</span>
            </div>
          </div>

          <div class="slider-wrap seed-wrap">
            <div class="slider-label-row">
              <label for="seed">
                Seed
                <span class="hint" title="Random seed for reproducibility. 'random' = a new seed each generation. Type any non-negative integer to lock the seed.">?</span>
              </label>
            </div>
            <input type="number" id="seed" class="seed-input" min="0" max="999999999" step="1" placeholder="random" value="${initSeed < 0 ? '' : initSeed}" autocomplete="off">
            <label class="seed-random-toggle">
              <input type="checkbox" id="seed-random" ${initSeed < 0 ? 'checked' : ''}>
              Random each time
            </label>
          </div>

          <div class="refs-section" id="refs-section">
            <div class="refs-label-row">
              <label>Reference images
                <span class="hint" title="Up to 4 images that guide the generation (img2img). Low steps = closer to the source. Empty = pure generation.">?</span>
              </label>
              <span class="refs-count" id="refs-count">0 / 4</span>
            </div>
            <div class="refs-slots" id="refs-slots">
              <!-- 4 empty slots get injected by paintRefs() -->
            </div>
          </div>

          <details class="advanced" id="advanced-details">
            <summary>
              <span class="advanced-label">Advanced</span>
              <span class="advanced-hint">tune qwen-specific options</span>
            </summary>

            <div class="slider-wrap advanced-slider">
              <div class="slider-label-row">
                <label for="true-cfg">
                  True CFG
                  <span class="hint" title="Second CFG layer that Qwen-Image applies after the first. 1.0 = neutral; 4–6 = stronger prompt adherence; >8 can oversaturate.">?</span>
                </label>
                <span class="slider-value" id="true-cfg-val">${initTrueCfg.toFixed(1)}</span>
              </div>
              <input type="range" id="true-cfg" min="0" max="10" step="0.1" value="${initTrueCfg}">
              <div class="slider-ticks"><span>0</span><span>2.5</span><span>5</span><span>7.5</span><span>10</span></div>
            </div>

            <div class="field advanced-slider" style="margin-top:0.6rem">
              <label for="n">
                Images per request
                <span class="hint" title="How many variants to produce in one click. 1 = single image, 2/4 = small batch (slower but lets you pick the best).">?</span>
              </label>
              <select id="n">
                ${[1,2,4].map(v => `<option value="${v}"${initN === v ? ' selected' : ''}>${v}${v === 1 ? ' (default)' : ''}</option>`).join('')}
              </select>
            </div>

            <label class="seed-random-toggle">
              <input type="checkbox" id="teacache" ${initTeacache ? 'checked' : ''}>
              <span>
                TeaCache
                <span class="advanced-hint" style="margin-left:0.4rem">cache timesteps with low delta — usually faster</span>
              </span>
            </label>
          </details>

          <button type="submit" class="primary submit-btn" id="submit-btn">
            ${icon('sparkles', { size: 16 })}
            <span>Generate</span>
          </button>
          <div id="submit-status" class="submit-status" aria-live="polite"></div>
        </section>
      </div>
    </form>
  `;

  // Wire slider value badges
  const paintBadge = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  };
  const stepsEl = document.getElementById('steps');
  const guidanceEl = document.getElementById('guidance');
  const seedEl = document.getElementById('seed');
  const seedRandom = document.getElementById('seed-random');
  const trueCfgEl = document.getElementById('true-cfg');
  const teacacheEl = document.getElementById('teacache');
  stepsEl.addEventListener('input', () => paintBadge('steps-val', stepsEl.value));
  guidanceEl.addEventListener('input', () =>
    paintBadge('guidance-val', parseFloat(guidanceEl.value).toFixed(1))
  );
  if (trueCfgEl) {
    trueCfgEl.addEventListener('input', () =>
      paintBadge('true-cfg-val', parseFloat(trueCfgEl.value).toFixed(1))
    );
  }
  const paintSeed = () => {
    // Number input. Empty input + checkbox checked = "random" (we
    // send -1 to the brain in that case). Empty input + checkbox
    // unchecked = also "random" (the brain treats -1 as random).
    // Non-empty input + checkbox unchecked = that exact seed.
    if (seedRandom.checked) {
      seedEl.value = '';
      seedEl.disabled = true;
    } else {
      seedEl.disabled = false;
    }
  };
  seedEl.addEventListener('input', () => {
    // If user types a number, auto-uncheck "Random each time".
    if (seedEl.value !== '' && seedRandom.checked) {
      seedRandom.checked = false;
    }
  });
  seedRandom.addEventListener('change', paintSeed);
  paintSeed();
  paintRefs();

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
          const random = p.seed < 0;
          const seedInput = document.getElementById('seed');
          const randomCb = document.getElementById('seed-random');
          if (randomCb) randomCb.checked = random;
          if (seedInput) {
            seedInput.value = random ? '' : p.seed;
            seedInput.disabled = random;
          }
        }
        toast(`Loaded preset "${name}"`, 'success');
      }
    });
  }

  // Form submit
  document.getElementById('gen-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (currentRequest) {
      currentRequest.abort();
      currentRequest = null;
      toast('Cancelled');
      const btn = document.getElementById('submit-btn');
      btn.innerHTML = `${icon('sparkles', { size: 16 })}<span>Generate</span>`;
      return;
    }
    const promptVal = document.getElementById('prompt').value.trim();
    if (!promptVal) { toast('Prompt is required', 'error'); return; }

    const seedRaw = document.getElementById('seed').value;
    const req = {
      prompt: promptVal,
      negative: document.getElementById('negative').value,
      size: document.getElementById('size').value,
      steps: parseInt(document.getElementById('steps').value, 10),
      guidance: parseFloat(document.getElementById('guidance').value),
      seed: seedRaw === '' ? -1 : parseInt(seedRaw, 10),
      output_format: document.getElementById('format').value,
      true_cfg_scale: parseFloat(document.getElementById('true-cfg').value),
      enable_teacache: document.getElementById('teacache').checked,
      n: parseInt(document.getElementById('n').value, 10),
      reference_image_ids: refImageIds.length ? refImageIds : undefined,
    };

    lastResults = [];
    lastResult = null;
    sessionStorage.setItem('gen:last', JSON.stringify({
      prompt: req.prompt, negative: req.negative,
    }));

    currentRequest = new AbortController();
    const btn = document.getElementById('submit-btn');
    btn.innerHTML = `${icon('x-mark', { size: 16 })}<span>Cancel</span>`;
    btn.classList.add('cancel');
    // Clear any leftover running banner from a previous in-flight generation.
    if (_runningPollHandle) { clearInterval(_runningPollHandle); _runningPollHandle = null; }
    _runningBannerEl = null;
    // The big progress card lives in the left column where the
    // finished image will land. Right column gets just a status line.
    renderProgress(promptVal, performance.now());
    const t0 = performance.now();
    const submitStatus = document.getElementById('submit-status');
    if (submitStatus) submitStatus.textContent = 'Starting…';

    function paintStatus(phase, msg) {
      const elapsed = (performance.now() - t0) / 1000;
      const phaseText = msg || phase || 'denoising';
      const info = document.getElementById('progress-info');
      if (info) info.textContent = `${elapsed.toFixed(1)}s · ${phaseText}`;
      const status = document.getElementById('submit-status');
      if (status) status.textContent = `${elapsed.toFixed(1)}s · ${phaseText}`;
    }

    try {
      for await (const evt of streamGenerate(req)) {
        if (typeof evt.progress === 'number') {
          document.getElementById('progress-fill').style.width =
            Math.max(0, Math.min(100, evt.progress * 100)) + '%';
        }
        if (evt.result) {
          document.getElementById('progress-fill').style.width = '100%';
          paintStatus('done');
          lastResult = evt.result;
          lastResults.push(evt.result);
          renderResults(lastResults);
          window.dispatchEvent(new CustomEvent('history:invalidate'));
          continue;
        }
        if (evt.error) {
          renderProgressError(evt.error);
          paintStatus('error');
          toast(evt.error, 'error');
          break;
        }
        if (evt.phase || evt.msg || typeof evt.progress === 'number') {
          paintStatus(evt.phase || 'denoising', evt.msg);
        }
      }
    } catch (e) {
      paintStatus('error');
      if (e.status === 409 && e.payload?.error === 'busy') {
        const wait = e.retryAfter || e.payload?.retry_after || 30;
        renderProgressError(`Busy on another device — try again in ~${wait}s`);
        toast(`Generation busy on another device — try again in ~${wait}s`, 'error', { duration: 4000 });
      } else {
        renderProgressError(e.message || String(e));
        toast(e.message || String(e), 'error');
      }
    } finally {
      currentRequest = null;
      btn.classList.remove('cancel');
      btn.innerHTML = `${icon('sparkles', { size: 16 })}<span>Generate</span>`;
      const submitStatus = document.getElementById('submit-status');
      if (submitStatus) submitStatus.textContent = '';
    }
  });

  // ----- Resume on remount ---------------------------------------------
  // If a generation was running when the user navigated away (or
  // finished while they were on another tab), pick it up. The brain
  // request keeps running server-side; we just need to display the
  // banner / auto-load the result.
  try {
    const { active } = await api.get('/api/generate/active');
    if (!active) return;
    const age = active.age || 0;
    const finished = active.finished;
    const imageIds = active.result_image_ids || [];
    if (finished && imageIds.length > 0) {
      // Auto-load the result that landed while we were away.
      const entries = (await Promise.all(imageIds.map(_hydrateEntry))).filter(Boolean);
      if (entries.length > 0) {
        lastResults = entries;
        renderResults(entries);
        toast(`Loaded ${entries.length} image(s) that finished while you were away`, 'success', { duration: 2500 });
      }
    } else if (!finished) {
      // Still running — show a banner + poll until done.
      _showRunningBanner(active);
    }
  } catch (e) {
    // Best-effort; if /api/generate/active isn't reachable the user
    // just won't see a resume banner.
    console.warn('generate: failed to fetch active generation', e);
  }
}

// Build a result-card-shaped entry from just an image id, by fetching
// the full history row from the server.
async function _hydrateEntry(imageId) {
  try {
    const all = await api.get('/api/history', { limit: 200 });
    return all.find(r => r.id === imageId) || null;
  } catch {
    return null;
  }
}

let _runningBannerEl = null;
let _runningPollHandle = null;

function _showRunningBanner(active) {
  if (_runningBannerEl) return; // already shown
  // Render the same big progress card the submit handler uses,
  // but seeded with the background generation's elapsed time and
  // progress. Lives in the left column where the finished image
  // will land.
  const ageSeconds = active.age || 0;
  const progress = typeof active.progress === 'number' ? active.progress : 0;
  const phase = active.phase || 'running';
  const area = document.getElementById('result-area');
  if (!area) return;
  area.innerHTML = `
    <div class="progress-card" id="running-progress-card">
      <div class="progress-card-icon">${icon('arrow-path', { size: 32, cls: 'spin' })}</div>
      <div class="progress-card-prompt">${escape(active.prompt || '')}</div>
      <div class="progress-bar big"><div class="progress-fill" id="progress-fill" style="width:${(progress * 100).toFixed(1)}%"></div></div>
      <div class="progress-info" id="progress-info">${ageSeconds.toFixed(1)}s · ${phase} · in background</div>
    </div>
  `;
  _runningBannerEl = area.firstElementChild;

  // Poll /api/generate/active every 1.5s. When it reports finished,
  // swap the card for the actual result.
  _runningPollHandle = setInterval(async () => {
    try {
      const { active: latest } = await api.get('/api/generate/active');
      if (!latest || !latest.finished) {
        if (latest) {
          const info = document.getElementById('progress-info');
          const fill = document.getElementById('progress-fill');
          if (info) info.textContent = `${(latest.age || 0).toFixed(1)}s · ${latest.phase || 'running'} · in background`;
          if (fill && typeof latest.progress === 'number') {
            fill.style.width = (Math.max(0, Math.min(1, latest.progress)) * 100).toFixed(1) + '%';
          }
        }
        return;
      }
      clearInterval(_runningPollHandle);
      _runningPollHandle = null;
      _runningBannerEl = null;
      const ids = latest.result_image_ids || [];
      if (ids.length > 0) {
        const entries = (await Promise.all(ids.map(_hydrateEntry))).filter(Boolean);
        if (entries.length > 0) {
          lastResults = entries;
          renderResults(entries);
          toast(`Generation finished — ${entries.length} image(s)`, 'success', { duration: 2500 });
        }
      } else if (latest.error) {
        renderProgressError(latest.error);
      } else {
        clearResult();
      }
    } catch (e) {
      console.warn('generate: active poll failed', e);
    }
  }, 1500);
}

let lastResults = [];

function renderResults(results) {
  // Single image: existing layout. Multiple: tile grid.
  if (results.length <= 1) {
    if (results.length === 1) renderResult(results[0]);
    else clearResult();
    return;
  }
  const cards = results.map((entry, i) => `
    <div class="result-tile${i === 0 ? ' selected' : ''}" data-index="${i}" data-id="${entry.id}">
      <img src="${entry.image_url}" alt="${escape(entry.prompt)}" loading="lazy">
      <span class="tile-num">${i + 1}/${results.length}</span>
    </div>
  `).join('');
  const head = results[0];
  document.getElementById('result-area').innerHTML = `
    <div class="result-card result-grid">
      <div class="result-meta">
        <span><strong>${results.length} images</strong></span>
        <span>${head.width}×${head.height}</span>
        <span>${head.steps} steps</span>
        <span>${head.elapsed_s}s</span>
        <span>${head.output_format.toUpperCase()}</span>
      </div>
      <div class="result-tiles" id="result-tiles">
        ${cards}
      </div>
      <details class="prompt-details">
        <summary>Prompt</summary>
        <div class="prompt-text">${escape(head.prompt)}</div>
      </details>
      <div class="result-actions">
        <button type="button" class="secondary" id="reroll-btn" data-id="${head.id}">
          ${icon('dice', { size: 14 })}<span>Re-roll</span>
        </button>
        <button type="button" class="secondary" id="download-all-btn">
          ${icon('arrow-down-tray', { size: 14 })}<span>Download all</span>
        </button>
      </div>
    </div>
  `;
  document.getElementById('reroll-btn').addEventListener('click', () => {
    sessionStorage.setItem('gen:reroll', JSON.stringify(head));
    document.dispatchEvent(new CustomEvent('reroll:from-result', { detail: head }));
    toast('Loaded into form — re-rolls use same params', 'success');
  });
  document.getElementById('download-all-btn').addEventListener('click', () => {
    results.forEach(e => {
      const a = document.createElement('a');
      a.href = e.image_url;
      a.download = e.filename;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    });
  });
  // Tile click opens a focused preview for that image. We use a fresh
  // <dialog> per grid because the history lightbox expects the
  // gallery "view" array and we don't want to mix scopes.
  const tilesEl = document.getElementById('result-tiles');
  tilesEl.querySelectorAll('.result-tile').forEach(tile => {
    tile.addEventListener('click', () => {
      const idx = parseInt(tile.dataset.index, 10);
      const entry = results[idx];
      const dlg = document.createElement('dialog');
      dlg.className = 'lightbox';
      dlg.innerHTML = `
        <button class="lb-close" type="button" aria-label="Close">×</button>
        <img src="${entry.image_url}" alt="${escape(entry.prompt)}">
        <div class="lb-meta">${idx + 1} / ${results.length} · ${entry.width}×${entry.height} · seed ${entry.seed ?? 'random'}</div>
      `;
      document.body.appendChild(dlg);
      dlg.addEventListener('click', e => {
        // Click outside the image closes the dialog.
        if (e.target === dlg) dlg.close();
      });
      dlg.querySelector('.lb-close').addEventListener('click', () => dlg.close());
      dlg.addEventListener('close', () => dlg.remove());
      dlg.showModal();
    });
  });
}

function clearResult() {
  document.getElementById('result-area').innerHTML = `
    <div class="card-empty">${icon('photo', { size: 28 })}<p>Last generated image will appear here.</p></div>
  `;
}

// In-progress card. Replaces the empty placeholder while the brain
// is generating. Lives in the left column's #result-area — same
// place the finished image lands — so the spatial story is
// coherent: "the image is being born right here."
function renderProgress(prompt, t0) {
  const area = document.getElementById('result-area');
  area.innerHTML = `
    <div class="progress-card" id="progress-card">
      <div class="progress-card-icon">${icon('arrow-path', { size: 32, cls: 'spin' })}</div>
      <div class="progress-card-prompt">${escape(prompt) || '<em>empty prompt</em>'}</div>
      <div class="progress-bar big"><div class="progress-fill" id="progress-fill" style="width:0%"></div></div>
      <div class="progress-info" id="progress-info">Connecting…</div>
    </div>
  `;
}

function renderProgressError(message) {
  const area = document.getElementById('result-area');
  area.innerHTML = `
    <div class="progress-card progress-card--error">
      <div class="progress-card-icon">${icon('exclamation-triangle', { size: 32 })}</div>
      <div class="progress-card-prompt">${escape(message || 'Generation failed')}</div>
    </div>
  `;
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
      <details class="prompt-details">
        <summary>Prompt</summary>
        <div class="prompt-text">${escape(entry.prompt)}</div>
      </details>
      <div class="result-actions">
        <button type="button" class="secondary" id="reroll-btn" data-id="${entry.id}">
          ${icon('dice', { size: 14 })}<span>Re-roll</span>
        </button>
        <a class="secondary" href="${entry.image_url}" download="${entry.filename}">
          ${icon('arrow-down-tray', { size: 14 })}<span>Download</span>
        </a>
      </div>
    </div>
  `;
  document.getElementById('reroll-btn').addEventListener('click', () => {
    sessionStorage.setItem('gen:reroll', JSON.stringify(entry));
    document.dispatchEvent(new CustomEvent('reroll:from-result', { detail: entry }));
    toast('Loaded into form — re-rolls use same params', 'success');
  });
}

function escape(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

export function consumeReroll() {
  const raw = sessionStorage.getItem('gen:reroll');
  if (!raw) return null;
  sessionStorage.removeItem('gen:reroll');
  try { return JSON.parse(raw); } catch { return null; }
}


// ============================================================ Reference images

// 4 slots, click an empty one to open the gallery picker.
function paintRefs() {
  const slotsEl = document.getElementById('refs-slots');
  if (!slotsEl) return;
  slotsEl.innerHTML = '';
  for (let i = 0; i < 4; i++) {
    const id = refImageIds[i] || null;
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'ref-slot' + (id ? ' filled' : ' empty');
    cell.dataset.idx = String(i);
    if (id) {
      // We need the thumb url — fetch history if we don't have it cached.
      cell.innerHTML = `<img alt="" data-id="${id}"><span class="ref-slot-x" title="Remove">${icon('x-mark', { size: 12 })}</span>`;
      resolveThumb(id).then(url => {
        const img = cell.querySelector('img');
        if (img) img.src = url;
      });
    } else {
      cell.innerHTML = `<span class="ref-slot-add">${icon('plus', { size: 18 })}</span>`;
    }
    cell.addEventListener('click', (e) => {
      if (e.target.closest('.ref-slot-x')) {
        refImageIds.splice(i, 1);
        paintRefs();
        return;
      }
      openRefPicker(i);
    });
    slotsEl.appendChild(cell);
  }
  const count = document.getElementById('refs-count');
  if (count) count.textContent = `${refImageIds.length} / 4`;
}

// Caches history items by id so ref thumbnails resolve quickly.
const _historyCache = { items: null, ts: 0 };
async function getHistoryItems() {
  const stale = Date.now() - _historyCache.ts > 30000;
  if (!_historyCache.items || stale) {
    _historyCache.items = await api.get('/api/history');
    _historyCache.ts = Date.now();
  }
  return _historyCache.items;
}
async function resolveThumb(id) {
  const items = await getHistoryItems();
  const it = items.find(x => x.id === id);
  return it ? it.thumb_url : '';
}

// Gallery picker dialog — choose one image to insert into a ref slot.
// Lets users pick from the existing gallery OR upload a fresh image
// from disk (which is added to the gallery as a 'reference' kind row).
async function openRefPicker(slotIdx) {
  const existing = document.getElementById('ref-picker');
  if (existing) existing.remove();
  const dlg = document.createElement('dialog');
  dlg.id = 'ref-picker';
  dlg.className = 'ref-picker';
  dlg.innerHTML = `
    <h3>Pick a reference image</h3>
    <div class="ref-picker-toolbar">
      <button type="button" class="iconbtn" id="ref-picker-upload">
        ${icon('arrow-up-tray', { size: 15 })}<span>Upload from disk</span>
      </button>
      <input type="file" id="ref-picker-file" accept="image/png,image/jpeg,image/webp" hidden>
    </div>
    <div class="ref-picker-grid" id="ref-picker-grid">
      <div class="ref-picker-loading">Loading…</div>
    </div>
    <div class="ref-picker-actions">
      <button type="button" class="iconbtn" id="ref-picker-cancel">Cancel</button>
    </div>
  `;
  document.body.appendChild(dlg);
  dlg.querySelector('#ref-picker-cancel').addEventListener('click', () => dlg.close());
  dlg.addEventListener('close', () => dlg.remove());
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  dlg.showModal();
  // Upload handler — sends the file to /api/upload, inserts the new
  // row id into the ref slot, closes the picker.
  const fileInput = dlg.querySelector('#ref-picker-file');
  dlg.querySelector('#ref-picker-upload').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files?.[0];
    if (!f) return;
    const uploadBtn = dlg.querySelector('#ref-picker-upload');
    uploadBtn.disabled = true;
    const origHtml = uploadBtn.innerHTML;
    uploadBtn.innerHTML = `${icon('arrow-path', { size: 15, cls: 'spin' })}<span>Uploading…</span>`;
    try {
      const fd = new FormData();
      fd.append('file', f);
      const r = await fetch('/api/upload', { method: 'POST', body: fd });
      if (!r.ok) {
        const err = await r.json().catch(() => ({ detail: r.statusText }));
        toast(`Upload failed: ${err.detail || r.statusText}`, 'error');
        return;
      }
      const row = await r.json();
      // Invalidate cache so subsequent picks see the new row.
      _historyCache.items = null;
      refImageIds[slotIdx] = row.id;
      refImageIds = refImageIds.filter(x => x);
      paintRefs();
      dlg.close();
    } catch (e) {
      toast(`Upload failed: ${e.message}`, 'error');
    } finally {
      uploadBtn.disabled = false;
      uploadBtn.innerHTML = origHtml;
    }
  });
  const grid = dlg.querySelector('#ref-picker-grid');
  const items = await getHistoryItems();
  if (!items.length) {
    grid.innerHTML = '<div class="ref-picker-empty">No images yet — upload one or generate something first.</div>';
    return;
  }
  grid.innerHTML = '';
  for (const it of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ref-picker-cell';
    b.title = (it.prompt || '').slice(0, 80) || '(uploaded reference)';
    const usedElsewhere = refImageIds.includes(it.id) && refImageIds[slotIdx] !== it.id;
    b.innerHTML = `<img alt="" src="${it.thumb_url}">${usedElsewhere ? '<span class="ref-picker-dup">already used</span>' : ''}`;
    b.addEventListener('click', () => {
      refImageIds[slotIdx] = it.id;
      refImageIds = refImageIds.filter(x => x); // compact
      paintRefs();
      dlg.close();
    });
    grid.appendChild(b);
  }
}

// Wire up paintRefs() after render()
export function initRefs() {
  paintRefs();
}
