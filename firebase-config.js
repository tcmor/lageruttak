/* Lim inn verdiene fra Firebase-konsollen:
 * Prosjektinnstillinger (tannhjulet) → Generelt → «Dine apper» → Web-appen → «Konfigurasjon».
 * Disse verdiene er ikke hemmelige. Sikkerheten ligger i reglene (firestore.rules og storage.rules).
 */
window.GHV_FIREBASE_CONFIG = {
  apiKey: "AIzaSyDRe6sj5hLVdNC3FpyoLXxSq-PpMfb8Ycw",
  authDomain: "lageruttak-arendal.firebaseapp.com",
  projectId: "lageruttak-arendal",
  storageBucket: "lageruttak-arendal.firebasestorage.app",
  messagingSenderId: "254379116924",
  appId: "1:254379116924:web:c11683bf485e6730e9fcf9",
};
/* Region for skyfunksjonen som lar Claude lese skannede ark (må stemme med functions/index.js). */
window.GHV_FUNCTIONS_REGION = "europe-west1";
