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
}

tabs.forEach(b => b.addEventListener('click', () => activate(b.dataset.tab)));

// Theme toggle
const themeBtn = document.getElementById('theme-btn');
const stored = localStorage.getItem('theme') || 'dark';
document.documentElement.dataset.theme = stored;
themeBtn.textContent = stored === 'dark' ? '🌙' : '☀️';
themeBtn.addEventListener('click', () => {
  const cur = document.documentElement.dataset.theme;
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('theme', next);
  themeBtn.textContent = next === 'dark' ? '🌙' : '☀️';
});

// Build tag
api.get('/api/meta').then(m => {
  document.getElementById('build-tag').textContent = m.build;
});

// Mount initial tab
activate('generate');
