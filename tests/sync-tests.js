const assert = require('assert');
const M = require(process.env.ENGINE || '../sync/sync-engine.js');

const world = { t: 1_790_000_000_000 };
const adv = ms => { world.t += ms; };
let R = 0;
const rand = seed => { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };

function freshState() { const st = { pets: [], entries: [], sacks: [], settings: {} }; M.ensureSync(st); return st; }
class Dev {
  constructor(name, cloud, skew = 0, ao = {}) { this.name = name; this.cloud = cloud; this.skew = skew; this.ao = ao; this.st = freshState(); this.boot(true); }
  boot(first) {
    if (!first) this.st = JSON.parse(JSON.stringify(this.st));
    M.ensureSync(this.st);
    this.clock = new M.Clock(this.st, () => world.t + this.skew, this.st.sync.dev + 't0');
    this.adapter = this.cloud.adapter(this.name, this.ao);
  }
  save() { M.stamp(this.st, this.clock); }
  rec(id) { return this.st.entries.find(e => e.id === id); }
  create(id, f) { this.st.entries.push({ id, ...f }); this.save(); }
  set(id, k, v) { const r = this.rec(id); if (!r) return false; if (k in r && M.stable(r[k]) === M.stable(v)) return false; r[k] = v; this.save(); return true; }   // un cambio a un valor idéntico no es una edición
  unset(id, k) { const r = this.rec(id); if (!r || !(k in r)) return false; delete r[k]; this.save(); return true; }
  del(id) { if (!this.rec(id)) return false; this.st.entries = this.st.entries.filter(e => e.id !== id); this.save(); return true; }
  logAdd(id, it) { const r = this.rec(id); if (!r) return false; (r.log ||= []).push(it); this.save(); return true; }
  logDel(id, iid) { const r = this.rec(id); if (!r || !r.log || !r.log.some(x => x.id === iid)) return false; r.log = r.log.filter(x => x.id !== iid); this.save(); return true; }
  setting(k, v) { if (v === undefined) delete this.st.settings[k]; else this.st.settings[k] = v; this.save(); }
  async sync() { return M.sync(this.st, this.clock, this.adapter); }
  view() { const o = {}; this.st.entries.forEach(e => { o[e.id] = M.stable(e); }); return o; }
  sview() { return M.stable(M.settingsView(this.st)); }
}
const mkCloud = () => new M.FakeCloud({ now: () => world.t });
const cloudView = cloud => {
  const o = {}; Object.values(cloud.docs).forEach(d => { if (d.col === 'entries' && M.aliveDoc(d)) o[d.id] = M.stable(M.materialize(d)); }); return o;
};

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/* ───────── unitarias ───────── */
test('HLC: orden estricto, recv adelanta el reloj y el sello futuro absurdo no lo arrastra', () => {
  const st = freshState(), c = new M.Clock(st, () => world.t, 'n1');
  const a = c.tick(), b = c.tick(); assert(b > a);
  const far = M.hlcStr(world.t + 3 * 864e5, 0, 'x'); c.recv(far);
  assert(st.sync.hlc.w <= world.t + 6 * 3600e3 + 5, 'no debe pasar del límite de deriva');
  assert(c.tick() > b);
});
test('mergeDocs: conmutativa, asociativa e idempotente con documentos aleatorios', () => {
  const r = rand(7);
  const mk = () => { const t = {}, c = {}; for (let i = 0; i < 6; i++) if (r() < .6) { const k = 'f' + i; t[k] = M.hlcStr(1e12 + Math.floor(r() * 50), Math.floor(r() * 3), 'n' + Math.floor(r() * 3)); const h = parseInt(M.strHash(k + t[k]), 36); c[k] = h % 5 === 0 ? null : 'v' + (h % 997); } return { id: 'x', col: 'entries', v: 2, c, t, d: r() < .3 ? M.hlcStr(1e12 + Math.floor(r() * 50), 0, 'z') : null }; };
  const eq = (a, b) => assert.strictEqual(M.stable({ c: a.c, t: a.t, d: a.d }), M.stable({ c: b.c, t: b.t, d: b.d }));
  for (let i = 0; i < 400; i++) {
    const a = mk(), b = mk(), c = mk();
    eq(M.mergeDocs(a, b), M.mergeDocs(b, a));
    eq(M.mergeDocs(M.mergeDocs(a, b), c), M.mergeDocs(a, M.mergeDocs(b, c)));
    eq(M.mergeDocs(M.mergeDocs(a, b), b), M.mergeDocs(a, b));
    eq(M.mergeDocs(a, a), a);
  }
});
test('stamp: solo se sellan las celdas que cambian; borrar crea lápida; volver a crear el id la anula', () => {
  const cloud = mkCloud(), d = new Dev('a', cloud);
  d.create('e1', { type: 'nota', text: 'hola', time: '10:00' });
  const t0 = JSON.stringify(d.st.meta.e1.t);
  d.save(); assert.strictEqual(JSON.stringify(d.st.meta.e1.t), t0, 'sin cambios no hay sellos nuevos');
  adv(10); d.set('e1', 'text', 'adiós');
  assert.notStrictEqual(d.st.meta.e1.t.text, JSON.parse(t0).text); assert.strictEqual(d.st.meta.e1.t.time, JSON.parse(t0).time, 'la celda intacta conserva su sello');
  adv(10); d.del('e1'); assert(d.st.meta.e1.d); assert(!M.aliveMeta(d.st.meta.e1));
  adv(10); d.create('e1', { type: 'nota', text: 'adiós', time: '10:00' }); assert(M.aliveMeta(d.st.meta.e1), 'recrear el id lo resucita');
});
test('sincronización básica: subir, bajar, idempotencia', async () => {
  const cloud = mkCloud(), a = new Dev('a', cloud), b = new Dev('b', cloud);
  a.create('e1', { type: 'nota', text: 'uno' }); await a.sync(); await b.sync();
  assert.deepStrictEqual(b.view(), a.view());
  const s = await b.sync(); assert.strictEqual(s.pulled, 0); assert.strictEqual(s.sent, 0);
  assert.strictEqual(M.dirtyCount(a.st), 0);
});

