'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const api = window.hangjing;
  let state = null;
  let toastTimer = null;
  let confirmHandler = null;
  const busyProfiles = new Set();
  const busySubscriptions = new Set();
  const countryNames = typeof Intl.DisplayNames === 'function' ? new Intl.DisplayNames(['zh-CN'], { type: 'region' }) : null;

  function el(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = String(text);
    return element;
  }

  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('icon');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#i-' + name);
    svg.append(use);
    return svg;
  }

  function actionButton(label, iconName, className, handler, disabled = false) {
    const button = el('button', className);
    button.type = 'button';
    button.append(icon(iconName));
    if (!className.includes('icon-button')) button.append(el('span', '', label));
    button.setAttribute('aria-label', label);
    button.title = label;
    button.disabled = disabled;
    button.addEventListener('click', handler);
    return button;
  }

  function errorMessage(error) {
    const raw = error && error.message ? error.message : String(error || '操作未完成，请稍后重试。');
    return raw.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '');
  }

  function showError(error) {
    $('global-error-text').textContent = errorMessage(error);
    $('global-error').hidden = false;
  }

  function toast(message) {
    clearTimeout(toastTimer);
    $('toast-text').textContent = message;
    $('toast').hidden = false;
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3500);
  }

  function showPage(page) {
    const titles = { profiles: '环境管理', subscriptions: '节点订阅', guide: '使用说明' };
    if (!Object.hasOwn(titles, page)) return;
    document.querySelectorAll('.page').forEach(section => {
      const selected = section.id === 'page-' + page;
      section.hidden = !selected;
      section.classList.toggle('active', selected);
    });
    document.querySelectorAll('.nav-item').forEach(button => {
      const selected = button.dataset.page === page;
      button.classList.toggle('active', selected);
      if (selected) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    $('page-breadcrumb').textContent = titles[page];
    window.scrollTo({ top: 0 });
  }

  function getRegion(profile) {
    return state.regions.find(region => region.id === profile.regionId);
  }

  function countryName(code) {
    if (!code) return '未识别';
    const normalized = String(code).toUpperCase();
    try { return countryNames ? countryNames.of(normalized) : normalized; }
    catch { return normalized; }
  }

  function regionName(region) {
    return region ? [region.country, region.city].filter(Boolean).join(' · ') : '自定义地区';
  }

  function formatDate(value) {
    if (!value) return '尚未更新';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '尚未更新';
    return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
  }

  function preserveOptions(select, options, defaultLabel) {
    const current = select.value;
    select.replaceChildren(new Option(defaultLabel, ''), ...options.map(option => new Option(option.label, option.value)));
    if (Array.from(select.options).some(option => option.value === current)) select.value = current;
  }

  function updateState(nextState) {
    if (!nextState || !Array.isArray(nextState.profiles) || !Array.isArray(nextState.regions) || !Array.isArray(nextState.nodes) || !Array.isArray(nextState.subscriptions)) {
      throw new Error('工作空间返回了无法读取的数据。请重新启动应用。');
    }
    state = nextState;
    const runningCount = state.profiles.filter(profile => profile.running).length;
    const regionCount = new Set(state.profiles.map(profile => getRegion(profile)?.countryCode || profile.regionId).filter(Boolean)).size;
    $('stat-profiles').textContent = state.profiles.length;
    $('stat-running').textContent = runningCount;
    $('stat-nodes').textContent = state.nodes.length;
    $('stat-regions').textContent = regionCount;
    $('nav-profile-count').textContent = state.profiles.length;
    $('nav-node-count').textContent = state.nodes.length;
    $('profile-count').textContent = state.profiles.length;
    $('subscription-count').textContent = state.subscriptions.length;
    $('node-count').textContent = state.nodes.length;
    $('app-version').textContent = state.version ? 'v' + state.version : '本地版';
    $('data-path').textContent = state.dataPath || '应用数据目录';
    $('open-data').title = state.dataPath || '打开应用数据目录';
    const available = Boolean(state.kernel && state.kernel.available);
    $('kernel-dot').className = 'status-dot ' + (available ? 'available' : 'unavailable');
    $('kernel-label').textContent = available ? '代理内核已就绪' : '代理内核未就绪';
    $('kernel-detail').textContent = state.kernel.nativeAvailable ? `指纹内核 ${state.kernel.nativeChromium}` : '独立指纹内核未安装';
    $('browser-version-detail').textContent = `管理界面 Electron ${state.kernel.electron}；普通模式 Chromium ${state.kernel.chromium}；独立指纹模式 Chromium ${state.kernel.nativeChromium}。网页渲染引擎均为 Blink。指纹内核为第三方构建，150 补丁源码由上游延迟公开，尚未完成独立安全审计。`;
    $('hero-create').querySelector('svg').nextSibling.textContent = state.profiles.length ? '创建一个新环境' : '创建第一个环境';
    const countries = new Map();
    state.profiles.forEach(profile => {
      const region = getRegion(profile);
      if (region?.countryCode) countries.set(region.countryCode, region.country || countryName(region.countryCode));
    });
    preserveOptions($('country-filter'), [...countries].sort((a, b) => a[1].localeCompare(b[1], 'zh-CN')).map(([value, label]) => ({ value, label })), '全部国家与地区');
    preserveOptions($('node-subscription-filter'), state.subscriptions.map(subscription => ({ value: subscription.id, label: subscription.name })), '全部订阅');
    $('loading-state').hidden = true;
    renderProfiles();
    renderSubscriptions();
    renderNodes();
  }

  function renderProfiles() {
    if (!state) return;
    const search = $('profile-search').value.trim().toLocaleLowerCase();
    const country = $('country-filter').value;
    const status = $('status-filter').value;
    const filtered = state.profiles.filter(profile => {
      const region = getRegion(profile);
      const matchesSearch = [profile.name, profile.notes, region?.country, region?.city, profile.locale, profile.timezone].filter(Boolean).join(' ').toLocaleLowerCase().includes(search);
      return matchesSearch && (!country || region?.countryCode === country) && (!status || (status === 'running' ? profile.running : !profile.running));
    });
    const fragment = document.createDocumentFragment();
    filtered.forEach(profile => fragment.append(profileCard(profile)));
    $('profile-list').replaceChildren(fragment);
    $('profile-empty').hidden = state.profiles.length > 0;
    $('profile-no-results').hidden = state.profiles.length === 0 || filtered.length > 0;
  }

  function profileRow(iconName, label, value, className = '') {
    const row = el('div', 'profile-data-row');
    const text = el('span', 'profile-data-value ' + className);
    if (className.includes('proxy-value')) text.append(el('span', 'proxy-dot'));
    text.append(document.createTextNode(value));
    text.title = value;
    row.append(icon(iconName), el('span', 'profile-data-label', label), text);
    return row;
  }

  function profileCard(profile) {
    const region = getRegion(profile);
    const node = state.nodes.find(candidate => candidate.id === profile.nodeId);
    const busy = busyProfiles.has(profile.id);
    const card = el('article', 'profile-card' + (profile.running ? ' running' : ''));
    const header = el('div', 'profile-card-header');
    const title = el('div', 'profile-title');
    const titleText = el('h3', '', profile.name || '未命名环境');
    titleText.title = profile.name || '未命名环境';
    const regionText = el('div', 'profile-region', regionName(region));
    regionText.title = regionName(region);
    title.append(titleText, regionText);
    const status = el('span', 'profile-state' + (profile.running ? ' is-running' : ''));
    status.append(el('span'), document.createTextNode(profile.running ? '运行中' : '未启动'));
    header.append(el('div', 'country-avatar', region?.countryCode || '自定'), title, status);
    const data = el('div', 'profile-data');
    const proxyName = profile.nodeId ? (node?.name || '节点已移除 · 请重新选择') : '直连 · 本机出口';
    data.append(
      profileRow('link', '代理', proxyName, 'proxy-value' + (!profile.nodeId ? ' direct' : (!node ? ' missing' : ''))),
      profileRow('clock', '时区', profile.timezone || '未设置'),
      profileRow('language', '语言', profile.locale || '未设置')
    );
    data.append(profileRow('shield', '内核', profile.engine === 'fingerprint' ? '独立指纹 · Chromium 150' : '普通 · Chromium 152'));
    const note = el('p', 'profile-note', profile.notes || '独立 Cookie 与网站存储');
    note.title = profile.notes || '独立 Cookie 与网站存储';
    const actions = el('div', 'profile-actions');
    const tools = el('div');
    tools.append(
      actionButton('编辑 ' + profile.name, 'edit', 'icon-button', () => openProfile(profile), busy || profile.running),
      actionButton('复制 ' + profile.name, 'copy', 'icon-button', () => profileAction(profile.id, 'duplicateProfile', '已复制环境设置'), busy),
      actionButton('删除 ' + profile.name, 'trash', 'icon-button delete', () => confirmDeleteProfile(profile), busy || profile.running)
    );
    if (profile.running) tools.firstChild.title = '请先停止环境，再编辑设置';
    if (profile.running) tools.lastChild.title = '请先停止环境，再删除';
    const launch = actionButton(busy ? '处理中…' : (profile.running ? '停止' : '启动'), profile.running ? 'stop' : 'play', 'button profile-start' + (profile.running ? ' stop' : ''), () => profileAction(profile.id, profile.running ? 'stopProfile' : 'launchProfile', profile.running ? '环境已停止' : '浏览环境已启动'), busy);
    actions.append(tools, launch);
    card.append(header, data, note, actions);
    return card;
  }

  async function profileAction(id, method, message) {
    if (busyProfiles.has(id)) return;
    busyProfiles.add(id);
    renderProfiles();
    try {
      updateState(await api[method](id));
      toast(message);
    } catch (error) { showError(error); }
    finally { busyProfiles.delete(id); renderProfiles(); }
  }

  function renderSubscriptions() {
    if (!state) return;
    const fragment = document.createDocumentFragment();
    state.subscriptions.forEach(subscription => {
      const busy = busySubscriptions.has(subscription.id);
      const card = el('article', 'subscription-card');
      const badge = el('div', 'subscription-icon');
      badge.append(icon('link'));
      const info = el('div', 'subscription-info');
      info.append(el('h3', '', subscription.name || '未命名订阅'), el('p', '', subscription.host || '本地配置文件'));
      const meta = el('div', 'subscription-meta');
      const count = el('div', 'subscription-nodes');
      count.append(el('strong', '', subscription.nodeCount ?? state.nodes.filter(node => node.subscriptionId === subscription.id).length), document.createTextNode('配置节点'));
      const updated = el('div', 'subscription-update');
      updated.append(document.createTextNode('上次更新'), el('div', '', formatDate(subscription.updatedAt)));
      meta.append(count, updated);
      const actions = el('div', 'subscription-actions');
      actions.append(
        actionButton(busy ? '刷新中…' : '刷新', 'refresh', 'button secondary', () => refreshSubscription(subscription.id), busy),
        actionButton('删除 ' + subscription.name, 'trash', 'icon-button delete', () => confirmDeleteSubscription(subscription), busy)
      );
      card.append(badge, info, meta, actions);
      fragment.append(card);
    });
    $('subscription-list').replaceChildren(fragment);
    $('subscription-empty').hidden = state.subscriptions.length > 0;
  }

  function renderNodes() {
    if (!state) return;
    const search = $('node-search').value.trim().toLocaleLowerCase();
    const subscriptionId = $('node-subscription-filter').value;
    const nodes = state.nodes.filter(node => (!subscriptionId || node.subscriptionId === subscriptionId) && [node.name, node.type, node.countryCode, countryName(node.countryCode)].join(' ').toLocaleLowerCase().includes(search));
    const fragment = document.createDocumentFragment();
    nodes.forEach(node => {
      const row = el('tr');
      const name = el('td', '', node.name);
      name.title = node.name;
      const protocol = el('td');
      protocol.append(el('span', 'protocol-tag', node.type || '未知'));
      const region = el('td', '', countryName(node.countryCode));
      region.title = node.countryCode ? '根据节点名称推测，未经出口 IP 验证' : '无法从节点名称识别地区';
      const subscription = el('td', '', state.subscriptions.find(item => item.id === node.subscriptionId)?.name || '—');
      subscription.title = subscription.textContent;
      row.append(name, protocol, region, subscription);
      fragment.append(row);
    });
    $('node-list').replaceChildren(fragment);
    $('node-empty').hidden = nodes.length > 0;
    $('node-empty').textContent = state.nodes.length ? '没有找到匹配的节点，试试其他关键词或订阅。' : '导入订阅后，节点配置会显示在这里。';
  }

  async function refreshSubscription(id) {
    if (busySubscriptions.has(id)) return;
    busySubscriptions.add(id);
    renderSubscriptions();
    try { updateState(await api.refreshSubscription(id)); toast('订阅已刷新'); }
    catch (error) { showError(error); }
    finally { busySubscriptions.delete(id); renderSubscriptions(); }
  }

  function applyRegionPreset() {
    const region = state.regions.find(item => item.id === $('profile-region').value);
    if (!region) return;
    $('profile-locale').value = region.locale || 'zh-CN';
    $('profile-timezone').value = region.timezone || 'Asia/Taipei';
    $('profile-latitude').value = region.latitude ?? 0;
    $('profile-longitude').value = region.longitude ?? 0;
  }

  function openProfile(profile = null) {
    if (!state) { showError('工作空间尚未连接，暂时无法创建环境。'); return; }
    if (profile?.running) { showError('请先停止环境，再编辑设置。'); return; }
    $('profile-form').reset();
    $('profile-form-error').hidden = true;
    $('profile-dialog-title').textContent = profile ? '编辑浏览环境' : '新建浏览环境';
    $('profile-id').value = profile?.id || '';
    $('profile-region').replaceChildren(...state.regions.map(region => new Option(regionName(region), region.id)));
    if (!state.regions.length) { showError('没有可用的地区预设。请检查应用安装。'); return; }
    const preferred = state.regions.find(region => region.countryCode === 'TW') || state.regions[0];
    $('profile-region').value = profile?.regionId || preferred.id;
    if (!$('profile-region').value) $('profile-region').value = preferred.id;
    const nodes = state.nodes.map(node => new Option(node.name + (node.countryCode ? ' · ' + countryName(node.countryCode) + '（推测）' : ''), node.id));
    $('profile-node').replaceChildren(new Option('直连 · 使用本机网络出口', ''), ...nodes);
    if (profile?.nodeId && !state.nodes.some(node => node.id === profile.nodeId)) {
      const missing = new Option('原节点已移除 · 请选择其他节点', profile.nodeId);
      missing.disabled = true;
      $('profile-node').append(missing);
    }
    $('profile-node').value = profile?.nodeId || '';
    $('profile-name').value = profile?.name || '';
    $('profile-user-agent').value = profile?.userAgent || '';
    $('profile-width').value = profile?.width || 1280;
    $('profile-height').value = profile?.height || 800;
    $('profile-homepage').value = profile?.homepage || 'peregrine://home/';
    $('profile-engine').value = profile ? profile.engine || 'electron' : 'fingerprint';
    $('profile-seed').value = profile?.fingerprintSeed ?? '';
    $('profile-cores').value = profile?.hardwareConcurrency || 8;
    $('profile-canvas').value = profile?.canvasMode || 'stable';
    $('profile-memory').value = profile?.memoryGiB || 8;
    $('profile-pixel-ratio').value = profile?.pixelRatio || 1;
    $('profile-screen-width').value = profile?.screenWidth || '';
    $('profile-screen-height').value = profile?.screenHeight || '';
    $('profile-search-engine').value = profile?.searchEngine || 'bing';
    const security = profile?.security || {};
    $('profile-webrtc').value = security.webrtc || 'proxy';
    $('profile-third-party').value = security.blockThirdPartyCookies === false ? 'allow' : 'block';
    $('profile-https').value = security.httpsOnly === false ? 'allow' : 'only';
    ['camera', 'microphone', 'notifications'].forEach(key => { $('profile-' + key).value = security[key] || 'block'; });
    updateEngineFields();
    $('profile-location-mode').value = profile?.locationMode || 'ask';
    $('profile-notes').value = profile?.notes || '';
    applyRegionPreset();
    if (profile) {
      $('profile-locale').value = profile.locale || $('profile-locale').value;
      $('profile-timezone').value = profile.timezone || $('profile-timezone').value;
      $('profile-latitude').value = profile.latitude ?? $('profile-latitude').value;
      $('profile-longitude').value = profile.longitude ?? $('profile-longitude').value;
    }
    $('profile-dialog').showModal();
    $('profile-name').focus();
  }

  function setFormBusy(form, busy) {
    Array.from(form.elements).forEach(element => { element.disabled = busy; });
    form.dataset.busy = String(busy);
  }

  async function saveProfile(event) {
    event.preventDefault();
    const form = $('profile-form');
    if (!form.reportValidity() || form.dataset.busy === 'true') return;
    const input = {
      id: $('profile-id').value || undefined,
      name: $('profile-name').value.trim(),
      userAgent: $('profile-user-agent').value.trim(),
      engine: $('profile-engine').value,
      fingerprintSeed: $('profile-seed').value || undefined,
      hardwareConcurrency: Number($('profile-cores').value),
      canvasMode: $('profile-canvas').value,
      memoryGiB: Number($('profile-memory').value),
      pixelRatio: Number($('profile-pixel-ratio').value),
      screenWidth: $('profile-screen-width').value ? Number($('profile-screen-width').value) : undefined,
      screenHeight: $('profile-screen-height').value ? Number($('profile-screen-height').value) : undefined,
      searchEngine: $('profile-search-engine').value,
      security: { webrtc: $('profile-webrtc').value, blockThirdPartyCookies: $('profile-third-party').value === 'block', httpsOnly: $('profile-https').value === 'only', camera: $('profile-camera').value, microphone: $('profile-microphone').value, notifications: $('profile-notifications').value },
      regionId: $('profile-region').value,
      locale: $('profile-locale').value.trim(),
      timezone: $('profile-timezone').value.trim(),
      latitude: Number($('profile-latitude').value),
      longitude: Number($('profile-longitude').value),
      locationMode: $('profile-location-mode').value,
      nodeId: $('profile-node').value,
      width: Number($('profile-width').value),
      height: Number($('profile-height').value),
      homepage: $('profile-homepage').value.trim(),
      notes: $('profile-notes').value.trim()
    };
    $('profile-form-error').hidden = true;
    try {
      if (!input.name) throw new Error('请填写环境名称。');
      if (!input.locale) throw new Error('请填写浏览器语言，例如 ja-JP。');
      try { new Intl.Locale(input.locale); } catch { throw new Error('浏览器语言格式无效，例如 zh-CN、en-US 或 ja-JP。'); }
      try { new Intl.DateTimeFormat('zh-CN', { timeZone: input.timezone }); } catch { throw new Error('时区无效，请使用 Asia/Tokyo 等 IANA 时区名称。'); }
      if (!['about:blank', 'peregrine://home/'].includes(input.homepage)) {
        let url;
        try { url = new URL(input.homepage); } catch { throw new Error('启动页面请输入完整网页地址、peregrine://home/ 或 about:blank。'); }
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error('启动页面仅支持 HTTP、HTTPS、peregrine://home/ 或 about:blank。');
      }
      if (input.nodeId && !state.nodes.some(node => node.id === input.nodeId)) throw new Error('原节点已移除，请重新选择代理节点。');
      setFormBusy(form, true);
      $('save-profile').querySelector('svg').nextSibling.textContent = '保存中…';
      updateState(await api.saveProfile(input));
      $('profile-dialog').close();
      toast(input.id ? '环境设置已更新' : '浏览环境已创建');
    } catch (error) {
      $('profile-form-error').textContent = errorMessage(error);
      $('profile-form-error').hidden = false;
    } finally {
      setFormBusy(form, false);
      $('save-profile').querySelector('svg').nextSibling.textContent = '保存环境';
    }
  }

  function openSubscription() {
    if (!state) { showError('工作空间尚未连接，暂时无法导入订阅。'); return; }
    $('subscription-form').reset();
    $('subscription-form-error').hidden = true;
    $('subscription-dialog').showModal();
    $('subscription-name').focus();
  }

  async function importSubscription(event) {
    event.preventDefault();
    const form = $('subscription-form');
    if (!form.reportValidity() || form.dataset.busy === 'true') return;
    const input = { name: $('subscription-name').value.trim(), url: $('subscription-url').value.trim() };
    $('subscription-form-error').hidden = true;
    try {
      if (!input.name) throw new Error('请填写订阅名称。');
      let url;
      try { url = new URL(input.url); } catch { throw new Error('请输入有效的 HTTP / HTTPS 订阅链接。'); }
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('订阅链接仅支持 HTTP 或 HTTPS。');
      setFormBusy(form, true);
      $('save-subscription').querySelector('svg').nextSibling.textContent = '正在导入…';
      updateState(await api.importSubscription(input));
      $('subscription-dialog').close();
      showPage('subscriptions');
      toast('订阅已导入，可在环境设置中选择节点');
    } catch (error) {
      $('subscription-form-error').textContent = errorMessage(error);
      $('subscription-form-error').hidden = false;
    } finally {
      setFormBusy(form, false);
      $('save-subscription').querySelector('svg').nextSibling.textContent = '导入订阅';
    }
  }

  function confirmAction(title, description, handler) {
    $('confirm-title').textContent = title;
    $('confirm-description').textContent = description;
    $('confirm-error').hidden = true;
    confirmHandler = handler;
    $('confirm-dialog').showModal();
  }

  function confirmDeleteProfile(profile) {
    confirmAction('删除这个浏览环境？', '将删除「' + profile.name + '」的环境设置和浏览数据。这个操作无法撤销。', async () => {
      updateState(await api.deleteProfile(profile.id));
      toast('浏览环境已删除');
    });
  }

  function confirmDeleteSubscription(subscription) {
    const nodeIds = new Set(state.nodes.filter(node => node.subscriptionId === subscription.id).map(node => node.id));
    const affectedCount = state.profiles.filter(profile => nodeIds.has(profile.nodeId)).length;
    if (affectedCount) { showError('有 ' + affectedCount + ' 个环境正在使用此订阅，请先在环境设置中更换节点，再删除订阅。'); return; }
    confirmAction('删除这个节点订阅？', '将移除「' + subscription.name + '」和它的所有节点。' + (affectedCount ? '有 ' + affectedCount + ' 个环境正在使用该订阅中的节点，删除后需要重新选择节点。' : '你的浏览环境与浏览数据会保留。'), async () => {
      updateState(await api.deleteSubscription(subscription.id));
      toast('订阅已删除');
    });
  }

  async function executeConfirmation() {
    if (!confirmHandler || $('confirm-action').disabled) return;
    const dialog = $('confirm-dialog');
    dialog.dataset.busy = 'true';
    dialog.querySelectorAll('button').forEach(button => { button.disabled = true; });
    $('confirm-action').textContent = '正在删除…';
    try {
      await confirmHandler();
      dialog.close();
      confirmHandler = null;
    } catch (error) {
      $('confirm-error').textContent = errorMessage(error);
      $('confirm-error').hidden = false;
    } finally {
      dialog.dataset.busy = 'false';
      dialog.querySelectorAll('button').forEach(button => { button.disabled = false; });
      $('confirm-action').textContent = '确认删除';
    }
  }

  async function importFile() {
    if (!state) { showError('工作空间尚未连接。'); return; }
    $('import-file').disabled = true;
    try {
      const result = await api.importFile();
      if (result) { updateState(result); toast('配置文件已导入'); }
    } catch (error) { showError(error); }
    finally { $('import-file').disabled = false; }
  }

  async function revealData() {
    try {
      if (!api) throw new Error('桌面接口未连接，请通过游隼浏览器桌面应用打开此页面。');
      await api.revealData();
    } catch (error) { showError(error); }
  }

  document.querySelectorAll('.nav-item').forEach(button => button.addEventListener('click', () => showPage(button.dataset.page)));
  document.querySelectorAll('[data-goto]').forEach(button => button.addEventListener('click', () => showPage(button.dataset.goto)));
  ['hero-create', 'create-profile', 'empty-create', 'guide-create'].forEach(id => $(id).addEventListener('click', () => openProfile()));
  ['add-subscription', 'empty-subscription'].forEach(id => $(id).addEventListener('click', openSubscription));
  ['open-data', 'guide-open-data'].forEach(id => $(id).addEventListener('click', revealData));
  $('dismiss-error').addEventListener('click', () => { $('global-error').hidden = true; });
  $('profile-search').addEventListener('input', renderProfiles);
  $('country-filter').addEventListener('change', renderProfiles);
  $('status-filter').addEventListener('change', renderProfiles);
  $('node-search').addEventListener('input', renderNodes);
  $('node-subscription-filter').addEventListener('change', renderNodes);
  $('clear-filters').addEventListener('click', () => {
    $('profile-search').value = '';
    $('country-filter').value = '';
    $('status-filter').value = '';
    renderProfiles();
  });
  $('profile-region').addEventListener('change', applyRegionPreset);
  $('location-preset').addEventListener('click', () => {
    const region=state.regions.find(item=>item.id===$('profile-region').value);
    if(region) { $('profile-latitude').value=region.latitude; $('profile-longitude').value=region.longitude; }
  });
  function updateEngineFields() {
    const native = $('profile-engine').value === 'fingerprint';
    document.querySelectorAll('.native-option').forEach(field => { field.hidden = !native; });
    $('native-settings').hidden = !native;
    $('engine-description').textContent = native ? '音频、字体与部分矩形测量使用第三方原生补丁，Canvas / WebGL 常用像素读回使用游隼稳定策略。每个环境固定种子、隔离数据，复制环境生成新种子。' : '隔离 Cookie 与网站存储，调整 UA、语言、时区和虚拟 GPS；不包含原生指纹补丁。摄像头、麦克风和通知均禁用。';
  }
  $('profile-engine').addEventListener('change', updateEngineFields);
  $('profile-form').addEventListener('submit', saveProfile);
  $('subscription-form').addEventListener('submit', importSubscription);
  $('confirm-action').addEventListener('click', executeConfirmation);
  $('import-file').addEventListener('click', importFile);
  document.querySelectorAll('.dialog-close').forEach(button => button.addEventListener('click', () => {
    const dialog = button.closest('dialog');
    if (dialog.dataset.busy !== 'true' && dialog.querySelector('form')?.dataset.busy !== 'true') dialog.close();
  }));
  document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('cancel', event => {
    if (dialog.dataset.busy === 'true' || dialog.querySelector('form')?.dataset.busy === 'true') event.preventDefault();
  }));

  async function initialize() {
    try {
      if (!api || typeof api.getState !== 'function') throw new Error('桌面接口未连接。请通过游隼浏览器桌面应用打开此页面。');
      if (typeof api.onState === 'function') api.onState(next => {
        try { updateState(next); } catch (error) { showError(error); }
      });
      updateState(await api.getState());
    } catch (error) {
      $('loading-state').hidden = true;
      $('kernel-label').textContent = '工作空间未连接';
      $('kernel-detail').textContent = '请从桌面应用打开';
      $('kernel-dot').className = 'status-dot unavailable';
      showError(error);
    }
  }

  initialize();
})();
