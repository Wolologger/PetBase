const assert = require('assert');
const fs = require('fs');
const { initializeApp, deleteApp } = require('firebase/app');
const F = require('firebase/firestore');
const M = require('../sync/sync-engine.js');

const HOST = '127.0.0.1', PORT = 8080, PROJECT = 'demo-petbase';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const apps = [];
function client(name, uid) {
  const app = initializeApp({ projectId: PROJECT, apiKey: 'fake' }, name + Math.random());
  const db = F.getFirestore(app);
  F.connectFirestoreEmulator(db, HOST, PORT, uid ? { mockUserToken: { sub: uid, user_id: uid } } : undefined);
  apps.push(app); return db;
}
function freshState() { const st = { pets: [], entries: [], sacks: [], settings: {} }; M.ensureSync(st); return st; }
class Dev {
  constructor(name, db, uid, skew = 0) {
    this.name = name; this.skew = skew; this.st = freshState();
    this.clock = new M.Clock(this.st, () => Date.now() + this.skew, this.st.sync.dev + 't0');
    this.adapter = M.makeFirestoreAdapter(F, db, uid, { timeout: 15000 });
  }
  save() { M.stamp(this.st, this.clock); }
  rec(id) { return this.st.entries.find(e => e.id === id); }
  create(id, f) { this.st.entries.push({ id, ...f }); this.save(); }
  set(id, k, v) { const r = this.rec(id); if (!r) return false; if (k in r && M.stable(r[k]) === M.stable(v)) return false; r[k] = v; this.save(); return true; }
  unset(id, k) { const r = this.rec(id); if (!r || !(k in r)) return false; delete r[k]; this.save(); return true; }
  del(id) { if (!this.rec(id)) return false; this.st.entries = this.st.entries.filter(e => e.id !== id); this.save(); return true; }
  logAdd(id, it) { const r = this.rec(id); if (!r) return false; (r.log ||= []).push(it); this.save(); return true; }
  sync() { return M.sync(this.st, this.clock, this.adapter); }
  view() { const o = {}; this.st.entries.forEach(e => { o[e.id] = M.stable(e); }); return o; }
}
async function clearAll() { await fetch(`http://${HOST}:${PORT}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' }); }
async function loadRules() {
  const content = fs.readFileSync(__dirname + '/../firebase/firestore.rules', 'utf8');
  const r = await fetch(`http://${HOST}:${PORT}/emulator/v1/projects/${PROJECT}:securityRules`, { method: 'PUT', body: JSON.stringify({ rules: { files: [{ name: 'firestore.rules', content }] } }) });
  assert(r.ok, 'no se pudieron cargar las reglas: ' + (await r.text()));
}
async function serverDocs(db, uid) { const s = await F.getDocs(F.collection(db, 'users', uid, 'records')); return s.docs.map(d => ({ id: d.id, ...d.data() })); }
const validDoc = over => Object.assign({ col: 'entries', v: 2, c: { text: 'hola' }, t: { text: M.hlcStr(Date.now(), 0, 'n1') }, rev: F.serverTimestamp() }, over || {});
const denied = async p => { try { await p; return false; } catch (e) { return /permission|PERMISSION/i.test((e.code || '') + (e.message || '')); } };

const tests = []; const test = (n, f) => tests.push({ n, f });

/* ═════ Reglas de seguridad ═════ */
test('reglas: el dueño puede escribir y leer sus documentos', async () => {
  const db = client('own', 'user1');
  await F.setDoc(F.doc(db, 'users/user1/records/r1'), validDoc());
  const s = await F.getDoc(F.doc(db, 'users/user1/records/r1')); assert(s.exists());
});
test('reglas: otro usuario y un usuario sin sesión no pueden leer ni escribir', async () => {
  const db1 = client('o1', 'user1'), db2 = client('o2', 'user2'), dbN = client('n');
  await F.setDoc(F.doc(db1, 'users/user1/records/r2'), validDoc());
  assert(await denied(F.getDoc(F.doc(db2, 'users/user1/records/r2'))), 'lectura ajena');
  assert(await denied(F.setDoc(F.doc(db2, 'users/user1/records/r2'), validDoc())), 'escritura ajena');
  assert(await denied(F.getDoc(F.doc(dbN, 'users/user1/records/r2'))), 'lectura sin sesión');
  assert(await denied(F.setDoc(F.doc(dbN, 'users/user1/records/r9'), validDoc())), 'escritura sin sesión');
  assert(await denied(F.getDocs(F.collection(db2, 'users/user1/records'))), 'listado ajeno');
});
test('reglas: se rechazan documentos mal formados (colección, versión, campos extra, rev sin servidor)', async () => {
  const db = client('bad', 'user1'), ref = id => F.doc(db, 'users/user1/records/' + id);
  assert(await denied(F.setDoc(ref('b1'), validDoc({ col: 'otra' }))), 'col inválida');
  assert(await denied(F.setDoc(ref('b2'), validDoc({ v: 1 }))), 'versión 1');
  assert(await denied(F.setDoc(ref('b3'), validDoc({ extra: 1 }))), 'campo extra');
  assert(await denied(F.setDoc(ref('b4'), validDoc({ rev: new Date() }))), 'rev con la hora del dispositivo');
  assert(await denied(F.setDoc(ref('b5'), validDoc({ c: 'texto' }))), 'c no es un mapa');
  assert(await denied(F.setDoc(ref('b6'), validDoc({ d: 5 }))), 'd no es texto');
  await F.setDoc(ref('ok'), validDoc({ d: M.hlcStr(Date.now(), 1, 'z') }));
});
test('reglas: el documento del reloj solo acepta la hora del servidor', async () => {
  const db = client('clk', 'user1'), ref = F.doc(db, 'users/user1/meta/clock');
  assert(await denied(F.setDoc(ref, { t: new Date() })));
  await F.setDoc(ref, { t: F.serverTimestamp() });
  assert(await denied(F.setDoc(F.doc(db, 'users/user1/meta/otro'), { t: F.serverTimestamp() })), 'otro documento en meta');
});
test('reglas: cualquier otra ruta está cerrada', async () => {
  const db = client('other', 'user1');
  assert(await denied(F.setDoc(F.doc(db, 'publico/x'), { a: 1 }))); assert(await denied(F.getDoc(F.doc(db, 'publico/x'))));
});

/* ═════ Adaptador ═════ */
test('adaptador: serverTime devuelve la hora del servidor (±1 s)', async () => {
  const a = M.makeFirestoreAdapter(F, client('st', 'user1'), 'user1'); const t = await a.serverTime(); assert(Math.abs(t - Date.now()) < 1000, 'dif ' + (t - Date.now()));
});
test('adaptador: commit fusiona en el servidor dentro de una transacción (dos dispositivos a la vez, celdas distintas)', async () => {
  await clearAll();
  const a = M.makeFirestoreAdapter(F, client('ta', 'user1'), 'user1'), b = M.makeFirestoreAdapter(F, client('tb', 'user1'), 'user1');
  const t = (w, n) => M.hlcStr(1_790_000_000_000 + w, 0, n);
  await a.commit([{ id: 'x1', col: 'entries', v: 2, c: { text: 'base', time: '10:00' }, t: { text: t(1, 'a'), time: t(1, 'a') }, d: null }]);
  await Promise.all([
    a.commit([{ id: 'x1', col: 'entries', v: 2, c: { text: 'de A' }, t: { text: t(10, 'a') }, d: null }]),
    b.commit([{ id: 'x1', col: 'entries', v: 2, c: { time: '23:59' }, t: { time: t(11, 'b') }, d: null }])
  ]);
  const docs = await a.fetchAll(); const x = docs.find(d => d.id === 'x1');
  assert.strictEqual(x.c.text, 'de A'); assert.strictEqual(x.c.time, '23:59');
});
test('adaptador: una escritura vieja que llega tarde NO pisa una celda más reciente (orden por sello, no por llegada)', async () => {
  const a = M.makeFirestoreAdapter(F, client('la', 'user1'), 'user1'), t = (w, n) => M.hlcStr(1_790_000_000_000 + w, 0, n);
  await a.commit([{ id: 'late', col: 'entries', v: 2, c: { text: 'reciente' }, t: { text: t(50, 'a') }, d: null }]);
  const r = await a.commit([{ id: 'late', col: 'entries', v: 2, c: { text: 'antigua que llega tarde' }, t: { text: t(5, 'b') }, d: null }]);
  assert.strictEqual(r[0].c.text, 'reciente'); const d = (await a.fetchAll()).find(x => x.id === 'late'); assert.strictEqual(d.c.text, 'reciente');
});
test('adaptador: 20 escrituras concurrentes sobre el mismo documento no pierden ninguna celda', async () => {
  const dbs = [client('c1', 'user1'), client('c2', 'user1'), client('c3', 'user1')], ad = dbs.map(d => M.makeFirestoreAdapter(F, d, 'user1'));
  const t = (w, n) => M.hlcStr(1_790_000_000_000 + w, 0, n);
  await Promise.all(Array.from({ length: 20 }, (_, i) => ad[i % 3].commit([{ id: 'hot', col: 'entries', v: 2, c: { ['f' + i]: 'v' + i }, t: { ['f' + i]: t(i + 1, 'n' + (i % 3)) }, d: null }])));
  const d = (await ad[0].fetchAll()).find(x => x.id === 'hot'); assert.strictEqual(Object.keys(d.c).length, 20);
});
test('adaptador: subscribe entrega los cambios de otro dispositivo en tiempo real', async () => {
  const a = M.makeFirestoreAdapter(F, client('sa', 'user1'), 'user1'), b = M.makeFirestoreAdapter(F, client('sb', 'user1'), 'user1'), got = [];
  const off = a.subscribe(docs => docs.forEach(d => got.push(d.id)));
  await sleep(600); const t0 = Date.now();
  await b.commit([{ id: 'live1', col: 'entries', v: 2, c: { text: 'en vivo' }, t: { text: M.hlcStr(Date.now(), 0, 'b') }, d: null }]);
  for (let i = 0; i < 40 && !got.includes('live1'); i++) await sleep(50);
  off(); assert(got.includes('live1'), 'no llegó'); console.log('      · latencia hasta el otro dispositivo: ' + (Date.now() - t0) + ' ms');
});
test('adaptador: errores del SDK se clasifican (permiso → auth)', async () => {
  const a = M.makeFirestoreAdapter(F, client('ea', 'user1'), 'user2');
  try { await a.fetchAll(); assert.fail('debía fallar'); } catch (e) { assert.strictEqual(M.classifyError(e), 'auth'); }
  try { await a.commit([{ id: 'z', col: 'entries', v: 2, c: {}, t: {}, d: null }]); assert.fail('debía fallar'); } catch (e) { assert.strictEqual(M.classifyError(e), 'auth'); }
});

/* ═════ Motor completo contra Firestore ═════ */
test('E2E: dos dispositivos, uno con el reloj 2 h atrasado y otro 3 h adelantado: gana la edición más reciente', async () => {
  await clearAll();
  const a = new Dev('a', client('ea1', 'u9'), 'u9', -2 * 3600e3), b = new Dev('b', client('eb1', 'u9'), 'u9', +3 * 3600e3), c = new Dev('c', client('ec1', 'u9'), 'u9', 0);
  a.create('e1', { type: 'nota', text: 'base', time: '10:00' }); await a.sync(); await b.sync(); await c.sync();
  await sleep(80); a.set('e1', 'text', 'A (primero)'); await sleep(80); b.set('e1', 'text', 'B (segundo)'); await sleep(80); c.set('e1', 'time', '23:59'); await sleep(80); a.set('e1', 'text', 'A (el último)');
  for (const d of [b, c, a, b, c]) await d.sync();
  for (const d of [a, b, c]) { assert.strictEqual(d.rec('e1').text, 'A (el último)', d.name); assert.strictEqual(d.rec('e1').time, '23:59', d.name); }
  assert.strictEqual(M.dirtyCount(a.st) + M.dirtyCount(b.st) + M.dirtyCount(c.st), 0);
});
test('E2E: notas de seguimiento a la vez, borrado y recuperación, ajustes', async () => {
  await clearAll();
  const a = new Dev('a', client('ea2', 'u8'), 'u8', 0), b = new Dev('b', client('eb2', 'u8'), 'u8', 47 * 60e3);
  a.create('v1', { type: 'vet', title: 'Revisión' }); await a.sync(); await b.sync();
  await sleep(60); a.logAdd('v1', { id: 'na', ts: Date.now(), text: 'A' }); await sleep(60); b.logAdd('v1', { id: 'nb', ts: Date.now(), text: 'B' });
  await a.sync(); await b.sync(); await a.sync();
  assert.deepStrictEqual(a.rec('v1').log.map(x => x.id).sort(), ['na', 'nb']); assert.deepStrictEqual(b.rec('v1').log.map(x => x.id).sort(), ['na', 'nb']);
  await sleep(60); b.del('v1'); await sleep(60); a.set('v1', 'title', 'Revisión (editada tras borrar)');
  await a.sync(); await b.sync(); await a.sync(); assert(a.rec('v1') && b.rec('v1')); assert.strictEqual(b.rec('v1').title, 'Revisión (editada tras borrar)');
  a.st.settings.palette = 'oceano'; a.st.settings.theme = 'dark'; a.save(); await a.sync(); await b.sync();
  assert.strictEqual(b.st.settings.palette, 'oceano'); assert.strictEqual(b.st.settings.theme, undefined);
});
test('E2E: 130 registros (varios lotes/transacciones) y un tercer dispositivo que llega después', async () => {
  await clearAll();
  const a = new Dev('a', client('ea3', 'u7'), 'u7'), c = new Dev('c', client('ec3', 'u7'), 'u7', -30 * 60e3);
  for (let i = 0; i < 130; i++) a.st.entries.push({ id: 'n' + i, type: 'nota', text: 't' + i, petIds: ['p1'] }); a.save();
  const t0 = Date.now(); await a.sync(); const tUp = Date.now() - t0;
  const t1 = Date.now(); await c.sync(); const tDown = Date.now() - t1;
  assert.deepStrictEqual(c.view(), a.view()); console.log(`      · 130 registros: subir ${tUp} ms, bajar ${tDown} ms`);
});
test('E2E: tiempo real — el motor aplica lo que llega por la suscripción y no se pisa con lo pendiente', async () => {
  await clearAll();
  const a = new Dev('a', client('ea4', 'u6'), 'u6'), b = new Dev('b', client('eb4', 'u6'), 'u6', 20 * 60e3);
  a.create('r1', { type: 'nota', text: 'base', time: '09:00' }); await a.sync(); await b.sync();
  await a.sync();
  const off = b.adapter.subscribe(docs => docs.forEach(d => M.applyRemote(b.st, b.clock, d)));
  await sleep(500);
  b.set('r1', 'time', '11:11');                                  // edición local pendiente de subir
  await sleep(60); a.set('r1', 'text', 'texto de A'); await a.sync();
  for (let i = 0; i < 40 && b.rec('r1').text !== 'texto de A'; i++) await sleep(50);
  assert.strictEqual(b.rec('r1').text, 'texto de A'); assert.strictEqual(b.rec('r1').time, '11:11', 'la edición pendiente sigue');
  await b.sync(); await a.sync(); off(); assert.strictEqual(a.rec('r1').time, '11:11');
});
test('E2E: recuperación tras corte — con el servidor inaccesible los cambios esperan y luego se suben', async () => {
  await clearAll();
  const good = client('ea5', 'u5'), a = new Dev('a', good, 'u5');
  a.create('q1', { type: 'nota', text: 'offline' }); await a.sync();
  // adaptador roto (puerto inexistente) para simular corte
  const app = initializeApp({ projectId: PROJECT, apiKey: 'fake' }, 'broken' + Math.random()); const bad = F.getFirestore(app); F.connectFirestoreEmulator(bad, HOST, 1, { mockUserToken: { sub: 'u5' } }); apps.push(app);
  const brokenAd = M.makeFirestoreAdapter(F, bad, 'u5', { timeout: 3000 }), realAd = a.adapter;
  a.set('q1', 'text', 'editado sin conexión'); a.adapter = brokenAd;
  let err; try { await a.sync(); } catch (e) { err = e; } assert(err, 'debía fallar'); assert(['retry'].includes(M.classifyError(err)), 'clasificación: ' + M.classifyError(err) + ' ' + err.code);
  assert(M.dirtyCount(a.st) > 0); a.adapter = realAd; await a.sync(); assert.strictEqual(M.dirtyCount(a.st), 0);
  const d = (await realAd.fetchAll()).find(x => x.id === 'q1'); assert.strictEqual(d.c.text, 'editado sin conexión');
});
test('E2E: fuzz con oráculo contra Firestore (12 historias, relojes desajustados, ediciones concurrentes)', async () => {
  const rand = seed => { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
  for (let seed = 1; seed <= 12; seed++) {
    await clearAll(); const rnd = rand(seed), uid = 'fz' + seed, skews = [0, -3 * 3600e3, 2 * 3600e3].sort(() => rnd() - .5);
    const devs = skews.map((sk, i) => new Dev('d' + i, client('f' + seed + i, uid), uid, sk));
    const oracle = {}, pick = a => a[Math.floor(rnd() * a.length)]; let n = 0, nl = 0; const ids = [];
    const cell = (id, k, v, t) => { (oracle[id] ||= { c: {}, d: 0 }).c[k] = { v, t }; };
    for (let s = 0; s < 40; s++) {
      await sleep(45); const d = pick(devs), x = rnd(), T = () => Date.now();
      if (x < .15 || !ids.length) { const id = 'r' + (n++), f = { type: 'nota', text: 't' + s, time: '08:00', done: false }; d.create(id, f); const t = T(); Object.keys(f).forEach(k => cell(id, k, f[k], t)); ids.push(id); }
      else if (x < .50) { const id = pick(ids), k = pick(['text', 'time', 'done']), v = k === 'done' ? rnd() < .5 : k + s; if (d.set(id, k, v)) cell(id, k, v, T()); }
      else if (x < .58) { const id = pick(ids); if (d.del(id)) oracle[id].d = Math.max(oracle[id].d, T()); }
      else if (x < .70) { const id = pick(ids), it = { id: 'l' + (nl++), ts: T(), text: 's' + s }; if (d.logAdd(id, it)) cell(id, 'log#' + it.id, it, T()); }
      else { try { await d.sync(); } catch (e) { throw e; } }
    }
    for (let r = 0; r < 3; r++) for (const d of devs) await d.sync();
    const exp = {}; Object.keys(oracle).forEach(id => { const o = oracle[id]; let mx = 0; Object.values(o.c).forEach(c => { if (c.t > mx) mx = c.t; }); if (!(o.d === 0 || mx > o.d)) return; const rec = { id }, log = []; Object.keys(o.c).forEach(k => { const v = o.c[k].v; if (v === null) return; if (k.startsWith('log#')) log.push(v); else rec[k] = v; }); if (log.length) rec.log = log.sort((a, b) => (a.ts - b.ts) || (a.id < b.id ? -1 : 1)); exp[id] = M.stable(rec); });
    for (const d of devs) assert.deepStrictEqual(d.view(), exp, `semilla ${seed}: ${d.name} (reloj ${d.skew / 60000} min)`);
    const sv = {}; (await serverDocs(client('chk' + seed, uid), uid)).forEach(d => { if (d.col === 'entries' && M.aliveDoc(M.normDoc ? M.normDoc(d) : d)) sv[d.id] = M.stable(M.materialize({ id: d.id, c: d.c, t: d.t, d: d.d || null })); });
    assert.deepStrictEqual(sv, exp, `semilla ${seed}: la nube difiere`);
  }
});

(async () => {
  await loadRules();
  let pass = 0, fail = 0;
  for (const t of tests) {
    try { await t.f(); pass++; console.log('  ✓', t.n); } catch (e) { fail++; console.log('  ✗', t.n, '\n     ', String(e.stack || e).split('\n').slice(0, 7).join('\n      ')); }
  }
  console.log(`\n${pass} correctas, ${fail} con fallo`);
  for (const a of apps) { try { await deleteApp(a); } catch (e) {} }
  process.exit(fail ? 1 : 0);
})();