/* ───────── los fallos detectados en el motor anterior ───────── */
test('FALLO 1 corregido: campos distintos del mismo registro editados sin conexión se conservan los dos', async () => {
  const cloud = mkCloud(), a = new Dev('a', cloud), b = new Dev('b', cloud);
  a.create('e1', { type: 'nota', text: 'base', time: '10:00' }); await a.sync(); await b.sync();
  adv(1000); a.set('e1', 'text', 'TEXTO de A'); adv(1000); b.set('e1', 'time', '23:59');
  await a.sync(); await b.sync(); await a.sync();
  for (const d of [a, b]) { assert.strictEqual(d.rec('e1').text, 'TEXTO de A'); assert.strictEqual(d.rec('e1').time, '23:59'); }
});
test('FALLO 2 corregido: con el reloj de un dispositivo 2 h atrasado gana la edición más reciente', async () => {
  const cloud = mkCloud(), a = new Dev('a', cloud, 0), b = new Dev('b', cloud, -2 * 3600e3);
  a.create('e1', { type: 'nota', text: 'base' }); await a.sync(); await b.sync();
  adv(1000); a.set('e1', 'text', 'A primero'); adv(60000); b.set('e1', 'text', 'B DESPUÉS');
  await b.sync(); await a.sync(); await b.sync();
  assert.strictEqual(a.rec('e1').text, 'B DESPUÉS'); assert.strictEqual(b.rec('e1').text, 'B DESPUÉS');
});
test('FALLO 2b corregido: reloj adelantado 3 h y ediciones hechas SIN conexión antes de la primera conexión', async () => {
  const cloud = mkCloud(), a = new Dev('a', cloud, 0), b = new Dev('b', cloud, +3 * 3600e3);
  a.create('e1', { type: 'nota', text: 'base' }); await a.sync(); await b.sync();
  b.ao.offline = true; b.boot(); adv(1000); b.set('e1', 'text', 'B offline (antes)');
  adv(60000); a.set('e1', 'text', 'A online (después)'); await a.sync();
  b.ao.offline = false; b.boot(); b.st.sync.offAt = 0; b.st.sync.off = 0;      // el offset se aprenderá al reconectar
  await b.sync(); await a.sync();
  assert.strictEqual(a.rec('e1').text, 'A online (después)'); assert.strictEqual(b.rec('e1').text, 'A online (después)');
});
test('FALLO 3 corregido: dos notas de seguimiento añadidas a la vez se conservan y se pueden borrar por separado', async () => {
  const cloud = mkCloud(), a = new Dev('a', cloud), b = new Dev('b', cloud);
  a.create('v1', { type: 'vet', title: 'Revisión', log: [{ id: 'n0', ts: 1, text: 'previa' }] }); await a.sync(); await b.sync();
  adv(1000); a.logAdd('v1', { id: 'na', ts: world.t, text: 'nota de A' }); adv(1000); b.logAdd('v1', { id: 'nb', ts: world.t, text: 'nota de B' });
  await a.sync(); await b.sync(); await a.sync();
  for (const d of [a, b]) assert.deepStrictEqual(d.rec('v1').log.map(x => x.id).sort(), ['n0', 'na', 'nb']);
  adv(1000); a.logDel('v1', 'n0'); await a.sync(); await b.sync();
  assert.deepStrictEqual(b.rec('v1').log.map(x => x.id).sort(), ['na', 'nb']);
});
test('FALLO 4 corregido: editar después de borrar recupera el registro; editar antes de borrar no', async () => {
  const cloud = mkCloud(), a = new Dev('a', cloud), b = new Dev('b', cloud, +3 * 3600e3);
  a.create('e1', { type: 'nota', text: 'base' }); a.create('e2', { type: 'nota', text: 'base2' }); await a.sync(); await b.sync();
  adv(1000); b.del('e1');                                     // B borra e1 …
  adv(1000); a.set('e1', 'text', 'A edita DESPUÉS del borrado');   // … y A lo edita después
  adv(1000); a.set('e2', 'text', 'A edita ANTES del borrado');
  adv(1000); b.del('e2');
  await a.sync(); await b.sync(); await a.sync(); await b.sync();
  assert(a.rec('e1') && b.rec('e1'), 'e1 recuperado en los dos'); assert.strictEqual(a.rec('e1').text, 'A edita DESPUÉS del borrado');
  assert(!a.rec('e2') && !b.rec('e2'), 'e2 sigue borrado');
});
test('FALLO 5 corregido: dos pestañas con el mismo almacenamiento se fusionan sin perder nada', async () => {
  const cloud = mkCloud(), t1 = new Dev('tab', cloud);
  t1.create('base', { type: 'nota', text: 'común' });
  const snapshotA = JSON.parse(JSON.stringify(t1.st));                        // lo que ve la pestaña 2 al abrirse
  const t2st = JSON.parse(JSON.stringify(snapshotA)); M.ensureSync(t2st);
  const t2clock = new M.Clock(t2st, () => world.t, t2st.sync.dev + 'tX');       // node distinto por pestaña
  adv(100); t1.create('de_1', { type: 'nota', text: 'escrita en la pestaña 1' });
  adv(100); t2st.entries.push({ id: 'de_2', type: 'nota', text: 'escrita en la pestaña 2' }); M.stamp(t2st, t2clock);
  // cada pestaña recibe el evento de almacenamiento de la otra
  M.mergeState(t1.st, t1.clock, JSON.parse(JSON.stringify(t2st))); M.mergeState(t2st, t2clock, JSON.parse(JSON.stringify(t1.st)));
  for (const s of [t1.st, t2st]) assert.deepStrictEqual(s.entries.map(e => e.id).sort(), ['base', 'de_1', 'de_2']);
  assert.notStrictEqual(t1.clock.node, t2clock.node);
});
test('dos pestañas del mismo dispositivo nunca generan el mismo sello (aunque arranquen con el mismo estado)', () => {
  const st = freshState(), st2 = JSON.parse(JSON.stringify(st));
  const c1 = new M.Clock(st, () => world.t), c2 = new M.Clock(st2, () => world.t);
  assert.notStrictEqual(c1.node, c2.node);
  const a = new Set(); for (let i = 0; i < 1000; i++) a.add(c1.tick()); for (let i = 0; i < 1000; i++) assert(!a.has(c2.tick()));
});
test('varias pestañas del mismo dispositivo (fusión de estado) + sincronización: convergen y no se pierden valores', async () => {
  for (let seed = (+process.env.TABSEED || 1); seed <= (process.env.TABSEED ? +process.env.TABSEED : (+process.env.TABN || 200)); seed++) {
    const rnd = rand(seed * 31), cloud = mkCloud(); world.t = 1_790_000_000_000 + seed * 313;
    const tabs = [0, 1, 2].map(i => { const st = i ? JSON.parse(JSON.stringify(freshState())) : freshState(); return { st, i }; });
    tabs.forEach((tb, i) => { if (i) { tb.st.sync.dev = tabs[0].st.sync.dev; } tb.clock = new M.Clock(tb.st, () => world.t, tb.st.sync.dev + 'tab' + i); tb.ad = cloud.adapter('tab' + i, {}); });
    const other = new Dev('otro', cloud, 47 * 60e3), pick = a => a[Math.floor(rnd() * a.length)], ids = []; let n = 0; const oracle = new Oracle();
    const T = () => world.t;
    for (let s = 0; s < 120; s++) {
      adv(1 + Math.floor(rnd() * 2000)); const tb = pick(tabs), x = rnd();
      const rec = id => tb.st.entries.find(e => e.id === id);
      if (x < .18 || !ids.length) { const id = 'r' + (n++), f = { type: 'nota', text: 't' + s, time: '08:00', done: false, petIds: ['p1'] }; tb.st.entries.push({ id, ...f }); M.stamp(tb.st, tb.clock); oracle.create(id, f, T()); ids.push(id); }
      else if (x < .40) { const id = pick(ids), r = rec(id), k = pick(['text', 'time', 'done']); if (r) { const v = k === 'done' ? rnd() < .5 : k + s; if (!(k in r) || M.stable(r[k]) !== M.stable(v)) { r[k] = v; M.stamp(tb.st, tb.clock); oracle.cell(id, k, v, T()); } } }
      else if (x < .46) { const id = pick(ids); if (rec(id)) { tb.st.entries = tb.st.entries.filter(e => e.id !== id); M.stamp(tb.st, tb.clock); oracle.del(id, T()); } }
      else if (x < .70) { const to = pick(tabs); if (to !== tb) { M.mergeState(to.st, to.clock, JSON.parse(JSON.stringify(tb.st))); M.stamp(to.st, to.clock); } }   // evento de almacenamiento
      else if (x < .85) { try { await M.sync(tb.st, tb.clock, tb.ad); } catch (e) {} }
      else { const id = pick(ids), r = other.rec(id); if (r) { const v = 'otro' + s; if (other.set(id, 'text', v)) oracle.cell(id, 'text', v, T()); } else if (rnd() < .3) { try { await other.sync(); } catch (e) {} } }
    }
    for (let r = 0; r < 4; r++) { for (const tb of tabs) { for (const to of tabs) if (to !== tb) M.mergeState(to.st, to.clock, JSON.parse(JSON.stringify(tb.st))); await M.sync(tb.st, tb.clock, tb.ad); } await other.sync(); }
    const exp = oracle.view(), view = st => { const o = {}; st.entries.forEach(e => { o[e.id] = M.stable(e); }); return o; };
    tabs.forEach(tb => { if (M.stable(view(tb.st)) !== M.stable(exp)) { const v = view(tb.st), bad = Object.keys(exp).concat(Object.keys(v)).filter(id => exp[id] !== v[id]); const id = bad[0]; console.log('DIF en', id, '\n  oráculo', exp[id], '\n  pestaña' + tb.i, v[id], '\n  nube', JSON.stringify(cloud.docs[id]), '\n  oraculo-cells', JSON.stringify(oracle.r[id]), '\n  meta', JSON.stringify(tb.st.meta[id])); } });
    tabs.forEach(tb => assert.deepStrictEqual(view(tb.st), exp, `semilla ${seed}: pestaña ${tb.i} difiere del oráculo`));
    assert.deepStrictEqual(other.view(), exp, `semilla ${seed}: el otro dispositivo difiere`); assert.deepStrictEqual(cloudView(cloud), exp, `semilla ${seed}: la nube difiere`);
    tabs.forEach(tb => assert.strictEqual(M.dirtyCount(tb.st), 0));
  }
});
test('FALLO 6 corregido: los identificadores no colisionan (100 000 generados)', () => {
  const s = new Set(); for (let i = 0; i < 100000; i++) s.add(M.rnd(12)); assert.strictEqual(s.size, 100000);
});
test('FALLO 7 corregido: el modo claro/oscuro no se sincroniza; paleta y semana sí', async () => {
  const cloud = mkCloud(), a = new Dev('a', cloud), b = new Dev('b', cloud);
  a.st.settings.theme = 'dark'; a.setting('palette', 'oceano'); a.setting('weekStart', 0); await a.sync(); await b.sync();
  assert.strictEqual(b.st.settings.palette, 'oceano'); assert.strictEqual(b.st.settings.weekStart, 0); assert.strictEqual(b.st.settings.theme, undefined);
  adv(1000); b.setting('palette', undefined); await b.sync(); await a.sync(); assert.strictEqual(a.st.settings.palette, undefined);
});

