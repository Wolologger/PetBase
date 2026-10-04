/* Configuración de Firebase para PetBase.
   Mientras valga null, la app funciona solo en este dispositivo (sin cuenta ni nube).
   Para activar la sincronización, sustituye null por tus datos
   (consola de Firebase → Configuración del proyecto → Tus apps → Web):

   window.PETBASE_FIREBASE = {
     sdk: '10.14.1',
     config: {
       apiKey: '...',
       authDomain: 'tu-proyecto.firebaseapp.com',
       projectId: 'tu-proyecto',
       appId: '...'
     }
   };

   La apiKey de una app web NO es secreta: lo que protege tus datos son las reglas de firebase/firestore.rules.
*/
window.PETBASE_FIREBASE = null;
