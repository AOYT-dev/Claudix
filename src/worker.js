// Claudix: аккаунты и облачные сохранения (Cloudflare Worker + D1).
// Пароли хранятся только как PBKDF2-хеш с солью. Сессия живёт 60 дней.

const NAME_RE = /^[A-Za-zА-Яа-яЁё0-9_-]{3,16}$/;
const GAMES = ["lemon", "liga", "viraj"];
const MAX_SAVE = 200000;
const SESSION_MS = 60 * 24 * 3600 * 1000;
const PBKDF2_ITER = 100000; // максимум, который разрешает Workers

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS users (uid TEXT PRIMARY KEY, name TEXT NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL, created INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS sessions (th TEXT PRIMARY KEY, uid TEXT NOT NULL, exp INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS saves (uid TEXT NOT NULL, game TEXT NOT NULL, data TEXT NOT NULL, updated INTEGER NOT NULL, score REAL NOT NULL DEFAULT 0, PRIMARY KEY (uid, game))",
  "CREATE TABLE IF NOT EXISTS fails (k TEXT PRIMARY KEY, n INTEGER NOT NULL, t INTEGER NOT NULL)",
];

let ready = null;
async function migrate(env) {
  await env.DB.batch(SCHEMA.map((q) => env.DB.prepare(q)));
  // База могла быть создана до таблицы лидеров: докидываем колонку score и считаем очки для старых сохранений.
  const cols = await env.DB.prepare("PRAGMA table_info(saves)").all();
  if (!(cols.results || []).some((c) => c.name === "score")) {
    await env.DB.prepare("ALTER TABLE saves ADD COLUMN score REAL NOT NULL DEFAULT 0").run();
    const rows = await env.DB.prepare("SELECT uid, game, data FROM saves").all();
    for (const r of rows.results || []) {
      await env.DB.prepare("UPDATE saves SET score = ?3 WHERE uid = ?1 AND game = ?2").bind(r.uid, r.game, scoreOf(r.game, r.data)).run();
    }
  }
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS saves_top ON saves (game, score DESC)").run();
}
function init(env) {
  if (!ready) ready = migrate(env).catch((e) => { ready = null; throw e; });
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
async function authToken(env, token) {
  if (!/^[\w-]{20,80}$/.test(token || "")) return null;
  const th = await sha(token);
  const row = await env.DB.prepare("SELECT s.uid AS uid, u.name AS name, s.exp AS exp FROM sessions s JOIN users u ON u.uid = s.uid WHERE s.th = ?1").bind(th).first();
  if (!row) return null;
  if (row.exp < Date.now()) { await env.DB.prepare("DELETE FROM sessions WHERE th = ?1").bind(th).run(); return null; }
  return { uid: row.uid, name: row.name, th };
}
async function auth(env, req) {
  const m = /^Bearer ([\w-]{20,80})$/.exec(req.headers.get("authorization") || "");
  return m ? authToken(env, m[1]) : null;
}
// Очки для таблицы лидеров: Лимонный Икс считается по общему иксу, Лига Улиц по лучшей волне.
// Данные приходят с устройства игрока, так что это честная игра без защиты от подделки.
const LEMON_TIERS = [2, 3, 5, 10, 20, 50, 100, 300, 1000];
function scoreOf(game, str) {
  try {
    const o = JSON.parse(str);
    if (game === "lemon") {
      let m = 1;
      LEMON_TIERS.forEach((t, i) => { if (Array.isArray(o.tiers) && o.tiers[i]) m *= t; });
      m *= Math.pow(2, Math.min(Math.max(0, Math.floor(+o.inf || 0)), 900));
      return m <= 1 ? 0 : (Number.isFinite(m) ? m : 1e300); // без иксов в таблицу не попадаешь
    }
    if (game === "liga") return Math.min(Math.max(0, Math.floor(+o.best || 0)), 1e6);
    if (game === "viraj") {
      // Вираж-9: лучший круг на трассе «Закат». Таблица сортирует по убыванию, поэтому храним 100000 / секунды.
      const t = o.bests && typeof o.bests === "object" ? +o.bests["0"] : 0;
      return Number.isFinite(t) && t >= 20 && t < 3600 ? 100000 / t : 0; // быстрее 20 секунд круг не проехать
    }
  } catch (e) { /* ниже */ }
  return 0;
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

  const mt = /^\/api\/top\/([a-z]+)$/.exec(path);
  if (req.method === "GET" && mt) {
    const game = mt[1];
    if (!GAMES.includes(game)) return fail("bad_game", 404);
    const rows = await env.DB.prepare(
      "SELECT u.name AS name, s.uid AS uid, s.score AS score FROM saves s JOIN users u ON u.uid = s.uid WHERE s.game = ?1 AND s.score > 0 ORDER BY s.score DESC, s.updated ASC LIMIT 20"
    ).bind(game).all();
    const out = { top: (rows.results || []).map((r) => ({ name: r.name, uid: r.uid, score: r.score })), me: null };
    const who = await auth(env, req);
    if (who) {
      const mine = await env.DB.prepare("SELECT score FROM saves WHERE uid = ?1 AND game = ?2").bind(who.uid, game).first();
      if (mine && mine.score > 0) {
        const ahead = await env.DB.prepare("SELECT COUNT(*) AS n FROM saves WHERE game = ?1 AND score > ?2").bind(game, mine.score).first();
        out.me = { uid: who.uid, score: mine.score, rank: (ahead ? ahead.n : 0) + 1 };
      }
    }
    return json(out);
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
      if (validSave(saves[g])) await env.DB.prepare("INSERT OR IGNORE INTO saves (uid, game, data, updated, score) VALUES (?1, ?2, ?3, ?4, ?5)").bind(uid, g, saves[g], now, scoreOf(g, saves[g])).run();
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

  if (path === "/api/room" || path === "/api/race") {
    // WebSocket не умеет слать заголовок Authorization, поэтому токен едет как подпротокол.
    if (req.headers.get("upgrade") !== "websocket") return fail("expected_websocket", 426);
    const proto = (req.headers.get("sec-websocket-protocol") || "").split(",")[0].trim();
    const who = await authToken(env, proto);
    if (!who) return fail("unauthorized", 401);
    // гонки Виража живут в отдельном экземпляре комнаты, чтобы не смешиваться с лобби Лиги
    const race = path === "/api/race";
    return env.ROOM.get(env.ROOM.idFromName(race ? "race" : "main")).fetch("https://room.internal/ws", {
      headers: { upgrade: "websocket", "x-uid": who.uid, "x-name": who.name, "x-proto": proto, "x-mode": race ? "race" : "" },
    });
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
      const r = await env.DB.prepare("UPDATE saves SET data = ?3, updated = ?4, score = ?6 WHERE uid = ?1 AND game = ?2 AND updated = ?5").bind(me.uid, game, b.data, now, base, scoreOf(game, b.data)).run();
      changed = r.meta.changes === 1;
    } else {
      const r = await env.DB.prepare("INSERT OR IGNORE INTO saves (uid, game, data, updated, score) VALUES (?1, ?2, ?3, ?4, ?5)").bind(me.uid, game, b.data, now, scoreOf(game, b.data)).run();
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

// ---- онлайн-лобби: одна общая комната на всех (Durable Object, WebSocket) ----
const HERO_IDS = ["cobalt", "storm", "shade", "graviton", "flame", "abyss"];
const ROOM_MAX = 24;
const ADV_RELAY = ["ap", "ae", "ah", "ax", "aa", "ar"];
// Halloween Adventure пока на проверке: в очередь пускаем только этих игроков (uid). Пустой список = всех.
const ADV_ALLOW = ["claudix_dev1"];
const lim = (v, l) => (Number.isFinite(v) ? Math.max(-l, Math.min(l, v)) : 0);
const pub = (a) => ({ u: a.u, n: a.n, h: a.h, x: a.x, z: a.z, f: a.f, m: a.m });

export class Room {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.rl = new Map();
    try { ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong")); } catch (e) { /* не критично */ }
  }
  live() {
    return this.ctx.getWebSockets().filter((w) => { const a = w.deserializeAttachment(); return a && !a.dead; });
  }
  sockOf(uid) {
    return this.live().find((w) => w.deserializeAttachment().u === uid) || null;
  }
  sendTo(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch (e) { /* сокет уже закрыт */ } }
  // дуэль закончилась: возвращаем обоих в общую комнату
  endDuel(aWs, winner, reason) {
    const a = aWs.deserializeAttachment();
    if (!a || !a.d) return;
    const oWs = this.sockOf(a.d), oppUid = a.d;
    const fin = (ws) => {
      const x = ws.deserializeAttachment();
      if (!x || x.dead) return;
      x.d = ""; x.q = 0; ws.serializeAttachment(x);
      this.sendTo(ws, { t: "de", w: winner, r: reason || "" });
      this.broadcast({ t: "j", p: pub(x) }, x.u);
    };
    fin(aWs);
    if (oWs && oWs.deserializeAttachment().d === a.u) fin(oWs);
    void oppUid;
  }
  // Хеллоуинское приключение: пати из 1–2 игроков. Сервер только сводит пары и пересылает сообщения внутри пати,
  // врагов считает один из игроков (хост).
  tryMatchAdv(ws) {
    const a = ws.deserializeAttachment();
    for (const w of this.live()) {
      const b = w.deserializeAttachment();
      if (b.u === a.u || !b.aq || b.d || b.a) continue;
      a.aq = 0; b.aq = 0; a.a = b.u; b.a = a.u;
      ws.serializeAttachment(a); w.serializeAttachment(b);
      this.broadcast({ t: "l", u: a.u });
      this.broadcast({ t: "l", u: b.u });
      this.sendTo(ws, { t: "as", s: 0, o: { u: b.u, n: b.n, h: b.ah, p: b.ap } });
      this.sendTo(w, { t: "as", s: 1, o: { u: a.u, n: a.n, h: a.ah, p: a.ap } });
      return;
    }
  }
  // игрок вышел из подземелья (сам или обрыв связи): напарник продолжает один
  endAdv(ws, back) {
    const a = ws.deserializeAttachment();
    if (!a || !a.a) return;
    const mate = a.a !== "@" ? this.sockOf(a.a) : null;
    a.a = ""; a.aq = 0; ws.serializeAttachment(a);
    if (back) this.broadcast({ t: "j", p: pub(a) }, a.u);
    if (mate) {
      const b = mate.deserializeAttachment();
      if (b && b.a === a.u) { b.a = "@"; mate.serializeAttachment(b); this.sendTo(mate, { t: "aend", r: "left" }); }
    }
  }
  tryMatch(ws) {
    const a = ws.deserializeAttachment();
    for (const w of this.live()) {
      const b = w.deserializeAttachment();
      if (b.u === a.u || !b.q || b.d || b.a) continue;
      a.q = 0; b.q = 0; a.d = b.u; b.d = a.u; a.dl = Date.now(); b.dl = a.dl;
      ws.serializeAttachment(a); w.serializeAttachment(b);
      // обоих убираем из общей комнаты
      this.broadcast({ t: "l", u: a.u });
      this.broadcast({ t: "l", u: b.u });
      this.sendTo(ws, { t: "ds", s: 0, o: { u: b.u, n: b.n, h: b.dh } });
      this.sendTo(w, { t: "ds", s: 1, o: { u: a.u, n: a.n, h: a.dh } });
      return;
    }
  }
  broadcast(obj, exceptUid) {
    const text = JSON.stringify(obj);
    for (const w of this.live()) {
      if (exceptUid && w.deserializeAttachment().u === exceptUid) continue;
      try { w.send(text); } catch (e) { /* сокет уже закрыт */ }
    }
  }
  async fetch(req) {
    if (req.headers.get("upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    const uid = req.headers.get("x-uid"), name = req.headers.get("x-name"), proto = req.headers.get("x-proto"), raceMode = req.headers.get("x-mode") === "race";
    if (!uid || !name) return new Response("unauthorized", { status: 401 });
    // тот же аккаунт открыл вторую вкладку: старую выкидываем
    for (const w of this.ctx.getWebSockets()) {
      const a = w.deserializeAttachment();
      if (a && a.u === uid && !a.dead) { w.serializeAttachment({ ...a, dead: true }); try { w.close(4000, "replaced"); } catch (e) { /* ничего */ } }
    }
    const others = this.live();
    if (others.length >= ROOM_MAX) return new Response("full", { status: 503 });
    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    this.ctx.acceptWebSocket(server);
    if (raceMode) {
      server.serializeAttachment({ g: "race", u: uid, n: name, rq: 0, car: "junk", mt: "", mm: [], ts: 0 });
      server.send(JSON.stringify({ t: "hello", you: uid }));
      return new Response(null, { status: 101, webSocket: client, headers: proto ? { "Sec-WebSocket-Protocol": proto } : {} });
    }
    const me = { u: uid, n: name, h: "cobalt", x: 0, z: 6, f: Math.PI, m: 0, ts: 0, q: 0, d: "", dh: "cobalt", dl: 0, hs: 0, a: "", aq: 0, ah: "cobalt", ap: 0 };
    server.serializeAttachment(me);
    server.send(JSON.stringify({ t: "hello", you: uid, players: others.map((w) => w.deserializeAttachment()).filter((x) => !x.d && !x.a).map(pub) }));
    this.broadcast({ t: "j", p: pub(me) }, uid);
    return new Response(null, { status: 101, webSocket: client, headers: proto ? { "Sec-WebSocket-Protocol": proto } : {} });
  }
  webSocketMessage(ws, data) {
    if (typeof data !== "string" || data.length > 2400) return;
    let m;
    try { m = JSON.parse(data); } catch (e) { return; }
    const a = ws.deserializeAttachment();
    if (!a || a.dead || !m || typeof m.t !== "string") return;
    if (a.g === "race") { this.raceMsg(ws, a, m, data); return; }
    if (ADV_RELAY.includes(m.t)) {
      // внутри пати пересылаем как есть, позицию и снимок врагов не чаще ~20 раз в секунду
      if (!a.a || a.a === "@") return;
      if (m.t === "ap" || m.t === "ae") {
        const k = a.u + m.t, now = Date.now();
        if (now - (this.rl.get(k) || 0) < 45) return;
        this.rl.set(k, now);
      }
      const o = this.sockOf(a.a);
      if (o && o.deserializeAttachment().a === a.u) { try { o.send(data); } catch (e) { /* сокет уже закрыт */ } }
      return;
    }
    if (data.length > 300) return;
    if (m.t === "aq" && HERO_IDS.includes(m.id)) {
      if (a.d || a.a || (ADV_ALLOW.length && !ADV_ALLOW.includes(a.u))) return;
      a.ah = m.id; a.ap = Math.max(0, Math.min(25, Math.floor(+m.p || 0)));
      if (m.solo) {
        a.a = "@"; a.aq = 0; ws.serializeAttachment(a);
        this.broadcast({ t: "l", u: a.u }, a.u);
        this.sendTo(ws, { t: "as", s: 0, o: null });
      } else { a.aq = 1; ws.serializeAttachment(a); this.tryMatchAdv(ws); }
      return;
    }
    if (m.t === "aqc") { if (a.aq) { a.aq = 0; ws.serializeAttachment(a); } return; }
    if (m.t === "aend") { this.endAdv(ws, true); return; }
    if (a.a) return; // в подземелье общая комната игрока не видит
    if (m.t === "p") {
      const now = Date.now();
      if (now - a.ts < 50) return; // не чаще 20 раз в секунду
      a.ts = now;
      if (a.d) {
        // в дуэли позиции видит только соперник
        const o = this.sockOf(a.d);
        ws.serializeAttachment(a);
        if (o) this.sendTo(o, { t: "dp", x: lim(m.x, 20), z: lim(m.z, 20), f: lim(m.f, 10), m: m.m ? 1 : 0, hp: Math.max(0, Math.min(1000, +m.hp || 0)) });
        return;
      }
      a.x = lim(m.x, 35.5); a.z = lim(m.z, 35.5); a.f = lim(m.f, 10); a.m = m.m ? 1 : 0;
      ws.serializeAttachment(a);
      this.broadcast({ t: "p", u: a.u, x: a.x, z: a.z, f: a.f, m: a.m }, a.u);
    } else if (m.t === "h" && HERO_IDS.includes(m.id)) {
      if (a.d) return;
      a.h = m.id;
      ws.serializeAttachment(a);
      this.broadcast({ t: "h", u: a.u, h: a.h }, a.u);
    } else if (m.t === "q" && HERO_IDS.includes(m.id)) {
      if (a.d || a.a) return;
      a.q = 1; a.dh = m.id;
      ws.serializeAttachment(a);
      this.tryMatch(ws);
    } else if (m.t === "qc") {
      if (a.q) { a.q = 0; ws.serializeAttachment(a); }
    } else if (a.d && (m.t === "da" || m.t === "dx")) {
      // эффект атаки / удар по сопернику
      const o = this.sockOf(a.d);
      if (!o) return;
      if (m.t === "da") this.sendTo(o, { t: "da", k: m.k ? 1 : 0, f: lim(m.f, 10), x: lim(m.x, 20), z: lim(m.z, 20) });
      else {
        const now = Date.now();
        if (now - a.hs < 40) return; // не чаще 25 ударов в секунду
        a.hs = now; ws.serializeAttachment(a);
        this.sendTo(o, { t: "dx", d: Math.max(0, Math.min(150, +m.d || 0)), x: lim(m.x, 20), z: lim(m.z, 20) });
      }
    } else if (a.d && m.t === "dd") {
      // я проиграл
      this.endDuel(ws, a.d, "ko");
    } else if (a.d && m.t === "dq") {
      // я сдался / вышел из дуэли
      this.endDuel(ws, a.d, "quit");
    }
  }
  // ---- онлайн-гонки Виража: очередь на 2–4 игроков, дальше сервер только пересылает положение машин ----
  raceSockets(uids) { return this.live().filter((w) => uids.includes(w.deserializeAttachment().u)); }
  raceQueueInfo(n) {
    const q = this.live().filter((w) => { const b = w.deserializeAttachment(); return b.g === "race" && b.rq === n && !b.mt; });
    for (const w of q) this.sendTo(w, { t: "rw", n, have: q.length });
    return q;
  }
  raceMsg(ws, a, m, data) {
    if (m.t === "rq" && [2, 3, 4].includes(m.n)) {
      if (a.mt) return;
      a.rq = m.n; a.car = /^[a-z]{1,8}$/.test(m.car || "") ? m.car : "junk";
      ws.serializeAttachment(a);
      const q = this.raceQueueInfo(m.n);
      if (q.length >= m.n) {
        const group = q.slice(0, m.n), id = Math.random().toString(36).slice(2, 10), track = Math.floor(Math.random() * 5);
        const players = group.map((w) => { const b = w.deserializeAttachment(); return { u: b.u, n: b.n, car: b.car }; });
        const uids = players.map((p) => p.u);
        group.forEach((w, slot) => {
          const b = w.deserializeAttachment(); b.rq = 0; b.mt = id; b.mm = uids; w.serializeAttachment(b);
          this.sendTo(w, { t: "rs", id, track, laps: 3, slot, players, in: 4000 });
        });
        this.raceQueueInfo(m.n);
      }
      return;
    }
    if (m.t === "rqc") { const n = a.rq; a.rq = 0; ws.serializeAttachment(a); if (n) this.raceQueueInfo(n); return; }
    if (!a.mt) return;
    if (m.t === "rp" || m.t === "rf") {
      if (m.t === "rp") { const now = Date.now(); if (now - a.ts < 45) return; a.ts = now; ws.serializeAttachment(a); }
      if (data.length > 400) return;
      const msg = JSON.stringify(Object.assign({}, m, { u: a.u }));
      for (const w of this.raceSockets(a.mm)) if (w !== ws && w.deserializeAttachment().mt === a.mt) { try { w.send(msg); } catch (e) { /* закрыт */ } }
      return;
    }
    if (m.t === "rl") this.raceLeave(ws);
  }
  raceLeave(ws) {
    const a = ws.deserializeAttachment();
    if (!a || !a.mt) return;
    for (const w of this.raceSockets(a.mm)) if (w !== ws && w.deserializeAttachment().mt === a.mt) this.sendTo(w, { t: "rx", u: a.u });
    a.mt = ""; a.mm = []; ws.serializeAttachment(a);
  }
  drop(ws) {
    const a = ws.deserializeAttachment();
    if (a && a.g === "race") { const n = a.rq; this.raceLeave(ws); ws.serializeAttachment({ ...ws.deserializeAttachment(), dead: true, rq: 0 }); if (n) this.raceQueueInfo(n); return; }
    if (a && !a.dead && a.a) { this.endAdv(ws, false); ws.serializeAttachment({ ...ws.deserializeAttachment(), dead: true }); this.broadcast({ t: "l", u: a.u }, a.u); return; }
    if (a && !a.dead) {
      if (a.d) {
        const o = this.sockOf(a.d);
        ws.serializeAttachment({ ...a, dead: true });
        if (o) this.endDuel(o, a.d, "left");
        this.broadcast({ t: "l", u: a.u }, a.u);
        return;
      }
      ws.serializeAttachment({ ...a, dead: true });
      this.broadcast({ t: "l", u: a.u }, a.u);
    }
  }
  webSocketClose(ws) { this.drop(ws); try { ws.close(); } catch (e) { /* ничего */ } }
  webSocketError(ws) { this.drop(ws); }
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
