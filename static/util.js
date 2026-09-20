// Tiny utilities shared by components.

export function escape(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

export function fillSelect(options, selected) {
  return options.map(o =>
    `<option value="${escape(o)}"${o === selected ? ' selected' : ''}>${escape(o)}</option>`
  ).join('');
}

export function toast(msg, type = '') {
  const host = document.getElementById('toast-container');
  if (!host) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  host.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}
