import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, collection, doc, setDoc, updateDoc, onSnapshot, query, orderBy, limit } from 'firebase/firestore';
import { getAI, getGenerativeModel, GoogleAIBackend } from 'firebase/ai';
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'firebase/app-check';

const env = import.meta.env;
const config = {
  apiKey: env.VITE_FIREBASE_API_KEY,
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: env.VITE_FIREBASE_APP_ID,
};

export const configured = Boolean(config.apiKey && config.projectId && config.appId);
export const MODEL = env.VITE_GEMINI_MODEL || 'gemini-3.6-flash';

let auth, db, ai;
if (configured) {
  const app = initializeApp(config);
  // App Check proves requests come from this site, so nobody else can spend the free AI quota.
  if (env.VITE_RECAPTCHA_SITE_KEY) {
    initializeAppCheck(app, { provider: new ReCaptchaEnterpriseProvider(env.VITE_RECAPTCHA_SITE_KEY), isTokenAutoRefreshEnabled: true });
  }
  auth = getAuth(app);
  db = getFirestore(app);
  ai = getAI(app, { backend: new GoogleAIBackend() });
}


/* ---------- AI ---------- */
export const geminiModel = params => getGenerativeModel(ai, { model: MODEL, ...params });

/* ---------- Accounts ---------- */
export function signIn() {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  return signInWithPopup(auth, provider);
}
export const logOut = () => signOut(auth);
export function watchUser(cb) {
  if (!configured) { cb(null); return () => {}; }
  return onAuthStateChanged(auth, cb);
}

/* ---------- Patient file: users/{uid}/prescriptions/{rxId} ---------- */
const rxCol = uid => collection(db, 'users', uid, 'prescriptions');

export function watchPrescriptions(uid, onRxs, onError) {
  return onSnapshot(
    query(rxCol(uid), orderBy('at', 'desc'), limit(300)),
    snap => onRxs(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
    onError,
  );
}
export function savePrescription(uid, rx) {
  const { id, ...body } = rx;
  return setDoc(doc(rxCol(uid), id), body);
}
export const updatePrescription = (uid, id, patch) => updateDoc(doc(rxCol(uid), id), patch);
