// Claudix: аккаунты и облачные сохранения (Cloudflare Worker + D1).
// Пароли хранятся только как PBKDF2-хеш с солью. Сессия живёт 60 дней.

const NAME_RE = /^[A-Za-zА-Яа-яЁё0-9_-]{3,16}$/;
const GAMES = ["lemon", "liga"];
const MAX_SAVE = 200000;
const SESSION_MS = 60 * 24 * 3600 * 1000;
const PBKDF2_ITER = 100000; // максимум, который разрешает Workers

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS users (uid TEXT PRIMARY KEY, name TEXT NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL, created INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS sessions (th TEXT PRIMARY KEY, uid TEXT NOT NULL, exp INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS saves (uid TEXT NOT NULL, game TEXT NOT NULL, data TEXT NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY (uid, game))",
  "CREATE TABLE IF NOT EXISTS fails (k TEXT PRIMARY KEY, n INTEGER NOT NULL, t INTEGER NOT NULL)",
];

let ready = null;
function init(env) {
  if (!ready) {
    ready = env.DB.batch(SCHEMA.map((q) => env.DB.prepare(q))).catch((e) => { ready = null; throw e; });
  }
  return ready;
}

const HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" };
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: HEADERS });
const fail = (code, status) => json({ error: code }, status);

const b64 = (bytes) => { let s = ""; for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b); return btoa(s); };
const unb64 = (str) => Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
const hex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function hashPw(pw, saltB64) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: unb64(saltB64), iterations: PBKDF2_ITER, hash: "SHA-256" }, key, 256);
  return b64(bits);
}
function same(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
async function sha(text) { return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))); }
function newToken() { const a = crypto.getRandomValues(new Uint8Array(32)); return b64(a).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }

async function body(req, limit = MAX_SAVE * 2 + 5000) {
  const text = await req.text();
  if (text.length > limit) throw new HttpError("too_big", 413);
  try { const o = JSON.parse(text || "{}"); if (o && typeof o === "object") return o; } catch (e) { /* ниже */ }
  throw new HttpError("bad_json", 400);
}
class HttpError extends Error { constructor(code, status) { super(code); this.code = code; this.status = status; } }

// ---- защита от перебора ----
async function blocked(env, key, max, windowMs) {
  const r = await env.DB.prepare("SELECT n, t FROM fails WHERE k = ?1").bind(key).first();
  return !!r && Date.now() - r.t < windowMs && r.n >= max;
}
async function bump(env, key, windowMs) {
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO fails (k, n, t) VALUES (?1, 1, ?2) ON CONFLICT(k) DO UPDATE SET " +
    "n = CASE WHEN ?2 - t < ?3 THEN n + 1 ELSE 1 END, t = CASE WHEN ?2 - t < ?3 THEN t ELSE ?2 END"
  ).bind(key, now, windowMs).run();
}
const clearFails = (env, key) => env.DB.prepare("DELETE FROM fails WHERE k = ?1").bind(key).run();

// ---- сессии ----
async function startSession(env, uid) {
  const token = newToken();
  await env.DB.prepare("INSERT INTO sessions (th, uid, exp) VALUES (?1, ?2, ?3)").bind(await sha(token), uid, Date.now() + SESSION_MS).run();
  return token;
}
async function auth(env, req) {
  const m = /^Bearer ([\w-]{20,80})$/.exec(req.headers.get("authorization") || "");
  if (!m) return null;
  const th = await sha(m[1]);
  const row = await env.DB.prepare("SELECT s.uid AS uid, u.name AS name, s.exp AS exp FROM sessions s JOIN users u ON u.uid = s.uid WHERE s.th = ?1").bind(th).first();
  if (!row) return null;
  if (row.exp < Date.now()) { await env.DB.prepare("DELETE FROM sessions WHERE th = ?1").bind(th).run(); return null; }
  return { uid: row.uid, name: row.name, th };
}
function validSave(str) {
  if (typeof str !== "string" || str.length > MAX_SAVE) return false;
  try { const o = JSON.parse(str); return !!o && typeof o === "object" && !Array.isArray(o); } catch (e) { return false; }
}

