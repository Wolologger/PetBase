/* Lleva la versión de package.json a la app y cierra la sección [Sin publicar] del CHANGELOG.
   Uso normal:  npm version patch|minor|major   (npm sube package.json, ejecuta este script, hace commit y crea la etiqueta vX.Y.Z)
   Solo sincronizar:  npm run version:sync */
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..'), rd = f => fs.readFileSync(path.join(root, f), 'utf8');
const v = JSON.parse(rd('package.json')).version;
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(v)) { console.error('Versión no válida en package.json: ' + v); process.exit(1); }

// CHANGELOG (primero, para no tocar nada si faltan los cambios): lo de [Sin publicar] pasa a [v] con la fecha de hoy,
// se deja una sección vacía para lo siguiente y se actualizan los enlaces de comparación del final
let cl = rd('CHANGELOG.md');
const unreleased = '## [Sin publicar]';
if (!cl.includes(`## [${v}]`)) {
  const a = cl.indexOf(unreleased), b = cl.indexOf('\n## [', a + 1), body = a < 0 ? '' : cl.slice(a + unreleased.length, b < 0 ? undefined : b).trim();
  if (!body) { console.error(`CHANGELOG.md: no hay cambios en ${unreleased} para la versión ${v}`); process.exit(1); }
  cl = cl.replace(unreleased, `${unreleased}\n\n## [${v}] - ${new Date().toISOString().slice(0, 10)}`);
  const m = cl.match(/^\[Sin publicar\]: (.+)\/compare\/(v\S+)\.\.\.HEAD$/m);
  if (m) cl = cl.replace(m[0], `[Sin publicar]: ${m[1]}/compare/v${v}...HEAD\n[${v}]: ${m[1]}/compare/${m[2]}...v${v}`);
}

const rules = {
  'index.html': [[/<!-- PetBase v[^ ]+ -->/, `<!-- PetBase v${v} -->`], [/const APP_VERSION = '[^']*';/, `const APP_VERSION = '${v}';`]],
  'demo.html':  [[/<!-- PetBase v[^ ]+ -->/, `<!-- PetBase v${v} -->`], [/const APP_VERSION = '[^']*';/, `const APP_VERSION = '${v}';`]],
  'sw.js':      [[/const V = 'petbase-[^']*'/, `const V = 'petbase-v${v}'`]]   // caché nueva por versión: la anterior se borra al activarse
};
const out = {'CHANGELOG.md': cl};
for (const [f, rs] of Object.entries(rules)) {
  let h = rd(f);
  for (const [re, to] of rs) { if (!re.test(h)) { console.error(`No se encontró ${re} en ${f}`); process.exit(1); } h = h.replace(re, to); }
  out[f] = h;
}
for (const [f, h] of Object.entries(out)) fs.writeFileSync(path.join(root, f), h);
console.log('PetBase v' + v);
