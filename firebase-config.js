/* Configuración de Firebase para PetBase.
   La apiKey de una app web no es secreta: lo que protege tus datos son las reglas de Firestore. */
window.PETBASE_FIREBASE = {
  sdk: '10.14.1',
  config: {
    apiKey: 'AIzaSyDeDBQlwy8wqQRC6m61fNPKcImoVnZ-rn8',
    authDomain: 'petbase-c6e2c.firebaseapp.com',
    projectId: 'petbase-c6e2c',
    appId: '1:770463306375:web:ef0393b4778e635e6a5e22'
  }
};

/* Calendarios (opcional). Sin estos identificadores, los botones de Google Calendar y Outlook avisan de que faltan.
   Cómo conseguirlos: README.md → «Calendarios de Google y Outlook». No son secretos. */
window.PETBASE_CALENDAR = {
  googleClientId: null,   // 'xxxxxxxxxxxx-xxxxxxxx.apps.googleusercontent.com'
  outlookClientId: null   // 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'
};
