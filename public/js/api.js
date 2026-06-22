// js/api.js — دوال مشتركة بين كل الصفحات

function getToken() {
  return localStorage.getItem('waslni_token');
}
function setToken(t) {
  localStorage.setItem('waslni_token', t);
}
function clearToken() {
  localStorage.removeItem('waslni_token');
  localStorage.removeItem('waslni_name');
}

async function api(path, options = {}) {
  const headers = options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers['Authorization'] = 'Bearer ' + token;

  const res = await fetch('/api' + path, {
    method: options.method || 'GET',
    headers,
    body: options.body
      ? options.body instanceof FormData
        ? options.body
        : JSON.stringify(options.body)
      : undefined
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'حدث خطأ غير متوقع');
  return data;
}

let toastTimer;
function toast(msg) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

function requireLogin(role) {
  const token = getToken();
  const savedRole = localStorage.getItem('waslni_role');
  if (!token || savedRole !== role) {
    window.location.href = 'index.html';
  }
}
