# Prescription Meditation

Dr. Stillwell asks what's going on with you, asks a couple of follow-up questions, then prescribes one guided meditation on YouTube, dosed to the time you have.

- **Sign in with Google** (Firebase Authentication)
- **Live AI doctor** (Gemini, free tier, through Firebase AI Logic)
- **Voice input** (the browser's speech recognition: Chrome, Edge, Safari)
- **A real video, played in the app** (YouTube Data API; optional, it falls back to a YouTube search link)
- **Favourites, dislikes and a patient file** saved privately per person (Cloud Firestore)
- Repeats a prescription only when your mood is near-identical to an earlier one

## One-time setup

### 1. Firebase (console.firebase.google.com)
1. **Authentication** → Get started → Sign-in method → **Google** → Enable → Save.
2. **Firestore Database** → Create database → production mode.
3. **AI Logic** → Get started → choose the **Gemini Developer API** (free).
4. **Project settings** → Your apps → **</>** (web) → register the app → copy the `firebaseConfig` values into `.env.local`:

```
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=...
VITE_FIREBASE_PROJECT_ID=...
VITE_FIREBASE_STORAGE_BUCKET=...
VITE_FIREBASE_MESSAGING_SENDER_ID=...
VITE_FIREBASE_APP_ID=...
```

### 2. YouTube key (optional, but it's what makes a specific video play in the app)
1. Go to console.cloud.google.com and pick the **same project** Firebase created.
2. APIs & Services → Library → **YouTube Data API v3** → Enable.
3. APIs & Services → Credentials → Create credentials → **API key**.
4. Edit the key: under *Application restrictions* choose **Websites** and add `http://localhost:5173/*` and `https://thespectrumtechengine.com/*`. Under *API restrictions* allow only YouTube Data API v3.
5. Put it in `.env.local` as `VITE_YOUTUBE_API_KEY=...`

The free quota is about 100 prescriptions a day (each costs ~101 units of the 10,000 daily).

## Run it on your computer

```bash
npm install
npm run dev
```

Open http://localhost:5173

## Put it online

The app is published automatically to **https://thespectrumtechengine.com/prescription-meditation/** by GitHub Pages.
Every push to `main` runs `.github/workflows/deploy.yml`, which builds the app and publishes it.

The settings from `.env.local` are stored as repository secrets (Settings → Secrets and variables → Actions),
because `.env.local` itself is never committed. If you change a key, update the matching secret too.

Google sign-in only works on addresses listed in Firebase → Authentication → Settings → **Authorised domains**
(`localhost` and `thespectrumtechengine.com`).

The database rules live in `firestore.rules`. Paste them into Firebase → Firestore → Rules if you change them.

## Before sharing it widely
- Turn on **App Check** (Firebase console → App Check) so only your site can use your free AI quota.
- The free Gemini tier may use requests to improve Google's products; the sign-in screen says so. Switching the project to a paid plan changes that.
- Each Gemini model has its own small free daily allowance, so `src/doctor.js` (`CHAINS`) spreads requests across several and moves on when one runs out. Adding billing to the Firebase project removes the daily limits.

## Files
- `src/doctor.js` – Dr. Stillwell's instructions: follow-up questions and the prescription
- `src/youtube.js` – picks the best real video (length, teacher, never one you disliked)
- `src/firebase.js` – sign-in, saving, AI connection
- `src/main.js` – the screens
- `firestore.rules` – who can read and write what
