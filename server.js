#!/usr/bin/env node
'use strict';
// Claude Stats — local, live dashboard for Claude Code usage.
// Reads the JSONL transcripts Claude Code writes to ~/.claude/projects.
// Nothing leaves your machine: the server only listens on 127.0.0.1.

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');

const args = process.argv.slice(2);
const PORT = Number(argValue('--port') || process.env.PORT) || 4321;
const CLAUDE_DIR = argValue('--dir') || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const ROOT = path.join(CLAUDE_DIR, 'projects');
const PUBLIC = path.join(__dirname, 'public');
const SCAN_MS = 2000;
const DEMO = args.includes('--demo');
const CHUNK = 8 * 1024 * 1024;
// Changes whenever the code on disk changes, so a newer launch can replace an older running copy.
const VERSION = [__filename, path.join(PUBLIC, 'index.html')]
  .map(f => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } }).join('-') + (DEMO ? '-demo' : '');

function argValue(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

// ---------- pricing ----------
// Anthropic first-party API list prices, USD per million tokens. Cache writes cost 1.25x input
// (5-minute TTL) or 2x input (1-hour TTL). Fast mode doubles the price.
// On a Pro/Max subscription this is what the same usage would cost on the API, not what you pay.
const PRICES = [
  [/^claude-(fable|mythos)-5-1/, { input: 10, output: 50, cacheRead: 0.25 }],
  [/^claude-(fable|mythos)-5/,   { input: 10, output: 50, cacheRead: 1 }],
  [/^claude-opus-5-5/,           { input: 4, output: 20, cacheRead: 0.2 }],
  [/^claude-opus-(5|4-[5-9])/,   { input: 5, output: 25, cacheRead: 0.5 }],
  [/^claude-opus-4/,             { input: 15, output: 75, cacheRead: 1.5 }],
  [/^claude-sonnet-5/,           { input: 2, output: 10, cacheRead: 0.2 }],
  [/^claude-sonnet-4/,           { input: 3, output: 15, cacheRead: 0.3 }],
  [/^claude-3-7-sonnet/,         { input: 3, output: 15, cacheRead: 0.3 }],
  [/^claude-haiku-5/,            { input: 0.1, output: 0.5, cacheRead: 0.01 }],
  [/^claude-haiku-4/,            { input: 1, output: 5, cacheRead: 0.1 }],
  [/^claude-3-5-haiku/,          { input: 0.8, output: 4, cacheRead: 0.08 }],
];

function priceFor(model) {
  for (const [re, p] of PRICES) if (re.test(model)) return p;
  return null;
}

function costUSD(ev) {
  const p = priceFor(ev.model);
  if (!p) return 0;
  const write5m = Math.max(0, ev.cacheWrite - ev.cacheWrite1h);
  const usd = (ev.input * p.input + ev.output * p.output + ev.cacheRead * p.cacheRead
    + write5m * p.input * 1.25 + ev.cacheWrite1h * p.input * 2) / 1e6;
  return ev.fast ? usd * 2 : usd;
}

// USD -> PLN mid rate from the National Bank of Poland, refreshed every 6 hours.
const fx = { usdPln: null, date: null, source: 'NBP' };
function refreshFx() {
  https.get('https://api.nbp.pl/api/exchangerates/rates/a/usd/?format=json', { timeout: 10000 }, res => {
    let body = '';
    res.on('data', c => (body += c));
    res.on('end', () => {
      try {
        const r = JSON.parse(body).rates[0];
        if (r.mid !== fx.usdPln) { fx.usdPln = r.mid; fx.date = r.effectiveDate; dirty = true; }
      } catch { /* keep the previous rate */ }
    });
  }).on('error', () => {});
}

// ---------- ingestion ----------

const files = new Map();     // file path -> { offset, rest: Buffer }
const responses = new Map(); // "messageId|requestId" -> event (deduped; streaming writes repeat usage)
const prompts = new Map();   // uuid -> { ts, project }
const sessions = new Map();  // sessionId -> { first, last, project }
let dirty = true;
let snapshot = null;

function listFiles(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listFiles(p, out);
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

function isPrompt(message) {
  const c = message && message.content;
  if (typeof c === 'string') return c.trim() !== '' && !c.startsWith('<');
  if (!Array.isArray(c)) return false;
  if (c.some(x => x && x.type === 'tool_result')) return false;
  return c.some(x => x && x.type === 'text' && x.text && !x.text.startsWith('<'));
}

function ingestLine(line) {
  if (!line) return;
  let d;
  try { d = JSON.parse(line); } catch { return; }
  if (!d || !d.timestamp) return;
  const ts = Date.parse(d.timestamp);
  if (!ts) return;
  const project = d.cwd ? path.basename(d.cwd) : 'unknown';

  if (d.sessionId) {
    const s = sessions.get(d.sessionId);
    if (!s) sessions.set(d.sessionId, { first: ts, last: ts, project });
    else { s.first = Math.min(s.first, ts); s.last = Math.max(s.last, ts); }
  }

  if (d.type === 'user' && !d.isSidechain && !d.isMeta && d.uuid && isPrompt(d.message)) {
    prompts.set(d.uuid, { ts, project });
    return;
  }
  if (d.type !== 'assistant') return;

  const m = d.message;
  const u = m && m.usage;
  if (!u || m.model === '<synthetic>') return;
  const ev = {
    ts,
    model: m.model || 'unknown',
    project,
    sidechain: !!d.isSidechain,
    input: u.input_tokens || 0,
    output: u.output_tokens || 0,
    cacheWrite: u.cache_creation_input_tokens || 0,
    cacheRead: u.cache_read_input_tokens || 0,
    cacheWrite1h: (u.cache_creation && u.cache_creation.ephemeral_1h_input_tokens) || 0,
    fast: u.speed === 'fast',
  };
  const key = `${m.id}|${d.requestId}`;
  const prev = responses.get(key);
  if (!prev) { responses.set(key, ev); return; }
  for (const k of ['input', 'output', 'cacheWrite', 'cacheRead', 'cacheWrite1h']) prev[k] = Math.max(prev[k], ev[k]);
}

function readNew(file) {
  let st;
  try { st = fs.statSync(file); } catch { return false; }
  let state = files.get(file);
  if (!state || st.size < state.offset) state = { offset: 0, rest: Buffer.alloc(0) };
  files.set(file, state);
  if (st.size === state.offset) return false;

  const fd = fs.openSync(file, 'r');
  try {
    while (state.offset < st.size) {
      const len = Math.min(CHUNK, st.size - state.offset);
      const chunk = Buffer.alloc(len);
      const n = fs.readSync(fd, chunk, 0, len, state.offset);
      if (n <= 0) break;
      state.offset += n;
      const buf = Buffer.concat([state.rest, chunk.subarray(0, n)]);
      const nl = buf.lastIndexOf(10);
      if (nl < 0) { state.rest = buf; continue; }
      for (const line of buf.subarray(0, nl).toString('utf8').split('\n')) ingestLine(line.trim());
      state.rest = buf.subarray(nl + 1);
    }
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

function scan() {
  let changed = false;
  if (!DEMO) for (const f of listFiles(ROOT)) if (readNew(f)) changed = true;
  if (changed) dirty = true;
  if (dirty) {
    dirty = false;
    snapshot = buildSnapshot();
    broadcast();
  }
}

// ---------- demo data (--demo) ----------
// A year of made-up activity, so the dashboard can be tried or screenshotted without real data.

let rand = (seed => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; })(42);
const pick = (list, weights) => { let r = rand() * weights.reduce((a, b) => a + b, 0); for (let i = 0; i < list.length; i++) if ((r -= weights[i]) < 0) return list[i]; return list[0]; };
const DEMO_PROJECTS = ['portfolio-site', 'discord-bot', 'game-jam-2026', 'api-server', 'mobile-app', 'dotfiles'];
const DEMO_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
let demoSeq = 0;

function demoResponse(ts, project, model, context) {
  responses.set(`demo-` + demoSeq++, {
    ts, model, project, sidechain: false,
    input: 3 + Math.floor(rand() * 40),
    output: 150 + Math.floor(rand() * rand() * 4000),
    cacheWrite: 500 + Math.floor(rand() * 6000),
    cacheRead: context,
    cacheWrite1h: 0, fast: false,
  });
}

function seedDemo() {
  const now = Date.now();
  for (let back = 364; back >= 0; back--) {
    const day = new Date(now - back * 864e5);
    const weekend = day.getDay() === 0 || day.getDay() === 6;
    const ramp = 0.25 + 0.75 * (1 - back / 364); // gets busier over the year
    if (rand() > (weekend ? 0.75 : 0.45) * ramp + 0.08) continue;
    for (let s = 0, sessionsToday = 1 + Math.floor(rand() * 3); s < sessionsToday; s++) {
      const project = pick(DEMO_PROJECTS, [5, 4, 2, 3, 2, 1]);
      const model = pick(DEMO_MODELS, [7, 2, 1]);
      const hour = pick([9, 11, 13, 15, 17, 19, 20, 21, 22, 23], [1, 2, 3, 4, 3, 4, 5, 5, 4, 2]);
      let ts = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, Math.floor(rand() * 60)).getTime();
      if (ts > now) continue;
      let context = 15000;
      for (let p = 0, n = 2 + Math.floor(rand() * 14); p < n; p++) {
        prompts.set(`demo-p` + demoSeq++, { ts, project });
        sessions.set(`demo-s` + day.toDateString() + s, { first: ts, last: ts, project });
        for (let r = 0, steps = 2 + Math.floor(rand() * 10); r < steps; r++) {
          ts += 4000 + rand() * 40000;
          context = Math.min(400000, context + 1500 + rand() * 9000);
          if (ts < now) demoResponse(ts, project, model, Math.round(context));
        }
        ts += 60000 + rand() * 600000;
      }
    }
  }
}

function addDemoResponse() {
  demoResponse(Date.now(), 'claude-stats', 'claude-opus-5-5', 40000 + Math.floor(rand() * 120000));
  if (rand() < 0.25) prompts.set(`demo-p` + demoSeq++, { ts: Date.now(), project: 'claude-stats' });
  dirty = true;
}

// ---------- aggregation ----------

const p2 = n => String(n).padStart(2, '0');
function hourKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}`;
}

function buildSnapshot() {
  const totals = { tokens: 0, cost: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, responses: 0, prompts: prompts.size, sessions: sessions.size, subagentResponses: 0, unpricedModels: [] };
  const hourly = {};
  const models = {};
  const projects = {};
  let first = Infinity, last = 0;

  const bucket = ts => (hourly[hourKey(ts)] ||= { tokens: 0, cost: 0, output: 0, responses: 0, prompts: 0 });
  const proj = name => (projects[name] ||= { tokens: 0, cost: 0, output: 0, responses: 0, prompts: 0, last: 0 });

  for (const ev of responses.values()) {
    const t = ev.input + ev.output + ev.cacheWrite + ev.cacheRead;
    const c = costUSD(ev);
    totals.tokens += t;
    totals.cost += c;
    totals.input += ev.input;
    totals.output += ev.output;
    totals.cacheWrite += ev.cacheWrite;
    totals.cacheRead += ev.cacheRead;
    totals.responses++;
    if (ev.sidechain) totals.subagentResponses++;
    first = Math.min(first, ev.ts);
    last = Math.max(last, ev.ts);

    const b = bucket(ev.ts);
    b.tokens += t; b.cost += c; b.output += ev.output; b.responses++;

    const m = (models[ev.model] ||= { tokens: 0, cost: 0, output: 0, responses: 0 });
    m.tokens += t; m.cost += c; m.output += ev.output; m.responses++;

    const p = proj(ev.project);
    p.tokens += t; p.cost += c; p.output += ev.output; p.responses++; p.last = Math.max(p.last, ev.ts);
  }
  totals.unpricedModels = Object.keys(models).filter(id => !priceFor(id));
  for (const pr of prompts.values()) {
    bucket(pr.ts).prompts++;
    const p = proj(pr.project);
    p.prompts++; p.last = Math.max(p.last, pr.ts);
  }

  const now = Date.now();
  const recentWindow = [...responses.values()].filter(e => now - e.ts < 5 * 60 * 1000);
  const recent = [...responses.values()]
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 12)
    .map(e => ({ ts: e.ts, model: e.model, project: e.project, output: e.output, tokens: e.input + e.output + e.cacheWrite + e.cacheRead, cost: costUSD(e) }));

  return {
    generatedAt: now,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    source: DEMO ? 'demo data' : ROOT,
    version: VERSION,
    fx,
    first: first === Infinity ? null : first,
    last: last || null,
    totals,
    lastFiveMinutes: {
      tokens: recentWindow.reduce((a, e) => a + e.input + e.output + e.cacheWrite + e.cacheRead, 0),
      output: recentWindow.reduce((a, e) => a + e.output, 0),
      cost: recentWindow.reduce((a, e) => a + costUSD(e), 0),
      responses: recentWindow.length,
    },
    hourly,
    models,
    projects,
    recent,
  };
}

// ---------- http ----------

const clients = new Set();

function broadcast() {
  const data = `data: ${JSON.stringify(snapshot)}\n\n`;
  for (const res of clients) res.write(data);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`retry: 3000\n\n`);
    if (snapshot) res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
    return;
  }

  // Lets a newer launch stop this copy. The custom header blocks cross-site requests from web pages.
  if (url.pathname === '/shutdown' && req.method === 'POST' && req.headers['x-claude-stats'] === '1') {
    res.writeHead(200); res.end('bye');
    server.close();
    setTimeout(() => process.exit(0), 100);
    return;
  }

  if (url.pathname === '/api/stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(snapshot));
    return;
  }

  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.resolve(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
});

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

// What is running on this port: null (something else), or Claude Stats with its version.
function probeExisting(port, cb) {
  const req = http.get({ host: '127.0.0.1', port, path: '/api/stats', timeout: 1500 }, res => {
    let body = '';
    res.on('data', c => (body += c));
    res.on('end', () => { try { const s = JSON.parse(body); cb(s && s.totals ? { version: s.version || null } : null); } catch { cb(null); } });
  });
  req.on('error', () => cb(null));
  req.on('timeout', () => { req.destroy(); cb(null); });
}

function askToShutDown(port, cb) {
  const req = http.request({ host: '127.0.0.1', port, path: '/shutdown', method: 'POST', headers: { 'X-Claude-Stats': '1' }, timeout: 1500 }, res => {
    res.resume();
    res.on('end', () => cb(res.statusCode === 200));
  });
  req.on('error', () => cb(false));
  req.on('timeout', () => { req.destroy(); cb(false); });
  req.end();
}

// --exit-when-closed: stop the server once no browser tab has been connected for a while.
function watchIdle() {
  const GRACE_MS = 45000, IDLE_MS = 20000;
  const started = Date.now();
  let idleSince = Date.now();
  setInterval(() => {
    if (clients.size > 0) { idleSince = Date.now(); return; }
    if (Date.now() - started > GRACE_MS && Date.now() - idleSince > IDLE_MS) process.exit(0);
  }, 5000);
}

function listen(port, attempts = 10) {
  server.once('error', err => {
    if (err.code !== 'EADDRINUSE' || attempts <= 0) { console.error(err.message); process.exit(1); }
    probeExisting(port, running => {
      if (!running) return listen(port + 1, attempts - 1);
      if (running.version !== VERSION) {
        // A copy running different code holds the port: replace it so the page always matches this code.
        return askToShutDown(port, ok => {
          if (!ok) return listen(port + 1, attempts - 1);
          console.log('  Replaced a running copy with a different version.');
          setTimeout(() => listen(port, attempts - 1), 400);
        });
      }
      const url = `http://localhost:${port}`;
      console.log(`\n  Claude Stats is already running  ->  ${url}\n`);
      if (!args.includes('--no-open')) openBrowser(url);
      setTimeout(() => process.exit(0), 500);
    });
  });
  server.listen(port, '127.0.0.1');
}

// Registered once: a callback passed to server.listen() would also fire for every earlier failed attempt.
server.once('listening', () => {
  const url = `http://localhost:${server.address().port}`;
  console.log(`\n  Claude Stats  ->  ${url}`);
  console.log(`  Reading:          ${ROOT}\n`);
  if (!fs.existsSync(ROOT)) console.log('  (folder not found yet — waiting for Claude Code to create it)\n');
  if (!args.includes('--no-open')) openBrowser(url);
  if (args.includes('--exit-when-closed')) watchIdle();
});

if (DEMO) { seedDemo(); setInterval(addDemoResponse, 4000); }
refreshFx();
setInterval(refreshFx, 6 * 3600 * 1000);
scan();
setInterval(scan, SCAN_MS);
if (!DEMO) try {
  let t;
  fs.watch(ROOT, { recursive: true }, () => { clearTimeout(t); t = setTimeout(scan, 150); });
} catch { /* polling covers platforms without recursive watch */ }

listen(PORT);
