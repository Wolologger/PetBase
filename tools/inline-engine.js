/* Reincrusta sync/sync-engine.js dentro de index.html y demo.html (entre las marcas inline:sync-engine). */
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..'), engine = fs.readFileSync(path.join(root, 'sync/sync-engine.js'), 'utf8');
const head = '/* >>> inline:sync-engine (generado: edita sync/sync-engine.js y ejecuta  node tools/inline-engine.js) */\n', tail = '\n/* <<< inline:sync-engine */';
for (const f of ['index.html', 'demo.html']) {
  const p = path.join(root, f), h = fs.readFileSync(p, 'utf8'), a = h.indexOf(head), b = h.indexOf(tail, a);
  if (a < 0 || b < 0) { console.error('No se encontraron las marcas en ' + f); process.exit(1); }
  fs.writeFileSync(p, h.slice(0, a + head.length) + engine + h.slice(b));
  console.log('Motor reincrustado en ' + f);
}
