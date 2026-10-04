/* ════════════════════════════════════════════════════════════════════════════
   PetBase · motor de sincronización
   Lógica pura: no depende del navegador ni de Firebase. Los adaptadores (nube
   simulada y Firestore) están al final del archivo.

   Modelo
   ─ Cada registro (mascota, apunte, saco) es un documento formado por «celdas»:
       un campo = una celda; cada nota de seguimiento de una visita = una celda.
   ─ Cada celda lleva un sello HLC (reloj lógico híbrido). Al fusionar, gana la
     celda con el sello mayor. La fusión es conmutativa, asociativa e idempotente:
     el orden y las repeticiones no importan → todos los dispositivos convergen.
   ─ Borrar un registro guarda una lápida (d). El registro sigue vivo si alguna
     celda es posterior a la lápida (editar después de borrar lo recupera).
   ─ Los sellos se hacen con la hora del servidor (offset medido al conectar),
     así que un reloj mal puesto no decide quién gana.
   ════════════════════════════════════════════════════════════════════════════ */
(function (root) {
'use strict';

var SCHEMA = 2;
var COLS = ['pets', 'entries', 'sacks'];
var SETTINGS_ID = '_settings';
var SETTINGS_KEYS = ['palette', 'custom', 'weekStart', 'calView'];   // el modo claro/oscuro es del dispositivo, no se sincroniza
var NULLH = '~';
var MAX_DRIFT = 6 * 3600e3;
var GC_AFTER = 180 * 864e5;
var CHUNK = 40;
var MAX_DOC = 900000;

/* ── utilidades ─────────────────────────────────────────────────────────── */
function stable(v) {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).filter(function (k) { return v[k] !== undefined; }).sort().map(function (k) { return JSON.stringify(k) + ':' + stable(v[k]); }).join(',') + '}';
  return JSON.stringify(v);
}
function strHash(s) {
  var h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (var i = 0; i < s.length; i++) { var c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
function clone(o) { return o === undefined ? undefined : JSON.parse(JSON.stringify(o)); }
function rnd(n) {
  var s = '';
  var g = (typeof crypto !== 'undefined' && crypto.getRandomValues) ? crypto : null;
  while (s.length < n) {
    var x;
    if (g) { var a = new Uint32Array(2); g.getRandomValues(a); x = a[0].toString(36) + a[1].toString(36); }
    else x = Math.floor(Math.random() * 2821109907456).toString(36);
    s += x;
  }
  return s.slice(0, n);
}
function docBytes(d) { return unescape(encodeURIComponent(JSON.stringify(d))).length; }

/* ── reloj lógico híbrido ───────────────────────────────────────────────── */
function hlcStr(w, c, n) { return w.toString(36).padStart(9, '0') + '-' + c.toString(36).padStart(4, '0') + '-' + n; }
function hlcParse(s) { var a = s.split('-'); return { w: parseInt(a[0], 36), c: parseInt(a[1], 36), n: a.slice(2).join('-') }; }
function shiftH(s, delta) { var h = hlcParse(s); return hlcStr(Math.max(0, h.w + delta), h.c, h.n); }

function Clock(st, nowFn, node) {
  this.st = st;
  this.now = nowFn || function () { return Date.now(); };
  this.node = node || (st.sync.dev + 't' + rnd(3));       // único por pestaña: dos pestañas nunca repiten sello
}
Clock.prototype.pt = function () { return Math.round(this.now() + (this.st.sync.off || 0)); };
Clock.prototype.tick = function () {
  var h = this.st.sync.hlc, pt = this.pt();
  if (pt > h.w) { h.w = pt; h.c = 0; } else h.c++;
  return hlcStr(h.w, h.c, this.node);
};
Clock.prototype.recv = function (str) {
  var r = hlcParse(str), h = this.st.sync.hlc, pt = this.pt();
  var rw = Math.min(r.w, pt + MAX_DRIFT);                  // un sello absurdamente futuro no arrastra a este reloj
  var nw = Math.max(h.w, rw, pt), nc;
  if (nw === h.w && nw === rw) nc = Math.max(h.c, r.c) + 1;
  else if (nw === h.w) nc = h.c + 1;
  else if (nw === rw) nc = r.c + 1;
  else nc = 0;
  h.w = nw; h.c = nc;
};

/* ── estado ─────────────────────────────────────────────────────────────── */
function ensureSync(st) {
  st.sync = Object.assign({ mode: 'auto', last: 0, off: 0, dev: null, hlc: { w: 0, c: 0 }, owner: null }, st.sync || {});
  if (!st.sync.dev) st.sync.dev = rnd(6);
  if (!st.sync.hlc) st.sync.hlc = { w: 0, c: 0 };
  if (!st.meta) st.meta = {};
  if (!st.settings) st.settings = {};
  // limpieza del motor anterior
  delete st.h; delete st.tomb; delete st.sh; delete st.su;
  COLS.forEach(function (c) { (st[c] || []).forEach(function (r) { delete r.u; }); });
  return st;
}
function settingsView(st) {
  var o = {}; SETTINGS_KEYS.forEach(function (k) { if (st.settings && st.settings[k] !== undefined) o[k] = st.settings[k]; });
  return o;
}
function findRec(st, col, id) {
  if (col === 'settings') return settingsView(st);
  var arr = st[col] || [];
  for (var i = 0; i < arr.length; i++) if (arr[i].id === id) return arr[i];
  return null;
}
function putRec(st, col, rec) {
  var arr = st[col] || (st[col] = []);
  for (var i = 0; i < arr.length; i++) if (arr[i].id === rec.id) { arr[i] = rec; return; }
  arr.push(rec);
}
function removeRec(st, col, id) { st[col] = (st[col] || []).filter(function (r) { return r.id !== id; }); }

/* celdas de un registro */
function cellsOf(rec) {
  var out = {};
  Object.keys(rec).forEach(function (k) {
    if (k === 'id' || k === 'u') return;
    var v = rec[k]; if (v === undefined) return;
    if (k === 'log' && Array.isArray(v)) v.forEach(function (it) { if (it && it.id) out['log#' + it.id] = it; });
    else out[k] = v;
  });
  return out;
}
function maxT(t) { var m = ''; for (var k in t) if (t[k] > m) m = t[k]; return m; }
function aliveMeta(m) { return !m.d || maxT(m.t) > m.d; }
function aliveDoc(d) { return !d.d || maxT(d.t) > d.d; }

/* ── detectar cambios locales y sellarlos ───────────────────────────────── */
function newMeta(col) { return { col: col, h: {}, t: {}, s: {}, v: {}, d: null, ds: null }; }
function stampOne(st, clock, col, id, rec) {
  var m = st.meta[id]; if (!m) m = st.meta[id] = newMeta(col);
  if (!m.v) m.v = {};
  if (!rec) {                                              // borrado local
    if (col !== 'settings' && aliveMeta(m)) m.d = clock.tick();
    return;
  }
  var cells = cellsOf(rec);
  if (m.d && !aliveMeta(m)) {                              // el mismo id vuelve a existir tras un borrado → renovar celdas
    for (var k0 in cells) { m.t[k0] = clock.tick(); m.h[k0] = strHash(stable(cells[k0])); m.v[k0] = clone(cells[k0]); }
    return;
  }
  var k;
  for (k in cells) {
    var h = strHash(stable(cells[k]));
    if (m.h[k] !== h) { m.t[k] = clock.tick(); m.h[k] = h; m.v[k] = clone(cells[k]); }
  }
  for (k in m.h) {
    if (!(k in cells) && m.h[k] !== NULLH) { m.t[k] = clock.tick(); m.h[k] = NULLH; m.v[k] = null; }
  }
}
function stamp(st, clock) {
  ensureSync(st);
  var seen = {};
  COLS.forEach(function (col) { (st[col] || []).forEach(function (r) { seen[r.id] = 1; stampOne(st, clock, col, r.id, r); }); });
  seen[SETTINGS_ID] = 1; stampOne(st, clock, 'settings', SETTINGS_ID, settingsView(st));
  Object.keys(st.meta).forEach(function (id) { if (!seen[id]) stampOne(st, clock, st.meta[id].col, id, null); });
}

/* ── documentos ─────────────────────────────────────────────────────────── */
function normDoc(rd) { return { id: rd.id, col: rd.col, v: rd.v || 1, c: rd.c || {}, t: rd.t || {}, d: rd.d || null }; }

function mergeDocs(a, b) {
  var at = (a && a.t) || {}, bt = (b && b.t) || {}, ac = (a && a.c) || {}, bc = (b && b.c) || {};
  var out = { id: (b && b.id) || (a && a.id), col: (b && b.col) || (a && a.col), v: Math.max((a && a.v) || 1, (b && b.v) || 1), c: {}, t: {}, d: null };
  var keys = {}, k;
  for (k in at) keys[k] = 1; for (k in bt) keys[k] = 1;
  for (k in keys) {
    var ta = at[k], tb = bt[k];
    if (tb !== undefined && (ta === undefined || tb >= ta)) { out.t[k] = tb; out.c[k] = bc[k] !== undefined ? bc[k] : (ac[k] !== undefined ? ac[k] : null); }
    else { out.t[k] = ta; out.c[k] = ac[k] !== undefined ? ac[k] : (bc[k] !== undefined ? bc[k] : null); }
  }
  var da = a && a.d, db = b && b.d;
  out.d = da && db ? (da > db ? da : db) : (da || db || null);
  return out;
}
function materialize(doc) {
  var rec = { id: doc.id }, log = [];
  Object.keys(doc.c).forEach(function (k) {
    var v = doc.c[k]; if (v === null || v === undefined) return;
    if (k.indexOf('log#') === 0) log.push(clone(v)); else rec[k] = clone(v);
  });
  if (log.length) rec.log = log.sort(function (a, b) { return ((a.ts || 0) - (b.ts || 0)) || (a.id < b.id ? -1 : 1); });
  return rec;
}
function localCells(st, m, id) {
  var rec = findRec(st, m.col, id), out = {}, k;
  if (rec) { var cs = cellsOf(rec); for (k in cs) out[k] = cs[k]; for (k in m.h) if (m.h[k] === NULLH) out[k] = null; }
  for (k in (m.v || {})) if (!(k in out)) out[k] = m.v[k];
  return out;
}
function dirtyDocs(st) {
  var out = [];
  Object.keys(st.meta).forEach(function (id) {
    var m = st.meta[id], c = {}, t = {}, any = false, rec = null, cs = null;
    for (var k in m.t) if (m.t[k] !== m.s[k]) {
      var val;
      if (m.v && m.v[k] !== undefined) val = m.v[k];
      else {                                            // red de seguridad: leer el valor del registro; si no se conoce, no se envía
        if (!cs) { rec = findRec(st, m.col, id); cs = rec ? cellsOf(rec) : {}; }
        val = k in cs ? cs[k] : (m.h[k] === NULLH ? null : undefined);
      }
      if (val === undefined) continue;
      t[k] = m.t[k]; c[k] = val; any = true;
    }
    var dd = m.d && m.d !== m.ds;
    if (any || dd) out.push({ id: id, col: m.col, v: SCHEMA, c: c, t: t, d: m.d || null });
  });
  return out;
}
function dirtyCount(st) { return dirtyDocs(st).length; }

/* ── aplicar un documento que llega de fuera ────────────────────────────── */
function applyRemote(st, clock, rd, opts) {
  opts = opts || {};
  var fromServer = opts.fromServer !== false;
  if (!rd || !rd.id) return { changed: false };
  var d0 = normDoc(rd), id = d0.id;
  var mx = maxT(d0.t); if (d0.d && d0.d > mx) mx = d0.d;
  if (mx) clock.recv(mx);
  var m = st.meta[id];
  if (m) { var r0 = findRec(st, m.col, id); stampOne(st, clock, m.col, id, m.col === 'settings' ? r0 : (r0 || null)); }
  var local = m ? { id: id, col: m.col, c: localCells(st, m, id), t: m.t, d: m.d } : null;
  var merged = mergeDocs(local, d0);
  merged.id = id; merged.col = d0.col || (m && m.col);
  if (!m) m = st.meta[id] = newMeta(merged.col);
  var col = m.col;
  var before = stable(findRec(st, col, id) || null);
  m.t = merged.t; m.d = merged.d || null;
  if (fromServer) { m.s = clone(d0.t); m.ds = d0.d || null; }
  if (col === 'settings') {
    if (!st.settings) st.settings = {};
    Object.keys(merged.t).forEach(function (k) {
      if (SETTINGS_KEYS.indexOf(k) < 0) return;
      var v = merged.c[k];
      if (v === null || v === undefined) delete st.settings[k]; else st.settings[k] = clone(v);
    });
  } else if (aliveDoc(merged)) putRec(st, col, materialize(merged));
  else removeRec(st, col, id);
  // hashes de lo que quedó aplicado + limpiar valores ya confirmados
  m.h = {};
  var rec = findRec(st, col, id);
  if (rec && (col === 'settings' || aliveDoc(merged))) {
    var cs = cellsOf(rec); for (var k in cs) m.h[k] = strHash(stable(cs[k]));
    for (k in merged.t) if (merged.c[k] === null && !(k in cs)) m.h[k] = NULLH;
  }
  if (!m.v) m.v = {};
  // se guarda el valor de TODAS las celdas: así un registro borrado en este dispositivo se puede recuperar entero
  // si otro dispositivo (u otra pestaña) lo edita después, sin depender de tener que volver a pedir sus datos
  for (var tk in m.t) m.v[tk] = merged.c[tk] === undefined ? null : clone(merged.c[tk]);
  for (var vk in m.v) if (!(vk in m.t)) delete m.v[vk];
  return { changed: before !== stable(findRec(st, col, id) || null) };
}

/* ── reloj del servidor ─────────────────────────────────────────────────── */
function rebase(st, delta) {
  Object.keys(st.meta).forEach(function (id) {
    var m = st.meta[id];
    for (var k in m.t) if (m.t[k] !== m.s[k]) m.t[k] = shiftH(m.t[k], delta);
    if (m.d && m.d !== m.ds) m.d = shiftH(m.d, delta);
  });
  st.sync.hlc.w = Math.max(0, st.sync.hlc.w + delta);
}
async function syncOffset(st, clock, adapter, force) {
  if (!adapter.serverTime) return st.sync.off || 0;
  var now = clock.now();
  if (!force && st.sync.offAt && Math.abs(now - st.sync.offAt) < 600000) return st.sync.off || 0;
  var t0 = clock.now(), sv = await adapter.serverTime(), t1 = clock.now();
  var off = Math.round(sv - (t0 + t1) / 2), delta = off - (st.sync.off || 0);
  if (Math.abs(delta) >= 1000) { rebase(st, delta); st.sync.off = off; }
  st.sync.offAt = t1;
  return st.sync.off || 0;
}

/* ── operaciones de sincronización ──────────────────────────────────────── */
function schemaError() { var e = new Error('Hay datos de una versión más nueva de la app'); e.code = 'schema'; return e; }
async function pull(st, clock, adapter) {
  var docs = await adapter.fetchAll(), stat = { docs: docs.length, changed: 0, reupload: 0 }, seen = {};
  for (var i = 0; i < docs.length; i++) {
    if ((docs[i].v || 1) > SCHEMA) throw schemaError();
    seen[docs[i].id] = 1;
    if (applyRemote(st, clock, docs[i]).changed) stat.changed++;
  }
  // documentos que este dispositivo creía tener en la nube y ya no están (nube vaciada o restaurada): volver a subirlos
  Object.keys(st.meta).forEach(function (id) {
    var m = st.meta[id];
    if (!seen[id] && (m.ds || Object.keys(m.s).length)) {
      m.s = {}; m.ds = null; stat.reupload++;
      for (var k in m.t) if (!m.v) m.v = {};
      if (m.col !== 'settings') { var rec = findRec(st, m.col, id); if (rec) { var cs = cellsOf(rec); for (var c in cs) m.v[c] = clone(cs[c]); } }
      else { var sv = settingsView(st); for (var c2 in sv) m.v[c2] = clone(sv[c2]); }
    }
  });
  return stat;
}
async function push(st, clock, adapter) {
  stamp(st, clock);
  var docs = dirtyDocs(st), stat = { docs: docs.length, sent: 0, big: [] }, ok = [];
  docs.forEach(function (d) { if (docBytes(d) > MAX_DOC) stat.big.push(d.id); else ok.push(d); });
  st.sync.big = stat.big;
  for (var i = 0; i < ok.length; i += CHUNK) {
    var part = ok.slice(i, i + CHUNK), res = await adapter.commit(part);
    for (var j = 0; j < res.length; j++) applyRemote(st, clock, res[j]);
    stat.sent += part.length;
  }
  return stat;
}
async function sync(st, clock, adapter) {
  await syncOffset(st, clock, adapter);
  var a = await pull(st, clock, adapter), b = await push(st, clock, adapter);
  st.sync.last = clock.pt();
  return { pulled: a.changed, docs: a.docs, sent: b.sent, big: b.big };
}
async function gc(st, clock, adapter) {
  var now = clock.pt(), ids = [];
  Object.keys(st.meta).forEach(function (id) {
    var m = st.meta[id]; if (m.col === 'settings') return;
    if (m.d && m.d === m.ds && !aliveMeta(m) && now - hlcParse(m.d).w > GC_AFTER) ids.push(id);
  });
  if (!ids.length) return 0;
  if (adapter.deleteDocs) await adapter.deleteDocs(ids);
  ids.forEach(function (id) { delete st.meta[id]; });
  return ids.length;
}

/* dejar este dispositivo idéntico a la nube (descarta lo local) */
function mirrorFromRemote(st, clock, docs) {
  COLS.forEach(function (c) { st[c] = []; }); st.meta = {};
  docs.forEach(function (d) { applyRemote(st, clock, d); });
}
/* dejar la nube idéntica a este dispositivo */
async function overwriteRemote(st, clock, adapter) {
  var docs = await adapter.fetchAll(), local = {};
  stamp(st, clock);
  COLS.forEach(function (c) { (st[c] || []).forEach(function (r) { local[r.id] = c; }); });
  Object.keys(st.meta).forEach(function (id) {
    var m = st.meta[id];
    if (m.col === 'settings' || local[id]) {
      var rec = findRec(st, m.col, id), cs = rec ? cellsOf(rec) : {};
      for (var k in cs) { m.t[k] = clock.tick(); m.v[k] = clone(cs[k]); m.h[k] = strHash(stable(cs[k])); }
    }
  });
  docs.forEach(function (raw) {
    var d = normDoc(raw);
    if (d.col !== 'settings' && !local[d.id] && aliveDoc(d)) { var m = st.meta[d.id] || (st.meta[d.id] = newMeta(d.col)); m.d = clock.tick(); }
  });
  return push(st, clock, adapter);
}

/* fusionar el estado guardado por otra pestaña del mismo navegador */
function mergeState(st, clock, other) {
  if (!other || !other.meta) return 0;
  var n = 0;
  Object.keys(other.meta).forEach(function (id) {
    var om = other.meta[id], rec = om.col === 'settings' ? settingsView(other) : findRec(other, om.col, id), c = {}, k;
    if (rec) { var cs = cellsOf(rec); for (k in cs) c[k] = cs[k]; for (k in om.h) if (om.h[k] === NULLH) c[k] = null; }
    for (k in (om.v || {})) if (!(k in c)) c[k] = om.v[k];
    var r = applyRemote(st, clock, { id: id, col: om.col, v: SCHEMA, c: c, t: om.t, d: om.d }, { fromServer: false });
    var m = st.meta[id];
    if (m) { for (k in m.t) if (om.s && om.s[k] === om.t[k] && m.t[k] === om.t[k]) m.s[k] = om.t[k]; if (m.d && om.ds === m.d) m.ds = om.ds; }
    if (r.changed) n++;
  });
  return n;
}

/* vista previa de diferencias frente a lo último que se sabe de la nube */
function previewDiff(st, remote) {
  var items = [], ids = {}, id;
  for (id in st.meta) ids[id] = 1; for (id in remote) ids[id] = 1;
  for (id in ids) {
    var m = st.meta[id], rd = remote[id] ? normDoc(remote[id]) : null, up = 0, down = 0, k;
    if (m) { for (k in m.t) if (m.t[k] !== m.s[k]) up++; }
    var upDel = !!(m && m.d && m.d !== m.ds);
    if (rd) {
      var lt = m ? m.t : {};
      for (k in rd.t) if (!lt[k] || rd.t[k] > lt[k]) down++;
      var downDel = !!(rd.d && (!m || !m.d || rd.d > m.d));
      if (downDel) down++;
    }
    if (up || down || upDel) items.push({ id: id, col: (m && m.col) || (rd && rd.col), up: up, down: down, delUp: upDel, delDown: !!(rd && rd.d && (!m || !m.d || rd.d > m.d)) });
  }
  return items;
}

/* clasificar errores de red / Firebase */
function classifyError(e) {
  var c = (e && (e.code || e.name) || '') + '';
  if (/schema/.test(c)) return 'schema';
  if (/permission|unauthenticated|auth\//.test(c)) return 'auth';
  if (/unavailable|deadline|aborted|resource-exhausted|internal|network|offline|timeout/.test(c) || (e && /offline|network|timeout|failed to fetch/i.test(e.message || ''))) return 'retry';
  if (/invalid-argument|out-of-range|failed-precondition/.test(c)) return 'data';
  return 'retry';
}
function backoff(n) { return Math.min(60000, 1000 * Math.pow(2, Math.min(n, 6))) * (0.75 + Math.random() * 0.5); }

/* ════════════════════════ Adaptadores ═══════════════════════════════════════ */

/* Nube simulada en memoria (pruebas) o respaldada por almacenamiento (demo) */
function FakeCloud(opts) {
  opts = opts || {};
  this.docs = {}; this.rev = 0; this.subs = [];
  this.now = opts.now || function () { return Date.now(); };
  this.store = opts.store || null;           // { get(): string|null, set(string) }
  if (this.store) this._load();
}
FakeCloud.prototype._load = function () { try { var r = this.store.get(); if (r) { var o = JSON.parse(r); this.docs = o.docs || {}; this.rev = o.rev || 0; } } catch (e) {} };
FakeCloud.prototype._save = function () { if (this.store) try { this.store.set(JSON.stringify({ docs: this.docs, rev: this.rev })); } catch (e) {} };
FakeCloud.prototype._notify = function (from, ids) {
  var self = this;
  this.subs.forEach(function (s) { if (s.name !== from || s.self) { var docs = ids.map(function (id) { return clone(self.docs[id]); }); Promise.resolve().then(function () { s.cb(docs, { fromCache: false }); }); } });
};
FakeCloud.prototype.clear = function () { this.docs = {}; this._save(); };
FakeCloud.prototype.adapter = function (name, opts) { return new FakeAdapter(this, name, opts); };

function FakeAdapter(cloud, name, o) { this.cloud = cloud; this.name = name; this.o = o || {}; this.kind = 'fake'; }
FakeAdapter.prototype._net = async function (kind) {
  if (this.o.latency) await new Promise(function (r) { setTimeout(r, this.o.latency); }.bind(this));
  if (this.o.offline) { var e = new Error('offline'); e.code = 'unavailable'; throw e; }
  if (this.o.fail && this.o.fail(kind, this)) { var e2 = new Error('fallo simulado en ' + kind); e2.code = 'unavailable'; throw e2; }
};
FakeAdapter.prototype.serverTime = async function () { await this._net('time'); return this.cloud.now(); };
FakeAdapter.prototype.fetchAll = async function () { await this._net('fetch'); this.cloud._load(); return clone(Object.values(this.cloud.docs)); };
FakeAdapter.prototype.commit = async function (docs) {
  await this._net('commit-before');
  var c = this.cloud, out = [], ids = [];
  c._load();
  docs.forEach(function (p) { var m = mergeDocs(c.docs[p.id] || null, p); m.rev = ++c.rev; c.docs[p.id] = m; out.push(clone(m)); ids.push(p.id); });
  c._save(); c._notify(this.name, ids);
  await this._net('commit-after');             // la respuesta puede perderse aunque la escritura ya esté hecha
  return out;
};
FakeAdapter.prototype.deleteDocs = async function (ids) { await this._net('delete'); var c = this.cloud; ids.forEach(function (id) { delete c.docs[id]; }); c._save(); };
FakeAdapter.prototype.subscribe = function (cb) {
  var self = this, s = { name: this.name, cb: cb, self: !!this.o.echo };
  this.cloud.subs.push(s);
  Promise.resolve().then(function () { if (self.o.offline) return; cb(clone(Object.values(self.cloud.docs)), { fromCache: false }); });
  return function () { self.cloud.subs = self.cloud.subs.filter(function (x) { return x !== s; }); };
};

/* Firestore real. `fs` es el módulo firebase/firestore (o su equivalente en gstatic) */
function makeFirestoreAdapter(fs, db, uid, opts) {
  opts = opts || {};
  var col = fs.collection(db, 'users', uid, 'records');
  var timeout = opts.timeout || 20000;
  function withTimeout(p, ms) {
    return new Promise(function (res, rej) {
      var t = setTimeout(function () { var e = new Error('timeout'); e.code = 'deadline-exceeded'; rej(e); }, ms);
      p.then(function (v) { clearTimeout(t); res(v); }, function (e) { clearTimeout(t); rej(e); });
    });
  }
  function toFs(d) { var o = { col: d.col, v: d.v || SCHEMA, c: d.c, t: d.t, rev: fs.serverTimestamp() }; if (d.d) o.d = d.d; return o; }
  function fromFs(data, id) { return { id: id, col: data.col, v: data.v || 1, c: data.c || {}, t: data.t || {}, d: data.d || null }; }
  return {
    kind: 'firestore',
    serverTime: function () {
      var ref = fs.doc(db, 'users', uid, 'meta', 'clock');
      return withTimeout(fs.setDoc(ref, { t: fs.serverTimestamp() }).then(function () { return fs.getDocFromServer(ref); }).then(function (s) { return s.data().t.toMillis(); }), timeout);
    },
    fetchAll: function () {
      return withTimeout(fs.getDocsFromServer(col).then(function (snap) { return snap.docs.map(function (x) { return fromFs(x.data(), x.id); }); }), timeout);
    },
    commit: function (docs) {
      return withTimeout(fs.runTransaction(db, async function (tx) {
        var refs = docs.map(function (p) { return fs.doc(col, p.id); });
        var snaps = await Promise.all(refs.map(function (r) { return tx.get(r); }));
        var out = docs.map(function (p, i) { return mergeDocs(snaps[i].exists() ? fromFs(snaps[i].data(), p.id) : null, p); });
        out.forEach(function (m, i) { tx.set(refs[i], toFs(m)); });
        return out;
      }), timeout);
    },
    subscribe: function (cb, onErr) {
      return fs.onSnapshot(col, function (snap) { cb(snap.docChanges().map(function (ch) { return fromFs(ch.doc.data(), ch.doc.id); }), { fromCache: snap.metadata.fromCache }); }, function (e) { if (onErr) onErr(e); });
    },
    deleteDocs: async function (ids) {
      for (var i = 0; i < ids.length; i += 400) { var b = fs.writeBatch(db); ids.slice(i, i + 400).forEach(function (id) { b.delete(fs.doc(col, id)); }); await withTimeout(b.commit(), timeout); }
    }
  };
}

var API = {
  SCHEMA: SCHEMA, COLS: COLS, SETTINGS_ID: SETTINGS_ID, SETTINGS_KEYS: SETTINGS_KEYS, MAX_DOC: MAX_DOC, CHUNK: CHUNK,
  stable: stable, strHash: strHash, clone: clone, rnd: rnd, docBytes: docBytes,
  hlcStr: hlcStr, hlcParse: hlcParse, Clock: Clock,
  ensureSync: ensureSync, settingsView: settingsView, findRec: findRec, cellsOf: cellsOf, aliveDoc: aliveDoc, aliveMeta: aliveMeta, maxT: maxT,
  stamp: stamp, stampOne: stampOne, dirtyDocs: dirtyDocs, dirtyCount: dirtyCount, mergeDocs: mergeDocs, materialize: materialize, applyRemote: applyRemote,
  syncOffset: syncOffset, rebase: rebase, pull: pull, push: push, sync: sync, gc: gc, mirrorFromRemote: mirrorFromRemote, overwriteRemote: overwriteRemote,
  mergeState: mergeState, previewDiff: previewDiff, classifyError: classifyError, backoff: backoff,
  FakeCloud: FakeCloud, makeFirestoreAdapter: makeFirestoreAdapter
};
if (typeof module !== 'undefined' && module.exports) module.exports = API; else root.PetBaseSync = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
