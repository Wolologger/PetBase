"""
Prueba de extremo a extremo con DOS navegadores reales: la app (index.html), el SDK de Firebase y el emulador de Firestore.
Uso:  npm run test:navegadores        (arranca el emulador y ejecuta este archivo)
Necesita:  pip install playwright && playwright install chromium
"""
import json, os, sys, threading, time, urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from functools import partial
from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
PROJECT = 'demo-petbase'
CONFIG_JS = "window.PETBASE_FIREBASE = %s;" % json.dumps({'sdk': '10.14.1', 'config': {'apiKey': 'fake', 'projectId': PROJECT, 'authDomain': 'x'},
    'emulator': {'host': '127.0.0.1', 'fsPort': 8080, 'mockUser': {'uid': 'e2e-user', 'email': 'ana@test.dev', 'name': 'Ana'}}})
BLANK = {'pets': [], 'entries': [], 'sacks': [], 'settings': {}, 'nextId': 1, 'vetV': 1, 'v4': 1}

class Quiet(SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
srv = ThreadingHTTPServer(('127.0.0.1', 0), partial(Quiet, directory=ROOT)); threading.Thread(target=srv.serve_forever, daemon=True).start()
URL = 'http://127.0.0.1:%d/index.html' % srv.server_address[1]

ok, bad = [], []
def check(name, cond, extra=''):
    (ok if cond else bad).append(name); print(('  ✓ ' if cond else '  ✗ ') + name + ((' · ' + str(extra)) if extra != '' else ''), flush=True)
def wait(pg, expr, timeout=20000, label=''):
    try: pg.wait_for_function(expr, timeout=timeout)
    except Exception: raise AssertionError('tiempo agotado esperando: ' + (label or expr))
def S(pg, expr): return pg.evaluate(expr)
def new_device(browser, blank):
    ctx = browser.new_context(viewport={'width': 390, 'height': 844})
    ctx.route('**/firebase-config.js', lambda r: r.fulfill(status=200, content_type='application/javascript', body=CONFIG_JS))
    init = "window.__fast=true;"
    if blank: init += "try{ if(!localStorage.getItem('petbase_v1')) localStorage.setItem('petbase_v1', %s); }catch(e){}" % json.dumps(json.dumps(BLANK))
    ctx.add_init_script(init)
    pg = ctx.new_page(); logs = []; pg.on('pageerror', lambda e: logs.append('PAGEERROR ' + str(e)))
    pg.route('**/fonts.g*/**', lambda r: r.abort()); pg.goto(URL); return ctx, pg, logs
def live(pg): wait(pg, "typeof S!=='undefined' && S.account && SYNCST.live && !SYNCING", 40000, 'sesión y tiempo real')
def count(pg): return pg.evaluate("SE.COLS.reduce((a,c)=>a+S[c].length,0)")
def view(pg): return pg.evaluate("Object.fromEntries(S.entries.map(e=>[e.id, SE.stable(e)]))")

SEED = """(() => {
  S.pets.push({id:'p1', name:'Luna', species:'Perro', color:'#e9a23b'}, {id:'p2', name:'Miso', species:'Gato', color:'#6fb3f2'});
  for (let i = 0; i < 60; i++) S.entries.push({id:'n'+i, type:'nota', date:'2026-09-30', time:'10:00', text:'nota '+i, petIds:['p1'], done:true, recur:'none'});
  for (let i = 0; i < 12; i++) S.entries.push({id:'w'+i, type:'paseo', date:'2026-09-29', time:'08:00', duration:20+i, petIds:['p1'], done:true, recur:'none'});
  S.entries.push({id:'v1', type:'vet', date:'2026-09-01', title:'Revisión', kind:'revision', petIds:['p1'], done:true, recur:'none', log:[{id:'l0', ts:1, text:'seguimiento'}]});
  S.settings.palette = 'oceano'; save();
})()"""

try:
    urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:8080/emulator/v1/projects/%s/databases/(default)/documents' % PROJECT, method='DELETE')).read()
except Exception: pass
with sync_playwright() as p:
    b = p.chromium.launch()
    print('== A: dispositivo con datos inicia sesión (SDK real de Firebase + emulador de Firestore)', flush=True)
    ctxA, A, logsA = new_device(b, False); live(A)
    A.evaluate(SEED); nA = count(A)
    check('A: sesión iniciada con la cuenta de prueba', S(A, "S.account.uid") == 'e2e-user', S(A, "S.account.email"))
    wait(A, "SE.dirtyCount(S)===0 && !SYNCING", 40000, 'A sube todo'); check('A: todo subido (0 pendientes)', S(A, "SE.dirtyCount(S)") == 0, '%d registros' % nA)
    check('A: usa Firestore real (no la nube simulada)', S(A, "adapterKind()") == 'firestore')
    check('A: arranca sin datos de ejemplo ni banner de demo', S(A, "!document.querySelector('.demo')"))
    print('== B: segundo dispositivo, vacío, con la misma cuenta', flush=True)
    ctxB, B, logsB = new_device(b, True); live(B)
    wait(B, "SE.COLS.reduce((a,c)=>a+S[c].length,0)==%d" % nA, 40000, 'B recibe los %d registros' % nA)
    check('B: recibe los %d registros de A' % nA, count(B) == nA); check('B: contenido idéntico al de A', view(A) == view(B))
    check('B: recibe también el tema (paleta) pero no el modo claro/oscuro', S(B, "S.settings.palette") == 'oceano' and S(B, "S.settings.theme") is None)
    print('== Tiempo real', flush=True)
    nid = 'n3'; t0 = time.time()
    A.evaluate("(()=>{const e=S.entries.find(e=>e.id==='n3'); e.text='EDITADA EN A '+Date.now(); save();})()")
    wait(B, "S.entries.find(e=>e.id==='n3').text.startsWith('EDITADA EN A')", 20000, 'B recibe la edición')
    check('B recibe la edición de A sin hacer nada', True, '%.2f s' % (time.time() - t0))
    print('== Campos distintos del mismo registro con B sin conexión', flush=True)
    ctxB.set_offline(True); B.wait_for_timeout(600)
    B.evaluate("(()=>{const e=S.entries.find(e=>e.id==='n3'); e.time='23:59'; save();})()")
    A.evaluate("(()=>{const e=S.entries.find(e=>e.id==='n3'); e.text='TEXTO NUEVO DE A'; save();})()")
    wait(A, "SE.dirtyCount(S)===0", 20000, 'A sube'); B.wait_for_timeout(600)
    check('B sin conexión: su cambio espera', S(B, "SE.dirtyCount(S)") > 0, 'estado: ' + S(B, "statusInfo().t"))
    ctxB.set_offline(False); B.evaluate("window.dispatchEvent(new Event('online'))")
    wait(B, "S.entries.find(e=>e.id==='n3').text==='TEXTO NUEVO DE A' && SE.dirtyCount(S)===0", 60000, 'B reconecta y se pone al día')
    wait(A, "S.entries.find(e=>e.id==='n3').time==='23:59'", 30000, 'A recibe la hora de B')
    good = "(()=>{const e=S.entries.find(e=>e.id==='n3');return e.text==='TEXTO NUEVO DE A'&&e.time==='23:59'})()"
    check('al reconectar se conservan las dos ediciones en A y en B', S(A, good) and S(B, good))
    print('== Reloj de B atrasado 3 h: gana la edición más reciente en tiempo real', flush=True)
    B.evaluate("window.__skew=-3*3600e3; S.sync.offAt=0")
    A.evaluate("(()=>{const e=S.entries.find(e=>e.id==='n3'); e.text='A escribe primero'; save();})()")
    wait(B, "S.entries.find(e=>e.id==='n3').text==='A escribe primero'", 20000)
    B.evaluate("runSync('sync',{silent:true})"); B.wait_for_timeout(1500)
    B.evaluate("(()=>{const e=S.entries.find(e=>e.id==='n3'); e.text='B escribe DESPUÉS'; save();})()")
    wait(A, "S.entries.find(e=>e.id==='n3').text==='B escribe DESPUÉS'", 30000, 'A recibe la edición posterior de B (reloj -3 h)')
    check('gana la edición posterior aunque el reloj de B vaya 3 h atrasado', True, 'offset aprendido por B: %d min' % round(S(B, "S.sync.off") / 60000))
    B.evaluate("window.__skew=0; S.sync.offAt=0")
    print('== Notas de seguimiento a la vez', flush=True)
    ctxB.set_offline(True); B.wait_for_timeout(400)
    A.evaluate("(()=>{const e=S.entries.find(e=>e.id==='v1'); e.log.push({id:'la', ts:Date.now(), text:'de A'}); save();})()")
    B.evaluate("(()=>{const e=S.entries.find(e=>e.id==='v1'); e.log.push({id:'lb', ts:Date.now()+1, text:'de B'}); save();})()")
    wait(A, "SE.dirtyCount(S)===0", 20000); ctxB.set_offline(False); B.evaluate("window.dispatchEvent(new Event('online'))")
    both = "(()=>{const l=S.entries.find(e=>e.id==='v1').log.map(x=>x.id).sort().join();return l==='l0,la,lb'})()"
    wait(B, both, 60000, 'B ve las tres notas'); wait(A, both, 30000, 'A ve las tres notas'); check('las dos notas de seguimiento se conservan en los dos dispositivos', True)
    print('== Borrado, y editar después de borrar', flush=True)
    A.evaluate("(()=>{S.entries=S.entries.filter(x=>x.id!=='w0'); save();})()")
    wait(B, "!S.entries.some(e=>e.id==='w0')", 20000, 'B recibe el borrado'); check('B recibe el borrado de A', True)
    ctxB.set_offline(True); B.wait_for_timeout(500)
    A.evaluate("(()=>{S.entries=S.entries.filter(x=>x.id!=='w1'); save();})()"); wait(A, "SE.dirtyCount(S)===0", 20000); B.wait_for_timeout(500)
    B.evaluate("(()=>{const e=S.entries.find(e=>e.id==='w1'); if(e){e.duration=77; save();}})()")
    ctxB.set_offline(False); B.evaluate("window.dispatchEvent(new Event('online'))")
    wait(B, "SE.dirtyCount(S)===0 && !SYNCING", 60000, 'B se pone al día'); wait(A, "S.entries.some(e=>e.id==='w1')", 30000, 'A recupera el registro editado después del borrado')
    check('editar después de borrar (B sin conexión) recupera el registro en A con su edición', S(A, "S.entries.find(e=>e.id==='w1').duration") == 77)
    print('== Recarga de B: el estado sobrevive y no duplica', flush=True)
    nB = count(B); B.reload(); live(B); wait(B, "!SYNCING && SE.dirtyCount(S)===0", 40000)
    check('tras recargar B: mismos registros, sin duplicados', count(B) == nB and count(B) == count(A), '%d / %d' % (count(B), count(A)))
    print('== Dos pestañas del MISMO navegador (eventos de almacenamiento reales)', flush=True)
    B2 = ctxB.new_page(); B2.route('**/fonts.g*/**', lambda r: r.abort()); B2.goto(URL); live(B2)
    B.evaluate("S.entries.push({id:'de_la_pestaña_1',type:'nota',date:'2026-09-30',text:'pestaña 1',petIds:[],done:true,recur:'none'}); save()")
    B2.evaluate("S.entries.push({id:'de_la_pestaña_2',type:'nota',date:'2026-09-30',text:'pestaña 2',petIds:[],done:true,recur:'none'}); save()")
    both = "S.entries.some(e=>e.id==='de_la_pestaña_1') && S.entries.some(e=>e.id==='de_la_pestaña_2')"
    wait(B, both, 30000, 'pestaña 1 ve las dos'); wait(B2, both, 30000, 'pestaña 2 ve las dos'); check('las dos pestañas conservan las dos notas (nada se pisa)', True)
    wait(A, both, 40000, 'A recibe ambas'); check('y ambas llegan al otro dispositivo', True); B2.close()
    print('== Panel de Datos', flush=True)
    A.evaluate("go('datos')"); A.wait_for_timeout(400); txt = A.inner_text('#v-datos .syncline').strip().replace('\n', ' ')
    check('panel: estado en tiempo real', 'tiempo real' in txt.lower(), txt)
    check('marca PetBase en la app', 'PetBase' in A.title() and S(A, "document.getElementById('brand').textContent") == 'PetBase', A.title())
    errs = [l for l in logsA + logsB if 'PAGEERROR' in l]; check('sin errores de página en ninguno de los dos dispositivos', not errs, errs[:2])
    b.close()
print('\n%d correctas, %d con fallo' % (len(ok), len(bad)), flush=True); sys.exit(1 if bad else 0)
