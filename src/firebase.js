import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, collection, doc, getDoc, getDocs, addDoc, setDoc, updateDoc, onSnapshot, query, orderBy, limit, increment } from 'firebase/firestore';
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
export const geminiModel = params => getGenerativeModel(ai, params);

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

/* ---------- The owner (full version and admin menu), recognised by account ID ---------- */
export const OWNER_UID = 'ZqRpCKk693SVUiwWDGDATZm2qPn2';

/* ---------- Per-person app state: users/{uid}/meta/state (e.g. last memo seen) ---------- */
const stateDoc = uid => doc(db, 'users', uid, 'meta', 'state');
export async function getUserState(uid) {
  const snap = await getDoc(stateDoc(uid));
  return snap.exists() ? snap.data() : {};
}
export const setUserState = (uid, patch) => setDoc(stateDoc(uid), patch, { merge: true });

/* ---------- Memos from Dr. Stillwell: memos/{id}, written only by the owner ---------- */
const memoQuery = () => query(collection(db, 'memos'), orderBy('at', 'desc'), limit(20));
export async function fetchMemos() {
  const snap = await getDocs(memoQuery());
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
export const watchMemos = (cb, onError) => onSnapshot(memoQuery(), snap => cb(snap.docs.map(d => ({ id: d.id, ...d.data() }))), onError);
export const sendMemo = memo => addDoc(collection(db, 'memos'), memo);
export const withdrawMemo = id => updateDoc(doc(db, 'memos', id), { withdrawn: true });

/* ---------- Daily AI usage tally: stats/{day}, every app adds to it, only the owner reads it ----------
   The day follows Pacific time, because that's when Google's free allowances reset. */
export const pacificDay = (ms = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date(ms));
export const statKey = model => model.replace(/[^a-z0-9]/gi, '_');
const statsDoc = () => doc(db, 'stats', pacificDay());
export const recordUsage = model => setDoc(statsDoc(), { total: increment(1), used: { [statKey(model)]: increment(1) } }, { merge: true });
export const recordOut = (model, until) => setDoc(statsDoc(), { out: { [statKey(model)]: until } }, { merge: true });
export const watchStats = (cb, onError) => onSnapshot(statsDoc(), snap => cb(snap.exists() ? snap.data() : {}), onError);