/* ───────── robustez ───────── */
test('fallo de red en mitad de la subida: lo confirmado se conserva y el resto se reintenta', async () => {
  const cloud = mkCloud(), a = new Dev('a', cloud); let calls = 0;
  for (let i = 0; i < 130; i++) a.create('e' + i, { type: 'nota', text: 't' + i });
  a.ao.fail = kind => kind === 'commit-before' && ++calls === 2; a.boot();
  await assert.rejects(() => a.sync());
  const done = Object.keys(cloud.docs).length; assert(done >= M.CHUNK && done < 131, 'hay lotes confirmados y otros no: ' + done);
  assert(M.dirtyCount(a.st) > 0);
  a.ao.fail = null; a.boot(); await a.sync();
  assert.strictEqual(M.dirtyCount(a.st), 0); assert.strictEqual(Object.values(cloud.docs).filter(d => d.col === 'entries').length, 130);
});
test('respuesta perdida tras confirmar la escritura: el reintento no duplica ni pierde nada', async () => {
  const cloud = mkCloud(), a = new Dev('a', cloud), b = new Dev('b', cloud); let once = true;
  a.create('e1', { type: 'nota', text: 'x' }); a.ao.fail = kind => { if (kind === 'commit-after' && once) { once = false; return true; } return false; }; a.boot();
  await assert.rejects(() => a.sync()); assert(cloud.docs.e1, 'la nube sí lo recibió');
  await a.sync(); await b.sync(); assert.deepStrictEqual(b.view(), a.view()); assert.strictEqual(M.dirtyCount(a.st), 0);
});
test('reinicio de la app en mitad de todo: el estado guardado basta para continuar', async () => {
  const cloud = mkCloud(), a = new Dev('a', cloud), b = new Dev('b', cloud);
  a.create('e1', { type: 'nota', text: '1' }); await a.sync(); adv(50); a.set('e1', 'text', '2'); a.boot(); adv(50); b.boot(); await b.sync(); await a.sync(); await b.sync();
  assert.strictEqual(b.rec('e1').text, '2');
});
test('edición local mientras llega una respuesta del servidor: no se pisa', async () => {
  const cloud = mkCloud(), a = new Dev('a', cloud), b = new Dev('b', cloud);
  a.create('e1', { type: 'nota', text: 'base', time: '09:00' }); await a.sync(); await b.sync();
  adv(100); b.set('e1', 'time', '11:11'); await b.sync();
  adv(100); a.set('e1', 'text', 'edición sin guardar aún');           // guardada (sellada) pero aún no sincronizada
  const docs = await a.adapter.fetchAll(); adv(100);
  M.applyRemote(a.st, a.clock, docs.find(d => d.id === 'e1'));
  assert.strictEqual(a.rec('e1').text, 'edición sin guardar aún'); assert.strictEqual(a.rec('e1').time, '11:11');
});
test('edición local SIN sellar (mutación pendiente de save) tampoco se pisa al llegar un documento', async () => {
  const cloud = mkCloud(), a = new Dev('a', cloud), b = new Dev('b', cloud);
  a.create('e1', { type: 'nota', text: 'base' }); await a.sync(); await b.sync();
  adv(100); b.set('e1', 'time', '08:08'); await b.sync();
  adv(100); a.rec('e1').text = 'mutación directa sin save()';
  const docs = await a.adapter.fetchAll(); M.applyRemote(a.st, a.clock, docs.find(d => d.id === 'e1'));
  assert.strictEqual(a.rec('e1').text, 'mutación directa sin save()'); assert.strictEqual(a.rec('e1').time, '08:08');
});
test('documento demasiado grande: se aparta sin bloquear el resto', async () => {
  const cloud = mkCloud(), a = new Dev('a', cloud);
  a.st.pets.push({ id: 'p1', name: 'Luna', photo: 'x'.repeat(1_000_000) }); a.create('e1', { type: 'nota', text: 'ok' }); a.save();
  const s = await a.sync(); assert.deepStrictEqual(s.big, ['p1']); assert(cloud.docs.e1); assert(!cloud.docs.p1);
});
test('datos de una versión más nueva: se bloquea la sincronización en lugar de estropearlos', async () => {
  const cloud = mkCloud(), a = new Dev('a', cloud);
  cloud.docs.z = { id: 'z', col: 'entries', v: 3, c: { text: 'futuro' }, t: { text: M.hlcStr(world.t, 0, 'q') }, d: null };
  await assert.rejects(() => a.sync(), e => e.code === 'schema' && M.classifyError(e) === 'schema');
});
test('reemplazar la nube con este dispositivo y restaurar este dispositivo desde la nube', async () => {
  const cloud = mkCloud(), a = new Dev('a', cloud), b = new Dev('b', cloud);
  a.create('a1', { type: 'nota', text: 'A1' }); a.create('a2', { type: 'nota', text: 'A2' }); await a.sync(); await b.sync();
  adv(100); b.create('b1', { type: 'nota', text: 'B1' }); b.set('a1', 'text', 'A1 editado en B'); await b.sync(); await a.sync();
  // A sobrescribe la nube: deja lo que tiene A (a1 con la edición de B, a2, b1)
  adv(100); a.del('b1'); a.set('a1', 'text', 'versión de A'); await M.overwriteRemote(a.st, a.clock, a.adapter); await b.sync();
  assert.deepStrictEqual(b.view(), a.view()); assert.strictEqual(b.rec('a1').text, 'versión de A'); assert(!b.rec('b1'));
  // B restaura desde la nube con cambios locales sin subir que deben descartarse
  adv(100); b.create('solo_local', { type: 'nota', text: 'no subida' });
  M.mirrorFromRemote(b.st, b.clock, await b.adapter.fetchAll());
  assert(!b.rec('solo_local')); assert.deepStrictEqual(b.view(), cloudView(cloud)); assert.strictEqual(M.dirtyCount(b.st), 0);
});
test('nube vaciada por fuera: los dispositivos vuelven a subir lo suyo sin duplicar ni perder', async () => {
  const cloud = mkCloud(), a = new Dev('a', cloud), b = new Dev('b', cloud);
  a.create('e1', { type: 'nota', text: 'uno', time: '10:00' }); a.create('e2', { type: 'nota', text: 'dos' }); a.setting('palette', 'oceano');
  await a.sync(); await b.sync(); adv(50); b.set('e2', 'text', 'dos (editado en B)'); await b.sync(); await a.sync();
  cloud.docs = {};                                              // alguien borra todo en la nube
  await a.sync(); await b.sync(); await a.sync();
  assert.strictEqual(Object.keys(cloud.docs).filter(k => k !== '_settings').length, 2);
  assert.strictEqual(cloud.docs.e2.c.text, 'dos (editado en B)'); assert.strictEqual(cloud.docs._settings.c.palette, 'oceano');
  assert.deepStrictEqual(a.view(), b.view()); assert.strictEqual(M.dirtyCount(a.st) + M.dirtyCount(b.st), 0);
});
test('recolección de lápidas antiguas y compatibilidad con un dispositivo dormido', async () => {
  const cloud = mkCloud(), a = new Dev('a', cloud), b = new Dev('b', cloud);
  a.create('e1', { type: 'nota', text: 'x' }); await a.sync(); await b.sync(); adv(10); a.del('e1'); await a.sync(); await b.sync();
  assert(cloud.docs.e1.d); world.t += 200 * 864e5;
  assert.strictEqual(await M.gc(a.st, a.clock, a.adapter), 1); assert(!cloud.docs.e1);
  a.create('e2', { type: 'nota', text: 'y' }); await a.sync(); await b.sync(); assert(b.rec('e2'));
});
test('vista previa de diferencias: subir, bajar y ambos', async () => {
  const cloud = mkCloud(), a = new Dev('a', cloud), b = new Dev('b', cloud);
  a.create('e1', { type: 'nota', text: 'x' }); a.create('e2', { type: 'nota', text: 'y' }); await a.sync(); await b.sync();
  adv(50); a.set('e1', 'text', 'local'); b.create('e3', { type: 'nota', text: 'de b' }); adv(50); b.set('e2', 'text', 'de b'); await b.sync();
  const remote = {}; (await a.adapter.fetchAll()).forEach(d => { remote[d.id] = d; });
  const items = M.previewDiff(a.st, remote), by = id => items.find(i => i.id === id);
  assert(by('e1').up > 0 && !by('e1').down); assert(by('e2').down > 0 && !by('e2').up); assert(by('e3').down > 0);
});
test('rendimiento: 2 000 registros se sellan y fusionan en tiempo razonable', async () => {
  const cloud = mkCloud(), a = new Dev('a', cloud), b = new Dev('b', cloud);
  for (let i = 0; i < 2000; i++) a.st.entries.push({ id: 'e' + i, type: 'nota', date: '2026-01-01', text: 'texto ' + i, petIds: ['p1'], done: true });
  let t0 = Date.now(); a.save(); const tStamp = Date.now() - t0;
  t0 = Date.now(); await a.sync(); const tSync = Date.now() - t0;
  t0 = Date.now(); await b.sync(); const tPull = Date.now() - t0;
  assert.deepStrictEqual(a.view(), b.view());
  a.rec('e5').text = 'x'; t0 = Date.now(); a.save(); const tSave = Date.now() - t0;
  console.log(`      · 2000 registros: sellar ${tStamp} ms, subir ${tSync} ms, bajar ${tPull} ms, guardar tras 1 cambio ${tSave} ms`);
  assert(tSave < 400, 'guardar un cambio debe ser rápido');
});

