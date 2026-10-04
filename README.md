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

### 3. Calendarios de Google y Outlook (opcional)

PetBase copia las citas, la medicación, los cuidados y los eventos a un calendario propio llamado **PetBase** dentro de la cuenta de Google o de Microsoft que elijas (en **Ajustes → Calendario**). Va en un solo sentido: lo que se cambia en PetBase llega al calendario, y lo que se cambia en el calendario se sobrescribe. No hace falta servidor. Solo necesitas un identificador de cliente de cada servicio, que va en `window.PETBASE_CALENDAR` dentro de `firebase-config.js`. No son secretos.

**Google Calendar** (`googleClientId`)

1. En la [consola de Google Cloud](https://console.cloud.google.com), elige el mismo proyecto que usa Firebase.
2. *APIs y servicios → Biblioteca*: activa **Google Calendar API**.
3. *APIs y servicios → Pantalla de consentimiento de OAuth*: añade el permiso `.../auth/calendar.app.created` (solo deja crear calendarios propios y tocar los suyos, no ve el resto). Mientras la app esté en modo *Prueba*, añade como *usuarios de prueba* las cuentas que la vayan a usar.
4. *APIs y servicios → Credenciales*: abre el **cliente web** que creó Firebase (o crea uno de tipo *Aplicación web*). En *Orígenes de JavaScript autorizados*, añade el de tu web (por ejemplo `https://tuusuario.github.io`) y, para probar en local, `http://localhost:8000`.
5. Copia el *ID de cliente* (`…apps.googleusercontent.com`) en `googleClientId`.

Google da permisos de una hora y desde una web sin servidor no se pueden renovar solos. Mientras dure el permiso, cada cambio se copia al momento. Cuando caduca, Ajustes muestra «Toca para dar permiso» y basta con tocar ahí.

**Outlook** (`outlookClientId`)

1. En el [portal de Azure](https://portal.azure.com) → *Microsoft Entra ID → Registros de aplicaciones → Nuevo registro*.
2. Tipos de cuenta: **cuentas de cualquier directorio y cuentas personales de Microsoft** (para que funcionen las de outlook.com y hotmail.com).
3. URI de redireccionamiento: plataforma **Aplicación de página única (SPA)** con la dirección de `auth.html` en tu web, por ejemplo `https://tuusuario.github.io/PetBase/auth.html`. Para probar en local, añade también `http://localhost:8000/auth.html`.
4. *Permisos de API*: Microsoft Graph, permisos delegados `Calendars.ReadWrite` y `User.Read`.
5. Copia el *Id. de aplicación (cliente)* en `outlookClientId`.

Con Outlook el permiso se renueva solo durante unas 24 horas. Después, Ajustes pide tocar para darlo otra vez.

**Cómo funciona**

- Se copia lo pendiente y lo hecho en los últimos 60 días (marcado con ✓). Las repeticiones diarias, semanales, mensuales y anuales van como serie. Las de «cada N horas» van como tomas sueltas, hasta 60 tomas o 30 días, porque ni Google ni Outlook repiten por horas.
- Cada evento lleva una marca oculta con el registro de PetBase. Así, varios dispositivos vinculados a la misma cuenta no duplican eventos, y si alguno se duplica se borra en la siguiente pasada.
- La vinculación es de cada dispositivo y no viaja en las copias exportadas. Al desvincular, puedes borrar el calendario PetBase o dejarlo como está.

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
auth.html                  vuelta del inicio de sesión de Microsoft (Outlook)
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

`tools/version.js` lleva el número a `index.html`, `demo.html`, la caché del service worker y `version.json`, y pone la fecha en el changelog. La app consulta `version.json` al abrirse y cada 30 minutos: si hay una versión más nueva, avisa con un botón **Actualizar**. En **Ajustes → Acerca de** están también «Buscar actualizaciones» y «Borrar caché y recargar» (no toca los datos). Si `[Sin publicar]` está vacío, se detiene.

## Privacidad

Tus datos están en tu dispositivo y, si activas la sincronización, en **tu propio proyecto** de Firebase. No hay servidor ni analítica de terceros.

## Notas

- Las claves internas de almacenamiento del navegador empiezan por `petbase_`. La demo recoge automáticamente los datos que tuvieras guardados con el nombre anterior.
- Licencia: por definir.
