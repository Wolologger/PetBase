# Changelog

Todos los cambios importantes de PetBase se anotan aquí.

El formato sigue [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y la numeración, [Versionado Semántico](https://semver.org/lang/es/):

- **MAYOR** (`2.0.0`): cambios que rompen datos guardados, copias exportadas o la sincronización con versiones anteriores.
- **MENOR** (`1.2.0`): funciones nuevas que no rompen nada.
- **PARCHE** (`1.1.1`): correcciones.

Cómo publicar una versión: anota los cambios en **[Sin publicar]** y ejecuta `npm version patch`, `minor` o `major`. El script pone la versión en `package.json`, la app, el service worker y este archivo, hace el commit y crea la etiqueta `vX.Y.Z`.

## [Sin publicar]

## [1.1.0] - 2026-10-04

### Añadido
- Pantalla de acceso: con Firebase configurado hay que iniciar sesión con Google antes de usar la app. Si ya habías entrado antes y no hay conexión, se puede seguir con los datos del dispositivo.
- Mensajes claros cuando falla el inicio de sesión (dominio no autorizado, sin conexión, ventana cerrada).
- Manifest preparado para generar la APK: iconos *maskable*, icono para iOS, capturas de pantalla y atajos.
- Número de versión visible en Ajustes e incluido en las copias exportadas (`appVersion`).

### Cambiado
- El service worker pide primero a la red las páginas y scripts, así siempre se carga la última versión; la copia guardada solo se usa sin conexión. La caché lleva el número de versión y la anterior se borra al actualizar.
- El service worker también se registra en `localhost` para poder probarlo en local.

### Corregido
- Fotos de mascotas: respetan la orientación de la cámara, las imágenes con transparencia ya no quedan sobre fondo negro, se reduce la calidad si pesan demasiado para sincronizar y se avisa si la imagen no se puede leer.

## [1.0.0] - 2026-10-04

Primera versión.

### Añadido
- Mascotas con ficha veterinaria: chip, alergias y condiciones, curva de peso, vacunas, desparasitación e historial de visitas con notas de seguimiento.
- Calendario en vista de mes, semana y agenda, con filtros, aviso de choques de horario y exportación a `.ics`.
- Medicamentos y cuidados con repetición personalizada y dosis por peso.
- Diario y hábitos: notas, paseos con cronómetro, toques rápidos y comidas.
- Control del pienso: duración de cada saco y de los anteriores.
- Resúmenes diario, semanal, mensual, anual y total, comparados con el periodo anterior.
- Sincronización en tiempo real con Firebase (fusión campo a campo con reloj lógico híbrido) y reglas de seguridad de Firestore.
- Exportar todo en un `.zip` (JSON, CSV, notas e `.ics`).
- Seis temas más uno personalizado, modo claro y oscuro.
- PWA instalable que funciona sin conexión, y `demo.html` con datos de ejemplo.

[Sin publicar]: https://github.com/Wolologger/PetBase/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/Wolologger/PetBase/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/Wolologger/PetBase/releases/tag/v1.0.0