/* ───────── fuzz con oráculo ───────── */
class Oracle {
  constructor() { this.r = {}; this.settings = {}; }
  cell(id, k, v, t) { const r = this.r[id] ||= { cells: {}, d: 0 }; r.cells[k] = { v, t }; }
  create(id, f, t) { Object.keys(f).forEach(k => this.cell(id, k, f[k], t)); }
  del(id, t) { this.r[id].d = Math.max(this.r[id].d, t); }
  view() {
    const o = {};
    Object.keys(this.r).forEach(id => {
      const r = this.r[id]; let mx = 0; Object.values(r.cells).forEach(c => { if (c.t > mx) mx = c.t; });
      if (!(r.d === 0 || mx > r.d)) return;
      const rec = { id }, log = [];
      Object.keys(r.cells).forEach(k => { const v = r.cells[k].v; if (v === null) return; if (k.startsWith('log#')) log.push(v); else rec[k] = v; });
      if (log.length) rec.log = log.sort((a, b) => (a.ts - b.ts) || (a.id < b.id ? -1 : 1));
      o[id] = M.stable(rec);
    });
    return o;
  }
  sview() { const o = {}; Object.keys(this.settings).forEach(k => { if (this.settings[k].v !== null) o[k] = this.settings[k].v; }); return M.stable(o); }
}

