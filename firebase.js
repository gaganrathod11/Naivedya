import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { initializeFirestore, memoryLocalCache } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyBR_dmmN97konQ_d-i8ZFz7nPCy8I4gOMs",
  authDomain: "shop-management-a41fb.firebaseapp.com",
  projectId: "shop-management-a41fb",
  storageBucket: "shop-management-a41fb.firebasestorage.app",
  messagingSenderId: "32264494001",
  appId: "1:32264494001:web:6cb7fd7338f58b9561bb90"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

// This forces the app to always fetch fresh data from the internet, ignoring broken phone caches.
export const db = initializeFirestore(app, {
  localCache: memoryLocalCache()
});