'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { regions, HOME_URL } = require('./regions');

const ASSETS = new Map([
  ['/', ['home.html', 'text/html; charset=utf-8']],
  ['/home.css', ['home.css', 'text/css; charset=utf-8']],
  ['/home.js', ['home.js', 'text/javascript; charset=utf-8']],
  ['/assets/peregrine-icon.png', ['assets/peregrine-icon.png', 'image/png']]
]);

async function installHomeProtocol(ses) {
  if (await ses.protocol.isProtocolHandled('peregrine')) return;
  ses.protocol.handle('peregrine', request => {
    let url;
    try { url = new URL(request.url); } catch { return new Response('Bad request', { status: 400 }); }
    const asset = url.protocol === 'peregrine:' && url.hostname === 'home' && !url.username && !url.password && !url.port && ASSETS.get(url.pathname);
    if (!asset) return new Response('Not found', { status: 404 });
    return new Response(fs.readFileSync(path.join(__dirname, '../ui', asset[0])), {
      headers: { 'Content-Type': asset[1], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
    });
  });
}

function profileHomeUrl(profile) {
  const region = regions.find(r => r.id === profile.regionId);
  const url = new URL(HOME_URL);
  url.searchParams.set('name', profile.name);
  url.searchParams.set('region', region ? `${region.country} · ${region.city}` : '自定地区');
  url.searchParams.set('timezone', profile.timezone);
  return url.href;
}

function isHomeNavigation(value) {
  try { const url = new URL(value); return url.protocol === 'peregrine:' && url.host === 'home' && url.pathname === '/' && !url.username && !url.password; } catch { return false; }
}

module.exports = { installHomeProtocol, profileHomeUrl, isHomeNavigation };
