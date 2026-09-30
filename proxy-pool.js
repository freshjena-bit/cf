// proxy-pool.js — proxy loader, health-checker, rotator, agent builder
// Author: VANTA

'use strict';

const https = require('https');
const net = require('net');
const fs = require('fs');
const { URL } = require('url');

// ============================================================
// PARSE
// ============================================================
// Format yang didukung:
//   host:port                      → http, no auth
//   host:port:user:pass            → http, auth (v-proxies style)
//   scheme://host:port             → http/socks5, no auth
//   scheme://user:pass@host:port   → http/socks5, auth

function parseProxyLine(line) {
  line = line.trim();
  if (!line || line.startsWith('#')) return null;

  // host:port:user:pass
  if (!line.includes('://')) {
    const p = line.split(':');
    if (p.length === 4 && /^\d+$/.test(p[1])) {
      return {
        raw: line, protocol: 'http',
        host: p[0], port: parseInt(p[1]),
        username: p[2], password: p[3],
        sessionKey: `${p[0]}:${p[1]}:${p[2]}`,
        ok: true, fails: 0, latencyMs: null,
      };
    }
    if (p.length === 2 && /^\d+$/.test(p[1])) {
      return {
        raw: line, protocol: 'http',
        host: p[0], port: parseInt(p[1]),
        username: null, password: null,
        sessionKey: `${p[0]}:${p[1]}`,
        ok: true, fails: 0, latencyMs: null,
      };
    }
  }

  let urlStr = line;
  if (!/^[a-z0-9]+:\/\//i.test(line)) urlStr = 'http://' + line;
  try {
    const u = new URL(urlStr);
    return {
      raw: line, protocol: u.protocol.replace(':', ''),
      host: u.hostname,
      port: parseInt(u.port) || (u.protocol === 'socks5:' ? 1080 : 8080),
      username: u.username ? decodeURIComponent(u.username) : null,
      password: u.password ? decodeURIComponent(u.password) : null,
      sessionKey: `${u.hostname}:${u.port}:${u.username || ''}`,
      ok: true, fails: 0, latencyMs: null,
    };
  } catch { return null; }
}

function loadProxyFile(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const out = [];
  const seen = new Set();
  for (const line of raw.split(/\r?\n/)) {
    const p = parseProxyLine(line);
    if (!p) continue;
    if (seen.has(p.sessionKey)) continue;
    seen.add(p.sessionKey);
    out.push(p);
  }
  return out;
}

// ============================================================
// AGENT BUILDER
// ============================================================
// HTTP/HTTPS proxy → https-proxy-agent
// SOCKS4/5        → socks-proxy-agent
// Fallback        → raw CONNECT tunnel (kalau agent gak keinstall)

function buildAgent(proxy) {
  if (!proxy) return new https.Agent({ keepAlive: true, rejectUnauthorized: false });

  const auth = proxy.username
    ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password || '')}@`
    : '';
  const url = `${proxy.protocol}://${auth}${proxy.host}:${proxy.port}`;

  if (proxy.protocol.startsWith('socks')) {
    const { SocksProxyAgent } = require('socks-proxy-agent');
    return new SocksProxyAgent(url);
  }

  try {
    const { HttpsProxyAgent } = require('https-proxy-agent');
    return new HttpsProxyAgent(url, { keepAlive: true, rejectUnauthorized: false });
  } catch {
    return buildRawConnectAgent(proxy);
  }
}

function buildRawConnectAgent(proxy) {
  const authHeader = proxy.username
    ? `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password || ''}`).toString('base64')}\r\n`
    : '';

  class RawConnectAgent extends https.Agent {
    createConnection(opts, cb) {
      const target = `${opts.host}:${opts.port}`;
      const sock = net.connect(proxy.port, proxy.host, () => {
        sock.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${authHeader}\r\n`);
      });
      let buf = '';
      const onData = (c) => {
        buf += c.toString();
        if (buf.includes('\r\n\r\n')) {
          sock.removeListener('data', onData);
          if (/^HTTP\/1\.[01] 200/.test(buf)) {
            const tls = require('tls');
            const t = tls.connect({ socket: sock, servername: opts.servername || opts.host }, () => cb(null, t));
            t.on('error', cb);
          } else {
            sock.destroy();
            cb(new Error('CONNECT rejected'));
          }
        }
      };
      sock.on('data', onData);
      sock.on('error', cb);
    }
  }
  return new RawConnectAgent({ keepAlive: true, rejectUnauthorized: false });
}

// ============================================================
// HEALTH CHECK
// ============================================================

function checkProxy(proxy, timeout = 10000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let agent;
    try { agent = buildAgent(proxy); } catch { return resolve(false); }
    const req = https.get({
      host: 'api.ipify.org', path: '/?format=json',
      agent, timeout, rejectUnauthorized: false,
    }, (res) => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => {
        proxy.latencyMs = Date.now() - t0;
        try { proxy.exitIp = JSON.parse(b).ip; } catch { proxy.exitIp = null; }
        resolve(true);
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function healthCheckAll(proxies, concurrency = 50) {
  const q = [...proxies];
  const stats = { alive: 0, dead: 0, http: 0, socks: 0 };
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (q.length) {
      const p = q.shift();
      if (!p) break;
      const ok = await checkProxy(p);
      if (ok) {
        p.ok = true; p.fails = 0; stats.alive++;
        if (p.protocol.startsWith('socks')) stats.socks++; else stats.http++;
      } else {
        p.ok = false; p.fails++; stats.dead++;
      }
    }
  }));
  return stats;
}

// ============================================================
// POOL
// ============================================================

class ProxyPool {
  constructor(proxies) { this.proxies = proxies; this.cursor = 0; }

  alive() { return this.proxies.filter(p => p.ok); }

  next() {
    const a = this.alive();
    if (!a.length) return null;
    return a[this.cursor++ % a.length];
  }

  random() {
    const a = this.alive();
    return a.length ? a[Math.floor(Math.random() * a.length)] : null;
  }

  fastest() {
    const a = this.alive();
    if (!a.length) return null;
    return a.slice().sort((x, y) => (x.latencyMs || 1e9) - (y.latencyMs || 1e9))[0];
  }

  markFail(p) { if (!p) return; p.fails++; if (p.fails >= 3) p.ok = false; }
  markOk(p) { if (!p) return; p.fails = 0; p.ok = true; }

  stats() {
    const a = this.alive();
    return {
      total: this.proxies.length,
      alive: a.length,
      dead: this.proxies.length - a.length,
      http: a.filter(p => !p.protocol.startsWith('socks')).length,
      socks: a.filter(p => p.protocol.startsWith('socks')).length,
    };
  }
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  parseProxyLine,
  loadProxyFile,
  buildAgent,
  buildRawConnectAgent,
  checkProxy,
  healthCheckAll,
  ProxyPool,
};