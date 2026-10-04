// Reproduce fallos de la sincronización ANTERIOR con dos "dispositivos" (dos ventanas con su propio almacenamiento) y una nube compartida
const {JSDOM}=require('jsdom');
const fs=require('fs');
const html=fs.readFileSync(__dirname+'/fixtures/motor-anterior.html','utf8');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let TRUE_NOW=Date.now();
function device(name, skew, state){
  const dom=new JSDOM(html,{runScripts:'dangerously',url:'https://'+name+'.test/',pretendToBeVisual:true,
    beforeParse(w){w.matchMedia=w.matchMedia||(q=>({matches:false,addEventListener(){}}));w.scrollTo=()=>{};w.__fast=true;
      w.Date.now=()=>TRUE_NOW+skew; if(state) w.localStorage.setItem('manada_demo_v1',JSON.stringify(state));}});
  dom.window.confirm=()=>true; return dom.window;
}
const tick=ms=>{TRUE_NOW+=ms;};
async function setup(skewB=0){
  const A=device('a',0); await sleep(250);
  A.eval("S.account={name:'x',email:'x',provider:'g',lastSync:0}; S.sync.mode='manual'; save()");
  A.eval("syncRun('sync')"); await sleep(50);
  const cloudJSON=A.localStorage.getItem('manada_cloud_demo_v1');
  const st=JSON.parse(A.localStorage.getItem('manada_demo_v1'));
  const B=device('b',skewB,st); await sleep(250); B.localStorage.setItem('manada_cloud_demo_v1',cloudJSON);
  return {A,B};
}
function pushCloud(from,to){ const c=from.localStorage.getItem('manada_cloud_demo_v1'); to.localStorage.setItem('manada_cloud_demo_v1',c); to.eval("CLOUD_MEM=undefined; cloudSet(JSON.parse(localStorage.getItem('manada_cloud_demo_v1')))"); }
function sync(dev,other){ pushCloud(other,dev); dev.eval("S.account={name:'x',email:'x',provider:'g'}; S.sync.mode='manual'"); dev.eval("syncRun('sync')"); pushCloud(dev,other); }
(async()=>{
 console.log('=== FALLO 1: dos dispositivos editan CAMPOS DISTINTOS del mismo registro (sin conexión) ===');
 let {A,B}=await setup(); const id=A.eval("S.entries.find(e=>e.type==='nota').id");
 tick(1000); A.eval(`S.entries.find(e=>e.id==='${id}').text='TEXTO editado en A'; save()`);
 tick(1000); B.eval(`S.entries.find(e=>e.id==='${id}').time='23:59'; save()`);
 tick(1000); sync(A,B); tick(1000); sync(B,A); tick(1000); sync(A,B);
 const ra=A.eval(`JSON.stringify(S.entries.find(e=>e.id==='${id}'))`), rb=B.eval(`JSON.stringify(S.entries.find(e=>e.id==='${id}'))`);
 const pa=JSON.parse(ra), pb=JSON.parse(rb);
 console.log('  A tiene texto editado:',/TEXTO editado/.test(pa.text),'| hora 23:59:',pa.time==='23:59');
 console.log('  B tiene texto editado:',/TEXTO editado/.test(pb.text),'| hora 23:59:',pb.time==='23:59');
 console.log('  RESULTADO:',(/TEXTO editado/.test(pa.text)&&pa.time==='23:59'&&/TEXTO editado/.test(pb.text)&&pb.time==='23:59')?'se conservaron las dos ediciones':'SE PERDIÓ UNA DE LAS DOS EDICIONES (se sobrescribe el registro entero)');

 console.log('\n=== FALLO 2: reloj del segundo dispositivo atrasado 2 h (la edición MÁS RECIENTE debería ganar) ===');
 ({A,B}=await setup(-2*3600e3)); const id2=A.eval("S.entries.find(e=>e.type==='nota').id");
 tick(1000); A.eval(`S.entries.find(e=>e.id==='${id2}').text='A escribe primero'; save()`);
 tick(60000); B.eval(`S.entries.find(e=>e.id==='${id2}').text='B escribe DESPUÉS (la buena)'; save()`);
 tick(1000); sync(B,A); tick(1000); sync(A,B); tick(1000); sync(B,A);
 console.log('  A final:',A.eval(`S.entries.find(e=>e.id==='${id2}').text`),'| B final:',B.eval(`S.entries.find(e=>e.id==='${id2}').text`));
 console.log('  RESULTADO:',/DESPUÉS/.test(A.eval(`S.entries.find(e=>e.id==='${id2}').text`))?'gana la edición reciente':'GANA LA EDICIÓN ANTIGUA: el reloj del dispositivo decide');

 console.log('\n=== FALLO 3: dos notas de seguimiento añadidas a la vez a la misma visita ===');
 ({A,B}=await setup()); const vid=A.eval("S.entries.find(e=>e.type==='vet'&&e.log).id");
 tick(1000); A.eval(`S.entries.find(e=>e.id==='${vid}').log.push({id:'na',ts:Date.now(),text:'nota de A'}); save()`);
 tick(1000); B.eval(`S.entries.find(e=>e.id==='${vid}').log.push({id:'nb',ts:Date.now(),text:'nota de B'}); save()`);
 tick(1000); sync(A,B); tick(1000); sync(B,A); tick(1000); sync(A,B);
 const la=A.eval(`S.entries.find(e=>e.id==='${vid}').log.map(n=>n.id).join()`), lb=B.eval(`S.entries.find(e=>e.id==='${vid}').log.map(n=>n.id).join()`);
 console.log('  A tiene:',la,'| B tiene:',lb); console.log('  RESULTADO:',(/na/.test(la)&&/nb/.test(la)&&/na/.test(lb)&&/nb/.test(lb))?'se conservan las dos':'SE PIERDE UNA NOTA');

 console.log('\n=== FALLO 4: edición en dispositivo A y borrado en B, con B con el reloj adelantado ===');
 ({A,B}=await setup(+3*3600e3)); const id4=A.eval("S.entries.find(e=>e.type==='nota').id");
 tick(1000); A.eval(`S.entries.find(e=>e.id==='${id4}').text='A edita (después del borrado en tiempo real)'; save()`);
 // B borra ANTES en tiempo real pero su reloj va +3h → su lápida parece más nueva
 TRUE_NOW-=500; B.eval(`S.entries=S.entries.filter(e=>e.id!=='${id4}'); save()`); TRUE_NOW+=500;
 tick(1000); sync(A,B); tick(1000); sync(B,A); tick(1000); sync(A,B);
 console.log('  registro en A:',A.eval(`S.entries.some(e=>e.id==='${id4}')`),'| en B:',B.eval(`S.entries.some(e=>e.id==='${id4}')`),'(la edición de A fue posterior al borrado)');

 console.log('\n=== FALLO 5: dos pestañas del mismo navegador (mismo almacenamiento) ===');
 const T=device('t',0); await sleep(250); T.eval('save()');
 const before=T.eval('S.entries.length');
 // otra pestaña guarda una nota nueva directamente en el almacenamiento compartido
 const other=JSON.parse(T.localStorage.getItem('manada_demo_v1')); other.entries.push({id:'de_otra_pestaña',type:'nota',date:'2026-09-30',text:'escrita en la otra pestaña',petIds:[],done:true,recur:'none'}); T.localStorage.setItem('manada_demo_v1',JSON.stringify(other));
 T.eval("S.entries.push({id:'de_esta_pestaña',type:'nota',date:'2026-09-30',text:'escrita en esta pestaña',petIds:[],done:true,recur:'none'}); save()");
 const saved=JSON.parse(T.localStorage.getItem('manada_demo_v1'));
 console.log('  tras guardar en esta pestaña, en el almacenamiento están: esta',saved.entries.some(e=>e.id==='de_esta_pestaña'),'| la de la otra pestaña',saved.entries.some(e=>e.id==='de_otra_pestaña'),' → ',saved.entries.some(e=>e.id==='de_otra_pestaña')?'ok':'LA NOTA DE LA OTRA PESTAÑA SE HA PERDIDO');

 console.log('\n=== FALLO 6: identificadores que pueden repetirse entre dispositivos ===');
 const X=device('x',0), Y=device('y',0); await sleep(250);
 for (const w of [X,Y]){ w.eval("S.nextId=7"); }
 const ix=X.eval("uid()"), iy=Y.eval("uid()"); TRUE_NOW+=0;
 console.log('  mismo contador y mismo milisegundo → ids:',ix,iy,'→',ix===iy?'COLISIÓN (dos registros distintos con el mismo id se pisarían)':'distintos');
 console.log('\n=== FALLO 7: los ajustes de aspecto viajan a todos los dispositivos ===');
 console.log('  syncSettingsOf incluye theme (claro/oscuro):',X.eval("Object.keys(syncSettingsOf(S)).join()"),'→ el modo oscuro del móvil forzaría el del ordenador');
 process.exit(0);
})();
