'use strict';

(() => {
  const $ = id => document.getElementById(id);
  const engineKey = 'peregrine.home.engine';
  const shortcutKey = 'peregrine.home.shortcuts.v1';
  const engines = {
    bing: 'https://www.bing.com/search?q=',
    google: 'https://www.google.com/search?q=',
    duckduckgo: 'https://duckduckgo.com/?q=',
    baidu: 'https://www.baidu.com/s?wd='
  };
  const defaults = [
    { id: 'bing', name: '必应', url: 'https://www.bing.com/', mark: 'B', color: 'bing' },
    { id: 'google', name: 'Google', url: 'https://www.google.com/', mark: 'G', color: 'google' },
    { id: 'github', name: 'GitHub', url: 'https://github.com/', mark: 'GH', color: 'github' },
    { id: 'youtube', name: 'YouTube', url: 'https://www.youtube.com/', mark: '▶', color: 'youtube' },
    { id: 'bilibili', name: '哔哩哔哩', url: 'https://www.bilibili.com/', mark: '哔', color: 'bilibili' },
    { id: 'wikipedia', name: '维基百科', url: 'https://zh.wikipedia.org/', mark: 'W', color: 'wikipedia' }
  ];
  let editing = false;
  let toastTimer;

  function safeUrl(value) {
    const text = String(value || '').trim();
    if (!text || text.length > 2000) throw new Error('请输入有效的网站地址。');
    let normalized = text;
    if (!/^https?:\/\//i.test(text)) {
      const localHostWithPort = /^(?:localhost|(?:\d{1,3}\.){3}\d{1,3}):\d+(?:[/?#]|$)/i.test(text);
      const domainWithPort = /^(?:[a-z\d\u0080-\uffff-]+\.)+[a-z\u0080-\uffff]{2,}:\d+(?:[/?#]|$)/i.test(text);
      if (/^[a-z][a-z\d+.-]*:/i.test(text) && !localHostWithPort && !domainWithPort) throw new Error('网站地址仅支持 HTTP 或 HTTPS。');
      normalized = (localHostWithPort || /^localhost(?:[/?#]|$)/i.test(text) ? 'http://' : 'https://') + text;
    }
    let url;
    try { url = new URL(normalized); } catch { throw new Error('网站地址格式无效，请输入完整网址或域名。'); }
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || /\s/.test(url.hostname)) throw new Error('网站地址仅支持 HTTP 或 HTTPS。');
    if (url.username || url.password) throw new Error('网站地址中不能包含登录用户名或密码。');
    return url.href;
  }

  function looksLikeUrl(text) {
    return /^https?:\/\//i.test(text) || /^[a-z][a-z\d+.-]*:/i.test(text) || /^(?:localhost|(?:\d{1,3}\.){3}\d{1,3})(?::\d+)?(?:[/?#]|$)/i.test(text) || /^(?:[a-z\d\u0080-\uffff-]+\.)+[a-z\u0080-\uffff]{2,}(?::\d+)?(?:[/?#]|$)/i.test(text);
  }

  function navigate(value) {
    window.location.href = safeUrl(value);
  }

  function readStorage(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  }

  function writeStorage(key, value) {
    try { localStorage.setItem(key, value); return true; }
    catch { showToast('当前页面无法保存偏好，本次设置仍可使用。'); return false; }
  }

  function showToast(text) {
    clearTimeout(toastTimer);
    $('home-toast').textContent = text;
    $('home-toast').hidden = false;
    toastTimer = setTimeout(() => { $('home-toast').hidden = true; }, 3200);
  }

  function readShortcuts() {
    const stored = readStorage(shortcutKey);
    if (!stored) return defaults.map(item => ({ ...item }));
    try {
      const parsed = JSON.parse(stored);
      if (!Array.isArray(parsed)) throw new Error();
      return parsed.slice(0, 24).flatMap((item, index) => {
        if (!item || typeof item.name !== 'string' || !item.name.trim()) return [];
        try {
          const original = defaults.find(entry => entry.id === item.id);
          return [{ id: String(item.id || 'saved-' + index).slice(0, 80), name: item.name.trim().slice(0, 32), url: safeUrl(item.url), mark: original?.mark || Array.from(item.name.trim())[0].toUpperCase(), color: original?.color || 'custom' }];
        } catch { return []; }
      });
    } catch { return defaults.map(item => ({ ...item })); }
  }

  let shortcuts = readShortcuts();

  function createIcon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('icon');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#' + name + '-icon');
    svg.append(use);
    return svg;
  }

  function renderShortcuts() {
    const fragment = document.createDocumentFragment();
    shortcuts.forEach((site, index) => {
      const card = document.createElement('article');
      card.className = 'shortcut-card';
      const link = document.createElement('a');
      link.className = 'shortcut-link';
      link.href = safeUrl(site.url);
      link.title = site.name + ' · ' + site.url;
      link.addEventListener('click', event => { event.preventDefault(); navigate(site.url); });
      const mark = document.createElement('span');
      mark.className = 'shortcut-monogram ' + site.color;
      mark.textContent = site.mark;
      mark.setAttribute('aria-hidden', 'true');
      const name = document.createElement('span');
      name.className = 'shortcut-name';
      name.textContent = site.name;
      const host = document.createElement('span');
      host.className = 'shortcut-host';
      host.textContent = new URL(site.url).hostname.replace(/^www\./, '');
      link.append(mark, name, host);
      card.append(link);
      if (editing) {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'remove-shortcut';
        remove.setAttribute('aria-label', '移除 ' + site.name);
        remove.title = '移除 ' + site.name;
        remove.append(createIcon('close'));
        remove.addEventListener('click', () => {
          shortcuts.splice(index, 1);
          writeStorage(shortcutKey, JSON.stringify(shortcuts));
          renderShortcuts();
        });
        card.append(remove);
      }
      fragment.append(card);
    });
    $('shortcut-grid').replaceChildren(fragment);
    $('shortcut-empty').hidden = shortcuts.length > 0;
    $('add-shortcut').disabled = shortcuts.length >= 24;
    $('edit-shortcuts').querySelector('span').textContent = editing ? '完成' : '整理';
    $('edit-shortcuts').setAttribute('aria-pressed', String(editing));
  }

  function openShortcutDialog() {
    $('shortcut-form').reset();
    $('shortcut-error').hidden = true;
    $('shortcut-dialog').showModal();
    $('shortcut-name').focus();
  }

  $('search-form').addEventListener('submit', event => {
    event.preventDefault();
    const text = $('search-input').value.trim();
    $('search-error').hidden = true;
    if (!text) { $('search-input').focus(); return; }
    try { navigate(looksLikeUrl(text) ? text : (engines[$('search-engine').value] || engines.bing) + encodeURIComponent(text)); }
    catch (error) { $('search-error').textContent = error.message; $('search-error').hidden = false; }
  });
  const savedEngine = readStorage(engineKey);
  if (Object.hasOwn(engines, savedEngine)) $('search-engine').value = savedEngine;
  $('search-engine').addEventListener('change', () => { writeStorage(engineKey, $('search-engine').value); $('search-input').focus(); });
  $('search-input').addEventListener('input', () => { $('search-error').hidden = true; });
  $('add-shortcut').addEventListener('click', openShortcutDialog);
  $('edit-shortcuts').addEventListener('click', () => { editing = !editing; renderShortcuts(); });
  $('restore-shortcuts').addEventListener('click', () => {
    shortcuts = defaults.map(item => ({ ...item }));
    writeStorage(shortcutKey, JSON.stringify(shortcuts));
    renderShortcuts();
  });
  ['close-shortcut-dialog', 'cancel-shortcut'].forEach(id => $(id).addEventListener('click', () => $('shortcut-dialog').close()));
  $('shortcut-form').addEventListener('submit', event => {
    event.preventDefault();
    if (!$('shortcut-form').reportValidity()) return;
    $('shortcut-error').hidden = true;
    try {
      if (shortcuts.length >= 24) throw new Error('最多可以添加 24 个常用网站。');
      const name = $('shortcut-name').value.trim();
      if (!name) throw new Error('请填写网站名称。');
      const url = safeUrl($('shortcut-url').value);
      if (shortcuts.some(site => site.url === url)) throw new Error('这个网站已经在你的常用网站中。');
      shortcuts.push({ id: 'custom-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8), name, url, mark: Array.from(name)[0].toUpperCase(), color: 'custom' });
      writeStorage(shortcutKey, JSON.stringify(shortcuts));
      renderShortcuts();
      $('shortcut-dialog').close();
    } catch (error) { $('shortcut-error').textContent = error.message; $('shortcut-error').hidden = false; }
  });

  let metadata = {};
  try {
    const content = document.querySelector('meta[name="peregrine-environment"]')?.content;
    if (content) {
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) metadata = parsed;
    }
  } catch { /* Metadata is optional. */ }
  const query = new URLSearchParams(window.location.search);
  ['name', 'region', 'timezone'].forEach(key => { if (query.has(key)) metadata[key] = query.get(key); });
  const name = typeof metadata.name === 'string' ? metadata.name.slice(0, 80) : '';
  const region = typeof metadata.region === 'string' ? metadata.region.slice(0, 80) : '';
  let timezone;
  if (typeof metadata.timezone === 'string' && metadata.timezone.length <= 100) {
    try { new Intl.DateTimeFormat('zh-CN', { timeZone: metadata.timezone }); timezone = metadata.timezone; } catch { /* Use this environment's own timezone. */ }
  }
  $('environment-name').textContent = name;
  $('environment-region').textContent = region;
  $('environment-info').hidden = !name && !region;
  $('environment-divider').hidden = !name || !region;
  $('timezone-label').textContent = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  function updateClock() {
    const now = new Date();
    const options = timezone ? { timeZone: timezone } : {};
    $('home-clock').textContent = new Intl.DateTimeFormat('zh-CN', { ...options, hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
    $('home-date').textContent = new Intl.DateTimeFormat('zh-CN', { ...options, month: 'long', day: 'numeric', weekday: 'long' }).format(now);
    $('home-clock').dateTime = now.toISOString();
    $('home-date').dateTime = now.toISOString();
  }
  updateClock();
  setInterval(updateClock, 30000);
  renderShortcuts();
})();
