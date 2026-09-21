// Main app controller. Tab switching, theme, build tag, mount per-tab.

// Read the build SHA stamped into the HTML by the server so we can
// cache-bust the inner module graph. Without this, browsers keep
// using stale component JS even though app.js itself was reloaded.
const BUILD =
  document.querySelector('meta[name="build"]')?.content || 'dev';

// Use dynamic imports with explicit ?v= so each component is a
// separately-cached resource that the browser refetches when the
// build SHA changes.
const loaders = {
  generate: () => import(`./components/generate.js?v=${BUILD}`),
  history: () => import(`./components/history.js?v=${BUILD}`),
  settings: () => import(`./components/settings.js?v=${BUILD}`),
};
const loadApi = () => import(`./api.js?v=${BUILD}`);
const loadIcons = () => import(`./components/icons.js?v=${BUILD}`);

const tabs = document.querySelectorAll('[data-tab]');
const sections = {
  generate: document.getElementById('tab-generate'),
  history: document.getElementById('tab-history'),
  settings: document.getElementById('tab-settings'),
};

const mounted = { generate: false, history: false, settings: false };
const renderers = { generate: null, history: null, settings: null };

async function activate(name) {
  if (!sections[name]) return;
  tabs.forEach(el => {
    const isActive = el.dataset.tab === name;
    el.classList.toggle('active', isActive);
    if (el.tagName === 'A') {
      el.setAttribute('aria-current', isActive ? 'page' : 'false');
    }
  });
  for (const k of Object.keys(sections)) {
    sections[k].hidden = k !== name;
  }
  if (!mounted[name]) {
    mounted[name] = true;
    const mod = await loaders[name]();
    renderers[name] = mod.render;
    await renderers[name](sections[name]);
  }
  if (location.hash.replace('#', '') !== name) {
    history.replaceState(null, '', `#${name}`);
  }
  localStorage.setItem('activeTab', name);
}

tabs.forEach(el => {
  el.addEventListener('click', e => {
    e.preventDefault();
    activate(el.dataset.tab);
  });
});
window.addEventListener('hashchange', () => {
  const t = (location.hash || '').replace('#', '');
  if (sections[t]) activate(t);
});

// Theme toggle — icon + text label so users know exactly what the
// click will do.
const themeBtn = document.getElementById('theme-btn');
const stored = localStorage.getItem('theme') || 'dark';
document.documentElement.dataset.theme = stored;
async function paintThemeBtn() {
  const cur = document.documentElement.dataset.theme;
  const isDark = cur === 'dark';
  const { icon } = await loadIcons();
  // When in dark mode we offer the *action* "Light mode" — show sun icon
  // to hint the direction. When in light mode we offer "Dark mode" +
  // moon icon. Icon is just a visual cue; the text is the source of truth.
  themeBtn.innerHTML =
    icon(isDark ? 'sun' : 'moon', { size: 16 }) +
    `<span>${isDark ? 'Light mode' : 'Dark mode'}</span>`;
  themeBtn.title = `Switch to ${isDark ? 'light' : 'dark'} theme`;
  themeBtn.setAttribute('aria-label', themeBtn.title);
}
paintThemeBtn();
themeBtn.addEventListener('click', () => {
  const cur = document.documentElement.dataset.theme;
  const nxt = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = nxt;
  localStorage.setItem('theme', nxt);
  paintThemeBtn();
});

// Build tag — show the short SHA so you can see at a glance which
// build you're actually running.
const buildTag = document.getElementById('build-tag');
if (buildTag) buildTag.textContent = BUILD;

// Mount initial tab — prefer hash, else last persisted, else default
const initialTab =
  (location.hash || '').replace('#', '') ||
  localStorage.getItem('activeTab') ||
  'generate';
activate(['generate', 'history', 'settings'].includes(initialTab) ? initialTab : 'generate');
