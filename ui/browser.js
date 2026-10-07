'use strict';
const $ = id => document.getElementById(id);
let state;
async function command(action, value) {
  try { await window.browserControls.command(action, value); }
  catch (error) { $('error').textContent = error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''); $('error').classList.add('warning'); }
}
window.browserControls.onState(next => {
  state = next;
  $('environment').textContent = next.name;
  $('region').textContent = next.region;
  $('route').textContent = next.route;
  const active = next.tabs.find(t => t.id === next.activeId);
  if (document.activeElement !== $('address')) $('address').value = active?.url?.startsWith('peregrine://home/') ? 'peregrine://home/' : active?.url === 'about:blank' ? '' : active?.url || '';
  $('back').disabled = !active?.canGoBack;
  $('forward').disabled = !active?.canGoForward;
  $('reload').textContent = active?.loading ? '×' : '↻';
  $('error').textContent = next.error || `${next.locale} · ${next.timezone} · 定位${next.locationMode === 'block' ? '已禁用' : next.locationMode === 'allow' ? '已允许' : '需询问'}`;
  $('error').classList.toggle('warning', Boolean(next.error));
  $('tab-list').replaceChildren(...next.tabs.map(tab => {
    const element = document.createElement('div'); element.className = `tab${tab.id === next.activeId ? ' active' : ''}`;
    const label = document.createElement('span'); label.textContent = tab.loading ? `◌ ${tab.title || '正在加载'}` : tab.title || '新标签页';
    const close = document.createElement('button'); close.textContent = '×'; close.title = '关闭标签页'; close.onclick = event => { event.stopPropagation(); command('closeTab', tab.id); };
    element.append(label, close); element.onclick = () => command('selectTab', tab.id); return element;
  }));
});
$('address-form').onsubmit = event => { event.preventDefault(); $('address').blur(); command('navigate', $('address').value); };
$('back').onclick = () => command('back');
$('forward').onclick = () => command('forward');
$('reload').onclick = () => command(state?.tabs.find(t => t.id === state.activeId)?.loading ? 'stop' : 'reload');
$('home').onclick = () => command('home');
$('new-tab').onclick = () => command('newTab');
$('manager').onclick = () => command('manager');
$('find-text').addEventListener('input', () => command('find', $('find-text').value));
$('find-text').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); command('find', $('find-text').value); } });
$('find-next').onclick = () => command('find', $('find-text').value);
$('find-close').onclick = () => { $('find-bar').hidden = true; command('find', ''); };
document.addEventListener('keydown', event => {
  if (event.ctrlKey && event.key.toLowerCase() === 'l') { event.preventDefault(); $('address').focus(); $('address').select(); }
});
command('getState');
