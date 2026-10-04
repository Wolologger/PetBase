# PetBase

**Plataforma integral para la gestión, seguimiento e historial médico de tus mascotas.** Organiza vacunas, citas, tratamientos y hábitos diarios en un solo lugar.

> Gestión, seguimiento e historial médico de tus mascotas: vacunas, citas, tratamientos y hábitos diarios en un solo lugar.

PetBase es una PWA (se instala en el móvil y abre sin conexión) que guarda los datos en tu dispositivo y, si quieres, los sincroniza entre dispositivos con tu propia cuenta de Firebase.

- **`index.html`**: la app real. Empieza vacía y funciona sola en el dispositivo; con Firebase configurado sincroniza.
- **`demo.html`**: la misma app con datos de ejemplo y una nube simulada para probarlo todo sin cuenta.

## Qué incluye

- **Mascotas y ficha veterinaria**: datos, chip, alergias y condiciones, curva de peso, vacunas y desparasitación, historial de visitas con notas de seguimiento, y ficha para compartir.
- **Calendario en tres vistas** (mes, semana y agenda) con filtros por mascota, tipo y estado, aviso de choques de horario y exportación a `.ics` para Outlook o Google.
- **Medicamentos y cuidados** con repetición personalizada (cada N horas, días, semanas, meses o años, con fin por fecha o por número de veces) y **dosis por peso**.
- **Diario y hábitos**: notas por mascota (una o varias), paseos con cronómetro, toques rápidos (pis, caca, agua, juego, dentro o fuera) y comidas.
- **Pienso**: cuánto te dura un saco, estado de cada saco y duración real de los anteriores.
- **Resúmenes** diario, semanal, mensual, anual y de siempre, con comparación con el periodo anterior.
- **Sincronización en tiempo real** (automática, al abrir o solo manual), con panel de lo que hay en el dispositivo y en la nube, y subir, bajar o sincronizar a mano.
- **Exportar todo** en un `.zip`: copia completa en JSON, CSV de registros, mascotas y sacos, notas en texto y calendario `.ics`.
- Seis temas (cada uno con su pelota) más un tema personalizado, modo claro y oscuro, y atajos en el icono de la app.

## Puesta en marcha

### 1. Solo en el dispositivo (sin cuenta)

Sirve la carpeta con cualquier servidor estático (por ejemplo GitHub Pages) y abre `index.html`. No hace falta nada más. Los datos viven en el navegador: usa **Exportar todo** como copia de seguridad.

### 2. Con sincronización (Firebase)

1. En la [consola de Firebase](https://console.firebase.google.com) crea un proyecto.
2. Activa **Firestore** en **modo producción** y elige una región de Europa (por ejemplo `europe-southwest1`). La región no se puede cambiar después.
3. Activa **Authentication** y, dentro, el proveedor **Google**.
4. En Authentication → Configuración → **Dominios autorizados**, añade el dominio donde publiques la app (por ejemplo `tuusuario.github.io`).
5. Configuración del proyecto → *Tus apps* → crea una **app web** y copia sus datos en `firebase-config.js` (sustituye `null` por el objeto que explica el propio archivo).
6. Despliega las reglas de seguridad:
   ```bash
   npm install
   cp .firebaserc.example .firebaserc      # y pon el id de tu proyecto
   npx firebase login
   npm run desplegar:reglas
   ```
7. Publica el repositorio (GitHub Pages sirve `index.html` desde la raíz) e inicia sesión desde la app.

Las reglas (`firebase/firestore.rules`) dejan que cada persona lea y escriba solo en `users/{su-uid}`. La `apiKey` de una app web no es secreta: lo que protege los datos son esas reglas.

## Cómo sincroniza

Cada campo de un registro lleva un sello de tiempo (reloj lógico híbrido) y se fusiona campo a campo:

- Si dos dispositivos cambian **campos distintos** del mismo registro, se conservan los dos cambios.
- Si cambian **el mismo campo**, gana la edición más reciente.
- Las notas de seguimiento de una visita se fusionan una a una.
- Borrar deja una lápida; editar después de borrar recupera el registro.
- Los sellos usan la hora del servidor: un reloj mal puesto no decide quién gana.
- Un documento por registro en Firestore (sin el límite de 1 MB) y subidas en transacciones.

Detalles, fallos del motor anterior y pruebas: [`docs/REVISION-SINCRONIZACION.md`](docs/REVISION-SINCRONIZACION.md).

## Estructura

```
index.html                 app real (PWA)
demo.html                  demo con datos de ejemplo y nube simulada
manifest.json, sw.js       instalación y modo sin conexión
firebase-config.js         datos de tu proyecto de Firebase (null = solo local)
firebase/                  reglas de seguridad de Firestore e índices
firebase.json              emuladores de Firebase
sync/sync-engine.js        motor de sincronización (se incrusta en los HTML)
tools/inline-engine.js     reincrusta el motor en los HTML  →  npm run build
tests/                     pruebas del motor, del adaptador y de extremo a extremo
docs/                      revisión de la sincronización
```

## Pruebas

```bash
npm install
npm test                    # motor: unitarias, escenarios y 300 historias aleatorias con oráculo
npm run test:emulador       # adaptador y reglas contra el emulador oficial de Firestore (necesita Java)
npm run test:navegadores    # dos navegadores reales con la app (pip install playwright && playwright install chromium)
```

`tests/reproducir-fallos-del-motor-anterior.js` ejecuta el motor anterior y muestra los fallos que motivaron el rediseño.

## Versiones

PetBase usa [Versionado Semántico](https://semver.org/lang/es/) y los cambios de cada versión están en [`CHANGELOG.md`](CHANGELOG.md). La versión actual se ve en **Ajustes**.

Para publicar una versión, anota los cambios en la sección **[Sin publicar]** del changelog y ejecuta:

```bash
npm version patch           # correcciones        1.1.0 → 1.1.1
npm version minor           # funciones nuevas    1.1.0 → 1.2.0
npm version major           # cambios que rompen  1.1.0 → 2.0.0
git push --follow-tags
```

`tools/version.js` lleva el número a `index.html`, `demo.html` y la caché del service worker (para que los móviles descarguen la versión nueva), y pone la fecha en el changelog. Si `[Sin publicar]` está vacío, se detiene.

## Privacidad

Tus datos están en tu dispositivo y, si activas la sincronización, en **tu propio proyecto** de Firebase. No hay servidor ni analítica de terceros.

## Notas

- Las claves internas de almacenamiento del navegador empiezan por `petbase_`. La demo recoge automáticamente los datos que tuvieras guardados con el nombre anterior.
- Licencia: por definir.
