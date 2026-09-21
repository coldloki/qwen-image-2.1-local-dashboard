// Main app controller. Tab switching, theme, build tag, mount per-tab.

import { render as renderGenerate } from './components/generate.js';
import { render as renderHistory } from './components/history.js';
import { render as renderSettings } from './components/settings.js';
import { api } from './api.js';

const tabs = document.querySelectorAll('nav.tabs button');
const sections = {
  generate: document.getElementById('tab-generate'),
  history: document.getElementById('tab-history'),
  settings: document.getElementById('tab-settings'),
};

const renders = { generate: renderGenerate, history: renderHistory, settings: renderSettings };
const mounted = { generate: false, history: false, settings: false };

async function activate(name) {
  tabs.forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  for (const k of Object.keys(sections)) {
    sections[k].hidden = k !== name;
  }
  if (!mounted[name]) {
    mounted[name] = true;
    await renders[name](sections[name]);
  }
  if (location.hash.replace('#', '') !== name) {
    history.replaceState(null, '', `#${name}`);
  }
  localStorage.setItem('activeTab', name);
}

tabs.forEach(b => b.addEventListener('click', () => activate(b.dataset.tab)));
window.addEventListener('hashchange', () => {
  const t = (location.hash || '').replace('#', '');
  if (sections[t]) activate(t);
});

// Theme toggle
const themeBtn = document.getElementById('theme-btn');
const stored = localStorage.getItem('theme') || 'dark';
document.documentElement.dataset.theme = stored;
function paintThemeBtn() {
  const cur = document.documentElement.dataset.theme;
  themeBtn.textContent = cur === 'dark' ? '☀' : '🌙';
  themeBtn.setAttribute('aria-label', `Switch to ${cur === 'dark' ? 'light' : 'dark'} theme`);
  themeBtn.title = `Switch to ${cur === 'dark' ? 'light' : 'dark'} theme`;
}
paintThemeBtn();
themeBtn.addEventListener('click', () => {
  const cur = document.documentElement.dataset.theme;
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('theme', next);
  paintThemeBtn();
});

// Build tag
api.get('/api/meta').then(m => {
  document.getElementById('build-tag').textContent = m.build;
});

// Mount initial tab — prefer hash, else last persisted, else default
const initialTab =
  (location.hash || '').replace('#', '') ||
  localStorage.getItem('activeTab') ||
  'generate';
activate(['generate', 'history', 'settings'].includes(initialTab) ? initialTab : 'generate');
