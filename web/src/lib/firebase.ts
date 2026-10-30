// Firebase client (browser). These config values are public by design — they identify the project,
// they are not secrets. Security comes from Firebase Auth + the Firestore rules, not from hiding them.
import { initializeApp, getApps, getApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyDJEVAiRUXRwBKu5kdcr75rMOqC-WnfzZQ",
  authDomain: "latafti.com", // same-site auth handler (proxied in next.config.ts) — see that file
  projectId: "latafti",
  storageBucket: "latafti.firebasestorage.app",
  messagingSenderId: "1072018674493",
  appId: "1:1072018674493:web:e387cd601760ee98406b54",
};

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
