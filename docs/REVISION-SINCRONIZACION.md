# PetBase · revisión de la sincronización con Firebase

## 1. Qué estaba mal (reproducido con dos dispositivos)

`tests/reproducir-fallos-del-motor-anterior.js` ejecuta el motor anterior y reproduce estos siete fallos:

| # | Fallo | Efecto |
|---|-------|--------|
| 1 | Se fusionaba el registro entero | Dos dispositivos editan **campos distintos** del mismo registro → se perdía una de las dos ediciones |
| 2 | Decidía la hora del dispositivo | Con el reloj 2 h atrasado, **ganaba la edición antigua** |
| 3 | Las notas de seguimiento eran un solo campo | Dos notas añadidas a la vez → **se perdía una** |
| 4 | Borrado comparado con la hora del dispositivo | Un reloj adelantado hacía que un borrado anulase una edición posterior |
| 5 | Dos pestañas escribían todo el estado | **Una pestaña borraba lo que había guardado la otra** |
| 6 | Ids con contador local + milisegundo | Dos dispositivos podían generar **el mismo id** |
| 7 | El modo claro/oscuro se sincronizaba | El modo oscuro del móvil forzaba el del ordenador |

Además: sin reintentos con espera, sin control de tamaño de documento, sin protección frente a datos de una versión futura, error de guardado local silencioso, y reglas de seguridad inexistentes.

## 2. Diseño nuevo

- **Celdas con sello.** Cada campo de un registro es una celda con un sello HLC (reloj lógico híbrido). Cada nota de seguimiento es su propia celda. Gana la celda con el sello mayor.
- **Fusión matemáticamente segura.** `mergeDocs` es conmutativa, asociativa e idempotente: da igual el orden, los reintentos y los duplicados.
- **Borrado con lápida.** Un registro vive si alguna celda es posterior a la lápida (editar después de borrar lo recupera).
- **Hora del servidor.** Al conectar se mide el desfase del reloj contra el servidor y los sellos se corrigen (también los de cambios hechos sin conexión).
- **Firestore.** Un documento por registro en `users/{uid}/records/{id}` (adiós al límite de 1 MB). Cada subida es una **transacción** que lee, fusiona con el motor y escribe; una escritura vieja que llega tarde no pisa una celda más reciente.
- **Tiempo real.** Suscripción `onSnapshot`; la subida se agrupa 1,2 s tras cada cambio.
- **Modos.** Automática (tiempo real), Al abrir, Solo manual; más Sincronizar, Subir, Bajar y Comprobar la nube.
- **Fallos.** Errores clasificados (reintentar / sesión caducada / versión futura / datos); espera exponencial con variación; lo ya confirmado se conserva; las respuestas perdidas no duplican nada.
- **Pestañas.** Nodo de reloj distinto por pestaña y fusión de estado con el evento `storage`.
- **Edición abierta.** Al guardar un formulario solo se escriben los campos que el usuario cambió.
- **Recuperación.** Nube vaciada → los dispositivos vuelven a subir lo suyo. Restaurar este dispositivo desde la nube y reemplazar la nube con este dispositivo.
- **Seguridad.** `firebase/firestore.rules`: solo el dueño; colección, versión y forma del documento validadas; `rev` obliga a `serverTimestamp()`.
- **Ajustes.** Se sincronizan paleta, tema personalizado, inicio de semana y vista del calendario. El modo claro/oscuro no.

## 3. Evidencia

| Prueba | Qué comprueba | Resultado |
|--------|---------------|-----------|
| `tests/sync-tests.js` | 27 pruebas unitarias y de escenario + fuzz: 2-4 dispositivos, relojes de hasta ±6 h, cortes de red, fallos antes y después de confirmar, reinicios, comparado con un oráculo independiente | 2 500 historias adicionales (44 460 registros) y 3 000 de pestañas sin diferencias |
| Pruebas de mutación | Se rompe el motor a propósito (sin offset, sin rebase, fusión por registro, sin sellar antes de aplicar, notas como un solo campo, mismo nodo en todas las pestañas, sin aviso de versión futura, sin resubir tras vaciar la nube…) | Las pruebas detectaron **9 de 11** roturas. Las dos que no se detectan son equivalentes: un empate exacto de sellos (imposible, cada sello lleva contador y nodo) y una red de seguridad que no se llega a ejecutar porque los valores pendientes siempre se guardan |
| `tests/fb-tests.js` | **Emulador oficial de Firestore + SDK real**: reglas, transacciones, 20 escrituras concurrentes, tiempo real, corte de servidor, fuzz | 17/17 |
| `tests/e2e-navegadores.py` | **Dos navegadores reales** con `index.html`, el SDK de Firebase de gstatic y el emulador: tiempo real, offline, reloj −3 h, notas de seguimiento a la vez, borrado, recarga, dos pestañas | 20/20 (la edición de A llega a B en ≈1,5 s) |

La prueba con navegadores reales encontró un fallo que las unitarias no veían (valores de celdas de registros borrados al fusionar pestañas); está corregido y cubierto por el fuzz.

## 4. Lo que NO se ha podido comprobar aquí

- El inicio de sesión real con Google (ventana emergente o redirección): se probó con usuario simulado del emulador. El código usa `signInWithPopup` y pasa a `signInWithRedirect` si el navegador lo bloquea.
- Un proyecto de Firebase en producción: hay que desplegar las reglas y probarlo con una cuenta real.
- iOS Safari instalado como PWA.

## 5. Puesta en marcha

Los pasos completos están en el `README.md` de la raíz. Resumen: crear el proyecto, activar **Authentication → Google** y **Firestore** (producción), autorizar el dominio, rellenar `firebase-config.js`, desplegar `firebase/firestore.rules` y publicar el repositorio (GitHub Pages sirve `index.html`).

El motor vive en `sync/sync-engine.js` y se incrusta en `index.html` y `demo.html`. Si lo modificas, ejecuta `npm run build`.

## 6. Límites conocidos

- Un documento no puede pasar de 1 MiB. Las fotos de las mascotas se reducen a 320 px (~30 KB) y los documentos mayores de 900 KB se apartan con aviso.
- Las lápidas se guardan 180 días. Un dispositivo que pase más tiempo sin conectarse podría reintroducir algo que se borró.
- Si dos dispositivos cambian **el mismo campo**, gana el más reciente (se pierde el otro valor). Es la regla esperada, pero no es una fusión de texto.
- El modo en tiempo real lee todos los documentos al abrir (cientos de lecturas); es de sobra para este uso, pero conviene vigilar la cuota si crece mucho.