async function fuzz(seed, steps) {
  globalThis.TR = []; globalThis.OPS = [];
  const rnd = rand(seed), oracle = new Oracle(), cloud = mkCloud();
  world.t = 1_790_000_000_000 + seed * 977;
  const nDev = 2 + Math.floor(rnd() * 3);
  const skews = [0, -6 * 3600e3, 3 * 3600e3, 47 * 60e3, -90e3].sort(() => rnd() - .5);
  const devs = [], failP = 0.12;
  for (let i = 0; i < nDev; i++) {
    const d = new Dev('d' + i, cloud, skews[i], {}); d.chaos = true;
    d.ao.fail = kind => d.chaos && rnd() < failP && kind !== 'delete'; d.boot(); devs.push(d);
  }
  const ids = []; let nid = 0, nlog = 0;
  const pick = a => a[Math.floor(rnd() * a.length)];
  const now = () => world.t;                                   // hora verdadera de cada operación
  for (let s = 0; s < steps; s++) {
    adv(1 + Math.floor(rnd() * 4000));
    const d = pick(devs), x = rnd();
    if (x < .10 || !ids.length) {                               // crear
      const id = 'r' + (nid++), f = { type: 'nota', text: 'txt' + s, time: pick(['08:00', '12:30', '20:15']), done: rnd() < .5, petIds: rnd() < .5 ? ['p1'] : ['p1', 'p2'] };
      d.create(id, f); oracle.create(id, f, now()); ids.push(id); OPS.push([now(), d.name, 'crea', id]);
    } else if (x < .40) {                                       // editar campo
      const id = pick(ids), k = pick(['text', 'time', 'done', 'petIds', 'place']);
      const v = k === 'done' ? rnd() < .5 : k === 'petIds' ? pick([['p1'], ['p2'], ['p1', 'p2']]) : k + s;
      if (d.set(id, k, v)) { oracle.cell(id, k, v, now()); OPS.push([now(), d.name, 'set ' + k, id]); }
    } else if (x < .47) {                                       // quitar campo
      const id = pick(ids), k = pick(['place', 'time']); if (d.unset(id, k)) { oracle.cell(id, k, null, now()); OPS.push([now(), d.name, 'unset ' + k, id]); }
    } else if (x < .55) {                                       // borrar registro
      const id = pick(ids); if (d.del(id)) { oracle.del(id, now()); OPS.push([now(), d.name, 'DEL', id]); }
    } else if (x < .65) {                                       // añadir nota de seguimiento
      const id = pick(ids), it = { id: 'l' + (nlog++), ts: now(), text: 'seg' + s }; if (d.logAdd(id, it)) { oracle.cell(id, 'log#' + it.id, it, now()); OPS.push([now(), d.name, 'logAdd ' + it.id, id]); }
    } else if (x < .69) {                                       // borrar nota de seguimiento
      const id = pick(ids), r = d.rec(id); if (r && r.log && r.log.length) { const it = pick(r.log); if (d.logDel(id, it.id)) { oracle.cell(id, 'log#' + it.id, null, now()); OPS.push([now(), d.name, 'logDel ' + it.id, id]); } }
    } else if (x < .73) {                                       // ajuste
      const k = pick(['palette', 'weekStart', 'calView']), v = rnd() < .2 ? undefined : k + s;
      if (v === undefined && !(k in d.st.settings)) continue;              // quitar un ajuste que este dispositivo no tiene no hace nada
      d.setting(k, v); oracle.settings[k] = { v: v === undefined ? null : v, t: now() }; (globalThis.TR ||= []).push([world.t, d.name, k, v]);
    } else if (x < .78) { d.boot(); }                            // reinicio de la app
    else if (x < .82) { d.ao.offline = !d.ao.offline; }          // corte de red
    else { try { await d.sync(); } catch (e) { /* fallos simulados */ } }
  }
  devs.forEach(d => { d.chaos = false; d.ao.offline = false; d.ao.fail = null; d.boot(); });
  for (let r = 0; r < 3; r++) for (const d of devs) await d.sync();
  const exp = oracle.view(), expS = oracle.sview(), cv = cloudView(cloud);
  for (const d of devs) {
    if (M.stable(d.view()) !== M.stable(exp)) {
      const bad = Object.keys(exp).concat(Object.keys(d.view())).filter(id => exp[id] !== d.view()[id]);
      const id = bad[0]; console.log('TRAZA de', id, OPS.filter(o => o[3] === id).map(o => o[0] % 1e6 + ' ' + o[1] + ' ' + o[2]).join(' | '));
      devs.forEach(x => console.log('  ', x.name, 'skew', x.skew / 60000, 'off', x.st.sync.off, 'meta', JSON.stringify(x.st.meta[id]), 'rec', JSON.stringify(x.rec(id))));
      console.log('   nube', JSON.stringify(cloud.docs[id])); console.log('   oráculo', JSON.stringify(oracle.r[id]));
    }
    assert.deepStrictEqual(d.view(), exp, `seed ${seed}: ${d.name} (skew ${d.skew / 60000} min) difiere del oráculo`);
    if (d.sview() !== expS) { console.log('TRAZA', JSON.stringify(globalThis.TR)); console.log('  meta', d.name, JSON.stringify(d.st.meta._settings)); console.log('  nube', JSON.stringify(cloud.docs._settings)); console.log('  skews', devs.map(x => x.name + ':' + x.skew / 60000 + 'min off=' + x.st.sync.off)); }
    assert.strictEqual(d.sview(), expS, `seed ${seed}: ajustes de ${d.name}`);
    assert.strictEqual(M.dirtyCount(d.st), 0, `seed ${seed}: ${d.name} con cambios sin subir`);
  }
  assert.deepStrictEqual(cv, exp, `seed ${seed}: la nube difiere del oráculo`);
  for (const d of devs) { const s = await d.sync(); assert.strictEqual(s.pulled, 0, `seed ${seed}: sync no idempotente`); assert.strictEqual(s.sent, 0); }
  return { devs: nDev, records: Object.keys(exp).length };
}
test('FUZZ: 300 historias aleatorias (2-4 dispositivos, relojes desajustados hasta 6 h, fallos y cortes de red, reinicios) convergen al resultado esperado', async () => {
  let recs = 0, seeds = +process.env.SEEDS || 300;
  for (let s = (+process.env.SEED0 || 1); s < (+process.env.SEED0 || 1) + (+process.env.SEEDS || seeds); s++) { const r = await fuzz(s, 220); recs += r.records; }
  console.log(`      · ${seeds} historias (semillas desde ${process.env.SEED0 || 1}), ${recs} registros vivos comprobados contra el oráculo`);
});

(async () => {
  let pass = 0, fail = 0;
  for (const t of tests) {
    try { await t.fn(); pass++; console.log('  ✓', t.name); }
    catch (e) { fail++; console.log('  ✗', t.name, '\n     ', (e.message || e).toString().split('\n').slice(0, 6).join('\n      ')); }
  }
  console.log(`\n${pass} pruebas correctas, ${fail} con fallo`);
  process.exit(fail ? 1 : 0);
})();