// ---- маршруты ----
async function route(req, env) {
  const url = new URL(req.url);
  const path = url.pathname;
  const ip = req.headers.get("cf-connecting-ip") || "x";

  if (req.method === "GET" && path === "/api/name") {
    const n = (url.searchParams.get("n") || "").trim();
    if (!NAME_RE.test(n)) return json({ valid: false, free: false });
    const r = await env.DB.prepare("SELECT 1 AS x FROM users WHERE uid = ?1").bind(n.toLowerCase()).first();
    return json({ valid: true, free: !r });
  }

  if (req.method === "POST" && path === "/api/register") {
    const b = await body(req);
    const name = typeof b.name === "string" ? b.name.trim() : "";
    const pw = typeof b.password === "string" ? b.password : "";
    if (!NAME_RE.test(name)) return fail("bad_name", 400);
    if (pw.length < 4 || pw.length > 64) return fail("bad_password", 400);
    if (await blocked(env, "r:" + ip, 10, 3600e3)) return fail("slow_down", 429);
    const uid = name.toLowerCase();
    if (await env.DB.prepare("SELECT 1 AS x FROM users WHERE uid = ?1").bind(uid).first()) return fail("taken", 409);
    const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
    const hash = await hashPw(pw, salt);
    const now = Date.now();
    try {
      await env.DB.prepare("INSERT INTO users (uid, name, salt, hash, created) VALUES (?1, ?2, ?3, ?4, ?5)").bind(uid, name, salt, hash, now).run();
    } catch (e) {
      if (/UNIQUE|constraint/i.test(String(e && e.message))) return fail("taken", 409);
      throw e;
    }
    const saves = b.saves && typeof b.saves === "object" ? b.saves : {};
    for (const g of GAMES) {
      if (validSave(saves[g])) await env.DB.prepare("INSERT OR IGNORE INTO saves (uid, game, data, updated) VALUES (?1, ?2, ?3, ?4)").bind(uid, g, saves[g], now).run();
    }
    await bump(env, "r:" + ip, 3600e3);
    return json({ token: await startSession(env, uid), user: uid, name });
  }

  if (req.method === "POST" && path === "/api/login") {
    const b = await body(req);
    const name = typeof b.name === "string" ? b.name.trim() : "";
    const pw = typeof b.password === "string" ? b.password : "";
    if (!NAME_RE.test(name) || pw.length < 1 || pw.length > 64) return fail("bad_login", 401);
    const uid = name.toLowerCase();
    if ((await blocked(env, "l:" + uid, 10, 600e3)) || (await blocked(env, "li:" + ip, 40, 600e3))) return fail("slow_down", 429);
    const u = await env.DB.prepare("SELECT name, salt, hash FROM users WHERE uid = ?1").bind(uid).first();
    // Для несуществующего ника считаем такой же хеш, чтобы ответ шёл за то же время.
    const calc = await hashPw(pw, u ? u.salt : b64(new Uint8Array(16)));
    if (!u || !same(calc, u.hash)) {
      await bump(env, "l:" + uid, 600e3); await bump(env, "li:" + ip, 600e3);
      return fail("bad_login", 401);
    }
    await clearFails(env, "l:" + uid);
    return json({ token: await startSession(env, uid), user: uid, name: u.name });
  }

  const me = await auth(env, req);
  if (!me) return fail("unauthorized", 401);

  if (req.method === "GET" && path === "/api/me") return json({ user: me.uid, name: me.name });

  if (req.method === "POST" && path === "/api/logout") {
    await env.DB.prepare("DELETE FROM sessions WHERE th = ?1").bind(me.th).run();
    return json({ ok: true });
  }

  if (req.method === "GET" && path === "/api/saves") {
    const rows = await env.DB.prepare("SELECT game, data, updated FROM saves WHERE uid = ?1").bind(me.uid).all();
    const out = {};
    for (const r of rows.results || []) out[r.game] = { data: r.data, updated: r.updated };
    return json(out);
  }

  const m = /^\/api\/save\/([a-z]+)$/.exec(path);
  if (req.method === "PUT" && m) {
    const game = m[1];
    if (!GAMES.includes(game)) return fail("bad_game", 404);
    const b = await body(req);
    if (!validSave(b.data)) return fail("bad_save", 400);
    const base = Number.isFinite(b.base) ? b.base : 0;
    const now = Math.max(Date.now(), base + 1);
    let changed;
    if (base > 0) {
      const r = await env.DB.prepare("UPDATE saves SET data = ?3, updated = ?4 WHERE uid = ?1 AND game = ?2 AND updated = ?5").bind(me.uid, game, b.data, now, base).run();
      changed = r.meta.changes === 1;
    } else {
      const r = await env.DB.prepare("INSERT OR IGNORE INTO saves (uid, game, data, updated) VALUES (?1, ?2, ?3, ?4)").bind(me.uid, game, b.data, now).run();
      changed = r.meta.changes === 1;
    }
    if (!changed) return fail("conflict", 409); // прогресс успели изменить с другого устройства
    return json({ updated: now });
  }

  if (req.method === "POST" && path === "/api/delete") {
    const b = await body(req);
    const pw = typeof b.password === "string" ? b.password : "";
    if (await blocked(env, "l:" + me.uid, 10, 600e3)) return fail("slow_down", 429);
    const u = await env.DB.prepare("SELECT salt, hash FROM users WHERE uid = ?1").bind(me.uid).first();
    if (!u || !same(await hashPw(pw, u.salt), u.hash)) { await bump(env, "l:" + me.uid, 600e3); return fail("bad_login", 401); }
    await env.DB.batch([
      env.DB.prepare("DELETE FROM saves WHERE uid = ?1").bind(me.uid),
      env.DB.prepare("DELETE FROM sessions WHERE uid = ?1").bind(me.uid),
      env.DB.prepare("DELETE FROM users WHERE uid = ?1").bind(me.uid),
    ]);
    return json({ ok: true });
  }

  return fail("not_found", 404);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
    try {
      await init(env);
      return await route(req, env);
    } catch (e) {
      if (e instanceof HttpError) return fail(e.code, e.status);
      console.error(e && e.stack || e);
      return fail("server", 500);
    }
  },
};
