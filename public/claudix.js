// Claudix: общий клиент аккаунтов и облачных сохранений.
(function () {
  "use strict";
  var SES = "claudix-session";
  var GAMES = { lemon: "limonny-iks-v1", liga: "liga-ulic-v1" };
  var FLUSH_MS = 30000;

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) { /* ничего */ } }

  function session() {
    try {
      var s = JSON.parse(lsGet(SES) || "null");
      return s && typeof s.user === "string" && s.user && typeof s.token === "string" && s.token ? s : null;
    } catch (e) { return null; }
  }
  function saveKey(game, user) { return GAMES[game] + (user ? ":" + user : ""); }
  function dirtyKey(game, user) { return "cx-dirty:" + user + ":" + game; }

  // ---------- запросы ----------
  function api(path, method, body, keepalive) {
    var s = session();
    var headers = { "content-type": "application/json" };
    if (s) headers.authorization = "Bearer " + s.token;
    var ctl = window.AbortController ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, 10000) : null;
    return fetch(path, {
      method: method || "GET", headers: headers, keepalive: !!keepalive,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctl ? ctl.signal : undefined, cache: "no-store"
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) { return { status: r.status, data: data }; });
    }).then(function (res) { if (timer) clearTimeout(timer); return res; },
      function (err) { if (timer) clearTimeout(timer); throw err; });
  }

  // ---------- облачные сохранения ----------
  var base = {}, lastSent = {}, timers = {}, inflight = {}, enabled = false, conflictCb = null;

  function normalized(str) {
    // в лимонах поле t меняется на каждом автосейве, на сравнение оно не влияет
    try { var o = JSON.parse(str); delete o.t; return JSON.stringify(o); } catch (e) { return str; }
  }
  function flush(game, keepalive) {
    var s = session();
    if (!s || !enabled) return Promise.resolve();
    if (inflight[game]) return inflight[game];
    var raw = lsGet(saveKey(game, s.user));
    if (!raw) return Promise.resolve();
    if (lastSent[game] != null && normalized(raw) === normalized(lastSent[game])) { lsDel(dirtyKey(game, s.user)); return Promise.resolve(); }
    var p = api("/api/save/" + game, "PUT", { data: raw, base: base[game] || 0 }, keepalive).then(function (r) {
      if (r.status === 200) { base[game] = r.data.updated; lastSent[game] = raw; lsDel(dirtyKey(game, s.user)); }
      else if (r.status === 409) { enabled = false; lsDel(dirtyKey(game, s.user)); if (conflictCb) conflictCb(); else banner(); }
      else if (r.status === 401) { enabled = false; }
    }).catch(function () { /* нет сети: останется «грязным», уйдёт при следующем заходе */ })
      .then(function () { inflight[game] = null; });
    inflight[game] = p;
    return p;
  }
  function banner() {
    if (document.getElementById("cx-conflict")) return;
    var d = document.createElement("div");
    d.id = "cx-conflict";
    d.setAttribute("role", "alert");
    d.style.cssText = "position:fixed;left:12px;right:12px;bottom:12px;z-index:99999;padding:12px 14px;border-radius:12px;background:#1b1f2b;color:#fff;font:600 14px/1.35 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.45);display:flex;gap:10px;align-items:center;justify-content:space-between";
    d.appendChild(document.createTextNode("Этот аккаунт играли на другом устройстве, там прогресс новее. Обнови страницу, чтобы взять его."));
    var b = document.createElement("button");
    b.textContent = "Обновить";
    b.style.cssText = "flex:none;border:0;border-radius:9px;padding:9px 14px;font:700 14px system-ui,sans-serif;background:#ffd23f;color:#1b1f2b";
    b.onclick = function () { location.reload(); };
    d.appendChild(b);
    document.body.appendChild(d);
  }
  function push(game) {
    var s = session();
    if (!s || !GAMES[game]) return;
    lsSet(dirtyKey(game, s.user), "1");
    if (timers[game] || !enabled) return;
    timers[game] = setTimeout(function () { timers[game] = null; flush(game); }, FLUSH_MS);
  }
  function flushAll(keepalive) {
    Object.keys(GAMES).forEach(function (g) { if (timers[g]) { clearTimeout(timers[g]); timers[g] = null; } flush(g, keepalive); });
  }

  function pullAll() {
    var s = session();
    if (!s) return Promise.resolve(false);
    return api("/api/saves").then(function (r) {
      if (r.status === 401) { clearSession(); return false; }
      if (r.status !== 200) return false;
      var cloud = r.data || {}, jobs = [];
      enabled = true;
      Object.keys(GAMES).forEach(function (g) {
        var c = cloud[g], key = saveKey(g, s.user), local = lsGet(key), dirty = lsGet(dirtyKey(g, s.user)) === "1";
        if (c) {
          base[g] = c.updated; lastSent[g] = c.data;
          if (dirty && local) jobs.push(flush(g));
          else { lsSet(key, c.data); lsDel(dirtyKey(g, s.user)); }
        } else {
          base[g] = 0; lastSent[g] = null;
          if (local) jobs.push(flush(g));
        }
      });
      return Promise.all(jobs).then(function () { return true; });
    }).catch(function () { return false; });
  }

  function ready(cb) {
    var done = false;
    function go() { if (done) return; done = true; cb(); }
    if (!session()) { go(); return; }
    pullAll().then(go, go);
    setTimeout(function () { if (!done) { enabled = false; go(); } }, 6000);
  }

  // ---------- аккаунт ----------
  function clearSession() { lsDel(SES); enabled = false; }
  function startSession(res) {
    lsSet(SES, JSON.stringify({ user: res.user, name: res.name, token: res.token }));
  }
  function guestSaves() {
    var out = {};
    Object.keys(GAMES).forEach(function (g) { var v = lsGet(saveKey(g, "")); if (v) out[g] = v; });
    return out;
  }
  function authCall(path, name, password, extra) {
    var body = { name: name, password: password };
    if (extra) for (var k in extra) body[k] = extra[k];
    return api(path, "POST", body).then(function (r) {
      if (r.status === 200) { startSession(r.data); return pullAll().then(function () { return { ok: true, name: r.data.name }; }); }
      return { ok: false, code: (r.data && r.data.error) || "server", status: r.status };
    }, function () { return { ok: false, code: "network", status: 0 }; });
  }
  function nameFree(name) {
    return api("/api/name?n=" + encodeURIComponent(name)).then(function (r) { return r.status === 200 ? r.data : null; }, function () { return null; });
  }
  function validate() {
    if (!session()) return Promise.resolve(false);
    return api("/api/me").then(function (r) {
      if (r.status === 401) { clearSession(); return false; }
      return r.status === 200;
    }, function () { return true; }); // нет сети: остаёмся «вошедшими»
  }
  function logout() {
    var s = session();
    var done = s ? Promise.all(Object.keys(GAMES).map(function (g) { return flush(g); })) : Promise.resolve();
    return done.then(function () { return s ? api("/api/logout", "POST", {}).catch(function () { }) : null; }).then(function () {
      if (s) Object.keys(GAMES).forEach(function (g) { if (lsGet(dirtyKey(g, s.user)) !== "1") lsDel(saveKey(g, s.user)); });
      clearSession();
    });
  }
  function deleteAccount(password) {
    var s = session();
    return api("/api/delete", "POST", { password: password }).then(function (r) {
      if (r.status === 200 && s) {
        Object.keys(GAMES).forEach(function (g) { lsDel(saveKey(g, s.user)); lsDel(dirtyKey(g, s.user)); });
        clearSession();
        return { ok: true };
      }
      return { ok: false, code: (r.data && r.data.error) || "server" };
    }, function () { return { ok: false, code: "network" }; });
  }

  document.addEventListener("visibilitychange", function () { if (document.hidden) flushAll(true); });
  window.addEventListener("pagehide", function () { flushAll(true); });

  window.Claudix = {
    session: session, saveKey: saveKey, GAMES: GAMES,
    ready: ready, pullAll: pullAll, push: push, flushAll: flushAll,
    register: function (name, pw, withGuest) { return authCall("/api/register", name, pw, withGuest ? { saves: guestSaves() } : null); },
    login: function (name, pw) { return authCall("/api/login", name, pw); },
    logout: logout, deleteAccount: deleteAccount, nameFree: nameFree, validate: validate,
    onConflict: function (fn) { conflictCb = fn; }
  };
})();
