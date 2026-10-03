import './style.css';
import {
  configured, signIn, logOut, watchUser, watchPrescriptions, savePrescription, updatePrescription,
  OWNER_UID, getUserState, setUserState, fetchMemos, watchMemos, sendMemo, withdrawMemo,
  recordUsage, recordOut, watchStats, statKey,
  recordYoutubeSearch, bumpMetrics, fetchMetrics, fetchTotals, dublinDay as irishDay, deletePrescriptionHistory,
} from './firebase.js';
import {
  MODES, askFollowUp, aftercareReply, writePrescription, errorCopy,
  ALL_MODELS, restingOnThisDevice, setUsageReporter, lastModel,
} from './doctor.js';
import { youtubeEnabled, findVideo, searchUrl, watchUrl, validId } from './youtube.js';
import { ringBell, isSoundOn, setSoundOn, BELL_SVG, drawBells } from './bell.js';

const $ = s => document.querySelector(s);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const wait = ms => new Promise(r => setTimeout(r, ms));
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const thread = $('#thread'), nextStep = $('#next-step'), msg = $('#msg'), sendBtn = $('#send');

const S = {
  user: null, rxs: [], unwatch: null,
  mode: 'standard', turns: [], moodWords: [], patientTurns: 0,
  busy: false, ctl: null, lastRx: null,
  phase: 'intake',          // 'intake' → 'aftercare' (after a prescription) → 'closed' (free plan, done for today)
  currentRx: null, crisisShown: false, loaded: null,
  stats: undefined, memos: [], unwatchOwner: [],
};

/* ---------- plan: free version for everyone, full version for the owner ---------- */
const readPref = (k, d = null) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const writePref = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} };
const isOwner = () => !!S.user && S.user.uid === OWNER_UID;
// The owner can preview the free version; that preview has its own test day so real use doesn't count.
const previewing = () => isOwner() && readPref('pm-view-free') === '1';
const isFull = () => isOwner() && !previewing();
const testStart = () => Number(readPref('pm-test-start', '0')) || 0;
const dublinDay = ms => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Dublin' }).format(new Date(ms));
function todaysRxs() {
  const all = S.lastRx && !S.rxs.some(r => r.id === S.lastRx.id) ? [S.lastRx, ...S.rxs] : S.rxs;
  const today = dublinDay(Date.now());
  return all.filter(r => r.at && dublinDay(r.at) === today && (!previewing() || (r.test && r.at >= testStart())));
}
// Backup count kept on the device too, so the daily limit holds even if the patient file can't be reached.
const usageKey = () => 'pm-usage-' + (previewing() ? 'preview-' : '') + (S.user?.uid || '');
function localUsage() {
  try {
    const u = JSON.parse(localStorage.getItem(usageKey()));
    if (u && u.day === dublinDay(Date.now())) return u;
  } catch {}
  return { day: dublinDay(Date.now()), main: 0, swap: 0 };
}
function countLocally(swap) {
  const u = localUsage();
  u[swap ? 'swap' : 'main']++;
  try { localStorage.setItem(usageKey(), JSON.stringify(u)); } catch {}
}
const canConsult = () => isFull() || (!todaysRxs().some(r => !r.swap) && localUsage().main < 1);   // one prescription a day
const canSwap = () => isFull() || (!todaysRxs().some(r => r.swap) && localUsage().swap < 1);       // plus one swap if it wasn't right
const CLOSED_LINE = "That's all from me for today on the free plan. I'll be here tomorrow morning for your next prescription, and your saved meditations are in Favourites any time.";

/* ---------- anonymous app stats (counts only; the owner's own use isn't counted) ---------- */
// Accounts created before stats existed are already in the backfilled total, so only later ones count as new.
const STATS_START = Date.parse('2026-10-03T15:47:55Z');
function count(counts) {
  if (!S.user || isOwner()) return;
  bumpMetrics(counts).catch(() => {});
}
const isoWeek = (ms = Date.now()) => {
  const d = new Date(irishDay(ms) + 'T12:00:00Z');
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const jan4 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  return d.getUTCFullYear() + '-W' + String(1 + Math.round(((d - jan4) / 864e5 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7)).padStart(2, '0');
};
// Once per person per day/week: active today, active this week, and new accounts.
async function countVisit() {
  if (!S.user || isOwner()) return;
  try {
    const st = await getUserState(S.user.uid);
    const today = irishDay(), week = isoWeek();
    const counts = {}, patch = {};
    if (st.lastActiveDay !== today) { counts.active = 1; patch.lastActiveDay = today; }
    if (st.lastActiveWeek !== week) { counts.activeWeek = 1; patch.lastActiveWeek = week; }
    if (!st.counted) {
      patch.counted = true;
      const created = Date.parse(S.user.metadata?.creationTime || '') || 0;
      if (created >= STATS_START) {
        counts.newUsers = 1;
        bumpMetrics({ users: 1 }, 'totals').catch(() => {});
      }
    }
    if (Object.keys(patch).length) await setUserState(S.user.uid, patch);
    if (Object.keys(counts).length) await bumpMetrics(counts);
  } catch (e) { console.warn('visit count', e); }
}

/* ---------- crisis safety net: shown instantly, no AI needed ---------- */
const CRISIS = /\b(suicid\w*|kill(ing)? my ?self|end(ing)? (my|it) (life|all)|take my (own )?life|self[- ]?harm\w*|hurt(ing)? my ?self|cut(ting)? my ?self|want(ed)? to die|wish i (was|were) dead|better off dead|no (reason|point) (to|in) (live|living|go on)|don'?t want to (live|be alive|be here|wake up)|overdos\w*)\b/i;
function crisisCard() {
  const card = el('aside', 'crisis');
  card.setAttribute('role', 'note');
  card.append(el('h3', '', "You don't have to carry this alone"));
  card.append(el('p', '', "If you're thinking about ending your life or hurting yourself, please talk to someone now. These are free and open day and night:"));
  const ul = el('ul');
  [['Samaritans (Ireland and UK)', 'Call 116 123', 'tel:116123'],
   ['Text About It (Ireland)', 'Text HELLO to 50808', 'sms:50808?body=HELLO'],
   ['Shout (UK)', 'Text SHOUT to 85258', 'sms:85258?body=SHOUT'],
   ['988 Lifeline (US)', 'Call or text 988', 'tel:988'],
   ['In an emergency', 'Call 112 or 999 (Ireland, UK) or 911 (US)', 'tel:112'],
  ].forEach(([who, how, href]) => {
    const li = el('li'); li.append(el('strong', '', who + ': '));
    const a = el('a', '', how); a.href = href; li.append(a); ul.append(li);
  });
  card.append(ul, el('p', 'crisis-foot', "I'm still here, and we'll keep going together."));
  return card;
}

setUsageReporter({
  used: model => { if (S.user) recordUsage(model).catch(() => {}); },
  out: (model, until) => { if (S.user) recordOut(model, until).catch(() => {}); },
});

const BELL = BELL_SVG;
drawBells();
const ICON = {
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg>',
  heart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/></svg>',
  down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M10 15v4a3 3 0 0 0 3 3l4-9V3H6.7a2 2 0 0 0-2 1.7l-1.4 9A2 2 0 0 0 5.3 16H10z"/><path d="M17 3h3v10h-3"/></svg>',
  bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 21h4"/></svg>',
  link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
};

/* ---------- Android app download (hidden inside the app itself) ---------- */
const inApp = (() => {
  try {
    if (new URLSearchParams(location.search).get('source') === 'android') sessionStorage.setItem('pm-in-app', '1');
    return sessionStorage.getItem('pm-in-app') === '1' || document.referrer.startsWith('android-app://');
  } catch { return false; }
})();
if (!inApp && !import.meta.env.DEV) document.querySelectorAll('.get-app').forEach(a => { a.hidden = false; });

/* ---------- screens & sign-in ---------- */
function show(screen) {
  $('#setup').hidden = screen !== 'setup';
  $('#gate').hidden = screen !== 'gate';
  $('#app').hidden = screen !== 'app';
}

$('#signin').onclick = async () => {
  $('#gate-note').textContent = '';
  try { await signIn(); }
  catch (e) {
    const c = e?.code || '';
    if (c === 'auth/popup-closed-by-user' || c === 'auth/cancelled-popup-request') return;
    $('#gate-note').textContent =
      c === 'auth/unauthorized-domain' ? "This web address isn't allowed to sign in yet. Add it under Authentication → Settings → Authorised domains in Firebase."
      : c === 'auth/popup-blocked' ? 'Your browser blocked the sign-in window. Allow pop-ups for this site and try again.'
      : c === 'auth/operation-not-allowed' ? 'Google sign-in is not switched on yet. Enable it under Authentication → Sign-in method in Firebase.'
      : "Sign-in didn't work. Try again in a moment.";
  }
};
$('#signout').onclick = () => logOut();
$('#gate-bell').addEventListener('click', ringBell);

if (!configured) show('setup');
else watchUser(user => {
  S.unwatch?.(); S.unwatch = null;
  S.unwatchOwner.forEach(u => u()); S.unwatchOwner = [];
  S.user = user; S.rxs = []; S.stats = undefined; S.memos = [];
  if (!user) { show('gate'); return; }
  let markLoaded; S.loaded = new Promise(r => { markLoaded = r; });
  setTimeout(() => markLoaded(), 5000);
  show('app');
  const patient = $('#patient');
  const name = user.displayName || 'You';
  if (user.photoURL) { const img = el('img'); img.src = user.photoURL; img.alt = ''; img.referrerPolicy = 'no-referrer'; patient.replaceChildren(img, el('span', '', name)); }
  else patient.replaceChildren(el('span', '', name));
  S.unwatch = watchPrescriptions(user.uid, rxs => { S.rxs = rxs; renderLists(); markLoaded(); },
    err => { console.error(err); sysNote("Your patient file couldn't be loaded. Check the Firestore rules are deployed.", true); });
  if (isOwner()) {
    S.unwatchOwner.push(
      watchStats(st => { S.stats = st; if (admin.open) renderAllowance(); }, e => { console.warn(e); S.stats = null; }),
      watchMemos(list => { S.memos = list; if (admin.open) renderMemoList(); }, e => console.warn(e)),
    );
  }
  renderPlan();
  renderLists();
  greet();
  S.loaded.then(checkMemo);
  countVisit();
});

function renderPlan() {
  const full = isFull();
  const chip = $('#plan');
  chip.textContent = full ? 'Full version' : previewing() ? 'Free plan · preview' : 'Free plan';
  chip.classList.toggle('full', full);
  chip.classList.toggle('owner', isOwner());
  chip.disabled = !isOwner();
  chip.title = isOwner() ? 'Open the admin menu' : '';
  $('#preview-strip').hidden = !previewing();
  const deep = modeEl.querySelector('[data-mode="deep"]');
  deep.classList.toggle('premium', !full);
  deep.title = full ? '' : 'Part of the full version';
  if (!full && S.mode === 'deep') {
    S.mode = 'standard';
    modeEl.querySelectorAll('button').forEach(x => x.setAttribute('aria-checked', String(x.dataset.mode === 'standard')));
  }
}

/* ---------- bell & sound ---------- */
const soundBtn = $('#sound');
soundBtn.setAttribute('aria-pressed', String(isSoundOn()));
soundBtn.onclick = () => { const on = !isSoundOn(); setSoundOn(on); soundBtn.setAttribute('aria-pressed', String(on)); if (on) ringBell(); };
const hero = $('#hero-bell');
hero.onclick = ringBell;
hero.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ringBell(); } };

/* ---------- tabs ---------- */
document.querySelectorAll('.tab').forEach(t => (t.onclick = () => showView(t.dataset.view)));
function showView(v) {
  document.querySelectorAll('.tab').forEach(t => t.setAttribute('aria-selected', String(t.dataset.view === v)));
  ['consult', 'fav', 'file'].forEach(k => { $('#view-' + k).hidden = k !== v; });
}

/* ---------- consultation length ---------- */
const modeEl = $('#mode');
modeEl.querySelectorAll('button').forEach(b => (b.onclick = () => {
  if (modeEl.classList.contains('locked')) return;
  if (b.dataset.mode === 'deep' && !isFull()) { sysNote('Take your time is part of the full version. The standard consultation is here for you every day.'); return; }
  S.mode = b.dataset.mode;
  modeEl.querySelectorAll('button').forEach(x => x.setAttribute('aria-checked', String(x === b)));
}));
function lockMode(locked) {
  modeEl.classList.toggle('locked', locked);
  modeEl.querySelectorAll('button').forEach(b => { b.disabled = locked; });
}

/* ---------- thread helpers ---------- */
function scrollDown() { requestAnimationFrame(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: reduced ? 'auto' : 'smooth' })); }
function addMsg(who, text) {
  const row = el('div', 'msg ' + (who === 'doctor' ? 'doctor' : 'patient-msg'));
  if (who === 'doctor') row.insertAdjacentHTML('afterbegin', BELL);
  const b = el('div', 'bubble'), t = el('p', '', text || '');
  b.append(t); row.append(b); thread.append(row); scrollDown();
  return t;
}
function typingDots(t) { const d = el('span', 'typing'); d.append(el('i'), el('i'), el('i')); d.setAttribute('aria-label', 'Dr. Stillwell is typing'); t.replaceChildren(d); }
function sysNote(text, warn) { const n = el('div', 'sys' + (warn ? ' warn' : ''), text); thread.append(n); scrollDown(); return n; }
async function typeInto(t, str) {
  if (reduced) { t.textContent = str; return; }
  typingDots(t); await wait(700);
  for (let i = 0; i < str.length; i++) { t.textContent = str.slice(0, i + 1); await wait('.?'.includes(str[i]) ? 160 : 18); }
}
function partOfDay() { const h = new Date().getHours(); return h < 5 ? 'Still up' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'; }
function setNext(...buttons) { nextStep.replaceChildren(...buttons); }
function button(label, cls, onClick, icon) {
  const b = el('button', 'btn ' + (cls || '')); b.type = 'button';
  if (icon) b.insertAdjacentHTML('afterbegin', icon);
  b.append(document.createTextNode(label)); b.onclick = onClick; return b;
}
function setBusy(b) { S.busy = b; sendBtn.disabled = b; }

/* ---------- consultation ---------- */
async function greet() {
  S.ctl?.abort();
  S.turns = []; S.moodWords = []; S.patientTurns = 0; S.lastRx = null;
  S.phase = 'intake'; S.currentRx = null; S.crisisShown = false;
  setBusy(false); lockMode(false);
  thread.replaceChildren(); setNext();
  await S.loaded;
  const first = (S.user?.displayName || '').split(' ')[0];
  const hello = `${partOfDay()}${first ? ', ' + first : ''}.`;

  if (!isFull()) {
    const key = 'pm-free-notice-' + S.user.uid;
    let seen = false; try { seen = localStorage.getItem(key) === '1'; } catch {}
    if (!seen) {
      const note = el('aside', 'plan-note');
      note.append(el('strong', '', "You're on the free plan"),
        el('span', '', "You get one meditation prescription a day. If it isn't right for you, tap \u201cNot for me\u201d and I'll find you another."));
      thread.append(note);
      try { localStorage.setItem(key, '1'); } catch {}
    }
  }

  // Free plan: today's prescription is already written. Show it again and let them talk about it.
  if (!canConsult() && !todaysRxs().length) {
    S.phase = 'closed';
    count({ limitHit: 1 });
    await doctorSays(`${hello} Welcome back. You've had today's prescription already. I'll be here tomorrow morning for your next one.`);
    return;
  }
  if (!canConsult()) {
    const rx = todaysRxs()[0];
    count({ limitHit: 1 });
    await doctorSays(`${hello} Welcome back. Here's today's prescription again, ready whenever you are.`);
    thread.append(renderSlip(rx, { context: 'chat' })); scrollDown();
    S.currentRx = rx; S.lastRx = rx;
    S.turns.push({ role: 'assistant', content: `[Prescribed earlier today ${rx.no}: "${rx.title}", ${rx.technique} with ${rx.teacher}, ${rx.minutes} minutes]` });
    if (!rx.aftercare) {
      S.phase = 'aftercare';
      await doctorSays('If you have taken it, tell me how it went.');
    } else {
      S.phase = 'closed';
      await doctorSays("I'll be here tomorrow morning for your next one.");
    }
    return;
  }

  const g = `${hello} I'm Dr. Stillwell. What's going on with you?`;
  await doctorSays(g);
  const second = "Tell me how you're feeling, anything you're worried about, and how much time you have. However it comes out is fine.";
  await doctorSays(second);
  S.turns.push({ role: 'assistant', content: g + ' ' + second });
}

/** A doctor line written by the app itself (no AI request). */
async function doctorSays(text) { const t = addMsg('doctor'); await typeInto(t, text); }

async function send(text) {
  text = text.trim();
  if (!text || S.busy) return;
  stopListening();
  msg.value = ''; autosize();
  const mine = addMsg('patient', text);
  if (CRISIS.test(text) && !S.crisisShown) { S.crisisShown = true; thread.append(crisisCard()); scrollDown(); count({ crisis: 1 }); }
  if (S.phase === 'closed') { await doctorSays(CLOSED_LINE); return; }
  if (S.phase === 'aftercare') { await aftercare(text, mine); return; }
  if (!canConsult()) { S.phase = 'closed'; await doctorSays(CLOSED_LINE); return; }
  S.turns.push({ role: 'user', content: text });
  S.moodWords.push(text);
  S.patientTurns++;
  if (S.patientTurns === 1) count({ consults: 1 });
  lockMode(true);
  setNext();

  const n = S.patientTurns;                       // the follow-up question the doctor would ask now
  if (n > MODES[S.mode].max) { await handOver(); return; }

  const t = addMsg('doctor'); typingDots(t);
  setBusy(true);
  S.ctl = new AbortController();
  let out;
  try {
    out = await askFollowUp({
      turns: S.turns, n, mode: S.mode, signal: S.ctl.signal,
      onText: shown => { t.textContent = shown; scrollDown(); },
    });
  } catch (e) {
    setBusy(false);
    // Take the message back so sending again doesn't repeat it in the chat or the doctor's notes.
    S.patientTurns--; S.turns.pop(); S.moodWords.pop();
    t.closest('.msg').remove(); mine.closest('.msg').remove();
    if (!msg.value.trim()) { msg.value = text; autosize(); }
    if (S.patientTurns === 0) lockMode(false);
    if (e?.name === 'AbortError') return;
    console.error(e);
    if (e?.code === 'full') count({ aiFull: 1 });
    sysNote(errorCopy(e), true);
    return;
  }
  setBusy(false);
  const reply = out.reply || 'Tell me a little more about that?';
  t.textContent = reply;
  modelTag(t);
  S.turns.push({ role: 'assistant', content: reply });
  if (out.ready) { await wait(500); await prescribe(); }
}

async function aftercare(text, mine) {
  const rx = S.currentRx;
  if (!isFull() && (rx?.aftercare || 0) >= 1) {
    S.phase = 'closed';
    await doctorSays("Let's leave it there for today. On the free plan we pick this up again tomorrow, and I'll remember what you told me.");
    return;
  }
  S.turns.push({ role: 'user', content: text });
  const t = addMsg('doctor'); typingDots(t);
  setBusy(true);
  S.ctl = new AbortController();
  let reply;
  try {
    reply = await aftercareReply({ turns: S.turns, rx, signal: S.ctl.signal, onText: shown => { t.textContent = shown; scrollDown(); } });
  } catch (e) {
    setBusy(false);
    S.turns.pop();
    t.closest('.msg').remove(); mine.closest('.msg').remove();
    if (!msg.value.trim()) { msg.value = text; autosize(); }
    if (e?.name === 'AbortError') return;
    console.error(e);
    if (e?.code === 'full') count({ aiFull: 1 });
    sysNote(errorCopy(e), true);
    return;
  }
  setBusy(false);
  reply = reply || "Thank you for telling me. I'll keep that in mind for next time.";
  t.textContent = reply;
  modelTag(t);
  S.turns.push({ role: 'assistant', content: reply });
  if (rx) {
    const note = [rx.afterNote, text].filter(Boolean).join(' / ').slice(0, 600);
    patch(rx.id, { aftercare: (rx.aftercare || 0) + 1, afterNote: note });
    count({ aftercare: 1 });
  }
}

async function handOver() {
  const t = addMsg('doctor');
  await typeInto(t, 'Thank you. I have what I need. Let me write something for you.');
  await prescribe();
}

function nextNo() {
  const max = S.rxs.reduce((m, r) => Math.max(m, parseInt(String(r.no || '').replace(/\D/g, ''), 10) || 0), 0);
  return 'RX-' + String(max + 1).padStart(4, '0');
}

async function prescribe(extra, { swap = false } = {}) {
  if (S.busy) return;
  if (!(swap ? canSwap() : canConsult())) { S.phase = 'closed'; await doctorSays(CLOSED_LINE); return; }
  setBusy(true); setNext();
  const card = el('div', 'writing');
  card.innerHTML = '<svg viewBox="0 0 64 24" aria-hidden="true"><path d="M2 16c6-10 9 6 14-2s7-6 10 0 6 4 10-3 7 1 10 3 8-2 16-4"/></svg>';
  const words = el('div', 'grow', 'Dr. Stillwell is writing your prescription…');
  S.ctl = new AbortController();
  card.append(words, button('Stop', '', () => S.ctl.abort()));
  thread.append(card); scrollDown();

  let rx;
  try {
    rx = await writePrescription({ turns: S.turns, rxs: S.rxs, extra, signal: S.ctl.signal });
  } catch (e) {
    card.remove(); setBusy(false);
    if (e?.name !== 'AbortError') { console.error(e); if (e?.code === 'full') count({ aiFull: 1 }); sysNote(errorCopy(e), true); }
    setNext(button('Write my prescription', '', () => prescribe(extra, { swap }), ICON.bell));
    return;
  }

  const prev = rx.repeatOf && S.rxs.find(x => x.id === rx.repeatOf && !x.disliked);
  if (prev) {
    rx = { ...rx, title: prev.title, technique: prev.technique, teacher: prev.teacher, minutes: prev.minutes, query: prev.query, repeatOf: prev.id, repeatNo: prev.no || '' };
  } else { rx.repeatOf = null; rx.repeatNo = ''; }

  // Find the actual video. Never re-serve a video already prescribed or disliked, unless this is a repeat.
  Object.assign(rx, { videoId: null, videoTitle: '', videoChannel: '', videoSeconds: 0 });
  if (prev && validId(prev.videoId)) {
    Object.assign(rx, { videoId: prev.videoId, videoTitle: prev.videoTitle || '', videoChannel: prev.videoChannel || '', videoSeconds: prev.videoSeconds || 0 });
  } else if (youtubeEnabled) {
    words.textContent = 'Finding the right recording…';
    const exclude = new Set(S.rxs.map(r => r.videoId).filter(Boolean));
    if (S.user) recordYoutubeSearch().catch(() => {});
    try { const v = await findVideo(rx, exclude); if (v) Object.assign(rx, v); }
    catch (e) { console.warn(e); }
  }

  rx.at = Date.now();
  rx.id = 'rx_' + rx.at;
  rx.no = nextNo();
  rx.mood = S.moodWords.join(' / ').slice(0, 800);
  rx.mode = S.mode;
  rx.fav = false; rx.disliked = false; rx.dislikeReason = '';
  rx.swap = swap; rx.aftercare = 0; rx.afterNote = '';
  rx.test = previewing();

  card.remove();
  const slip = renderSlip(rx, { context: 'chat' });
  slip.classList.add('arrive');
  thread.append(slip); scrollDown();
  if (isOwner() && lastModel) slip.append(el('div', 'model-tag', 'Written by ' + lastModel));
  ringBell();
  setBusy(false);
  S.lastRx = rx;
  countLocally(swap);
  count({
    [swap ? 'swaps' : 'rx']: 1, ...(swap ? {} : { [isFull() ? 'rxFull' : 'rxFree']: 1 }),
    [validId(rx.videoId) ? 'videoInApp' : 'videoLink']: 1,
    techniques: [rx.technique], teachers: [rx.teacher],
  });
  savePrescription(S.user.uid, rx).catch(e => { console.error(e); sysNote("This prescription couldn't be filed. It's still here on screen.", true); });

  if (rx.closing) { await wait(900); const t = addMsg('doctor'); await typeInto(t, rx.closing); }
  S.turns.push({ role: 'assistant', content: `[Prescribed ${rx.no}: "${rx.title}", ${rx.technique} with ${rx.teacher}, ${rx.minutes} minutes]` });
  S.patientTurns = 0; S.moodWords = [];
  S.phase = 'aftercare'; S.currentRx = rx;
  if (isFull()) setNext(button('Start a new consultation', '', () => greet()));
}

/* ---------- favourites & dislikes ---------- */
const find = id => S.rxs.find(r => r.id === id) || (S.lastRx?.id === id ? S.lastRx : null);
async function patch(id, change) {
  const r = find(id);
  if (r) Object.assign(r, change);
  syncSlips(); renderLists();
  try { await updatePrescription(S.user.uid, id, change); }
  catch (e) { console.error(e); sysNote("That change didn't save. Try again in a moment.", true); }
}

/* ---------- slip ---------- */
const fmtDate = ms => (ms ? new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(ms)) : '');
const fmtLen = s => (s ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : '');

function player(rx) {
  const wrap = el('div', 'video');
  const box = el('div', 'player');
  const poster = el('button'); poster.type = 'button';
  poster.setAttribute('aria-label', 'Play ' + (rx.videoTitle || 'the meditation'));
  poster.style.backgroundImage = `url("https://i.ytimg.com/vi/${rx.videoId}/hqdefault.jpg")`;
  const ring = el('span'); ring.innerHTML = ICON.play; poster.append(ring);
  poster.onclick = () => {
    ringBell();
    const f = document.createElement('iframe');
    f.src = `https://www.youtube-nocookie.com/embed/${rx.videoId}?autoplay=1&rel=0&modestbranding=1`;
    f.title = rx.videoTitle || 'Guided meditation';
    f.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
    f.allowFullscreen = true;
    poster.replaceWith(f);
  };
  box.append(poster);
  const meta = el('div', 'video-meta');
  meta.append(el('strong', '', rx.videoTitle || 'Guided meditation'));
  const bits = [rx.videoChannel, fmtLen(rx.videoSeconds)].filter(Boolean).join(' · ');
  if (bits) meta.append(document.createTextNode(' — ' + bits));
  wrap.append(box, meta);
  return wrap;
}

function renderSlip(rx, { context }) {
  const compact = context !== 'chat';
  const slip = el('article', 'slip'); slip.dataset.rx = rx.id;
  const head = el('div', 'slip-head');
  head.append(el('span', 'rx', '℞'));
  const hd = el('div');
  hd.append(el('div', 'clinic', 'Prescription Meditation · Practice of Dr. A. Stillwell'));
  hd.append(el('div', 'meta', `${rx.no || ''} · ${fmtDate(rx.at)} · ${S.user?.displayName || 'Patient'}`));
  head.append(hd); slip.append(head);

  if (rx.repeatOf) slip.append(el('span', 'stamp', 'Repeat' + (rx.repeatNo ? ' of ' + rx.repeatNo : '')));
  if (compact && rx.mood) slip.append(el('p', 'said', '“' + rx.mood.slice(0, 220) + (rx.mood.length > 220 ? '…' : '') + '”'));
  const labelled = (label, text) => { const p = el('p'); p.append(el('span', 'label', label), document.createTextNode(text)); return p; };
  if (!compact && rx.assessment) slip.append(labelled('Assessment', rx.assessment));
  if (compact && rx.summary) slip.append(labelled('Notes', rx.summary));

  slip.append(el('h3', 'slip-title', rx.title));
  const dl = el('dl', 'dose');
  [['Dose', rx.minutes + ' min, once'], ['Technique', rx.technique], ['Practitioner', rx.teacher || 'Any'], ['Refills', 'As needed']].forEach(([k, v]) => {
    const d = el('div'); d.append(el('dt', '', k), el('dd', '', v)); dl.append(d);
  });
  slip.append(dl);

  if (validId(rx.videoId)) slip.append(player(rx));
  if (!compact && rx.why) slip.append(el('p', '', rx.why));
  if (!compact && rx.directions?.length) {
    const wrap = el('div'); wrap.append(el('span', 'label', 'Directions'));
    const ol = el('ol', 'sig'); rx.directions.forEach(d => ol.append(el('li', '', d))); wrap.append(ol); slip.append(wrap);
  }

  const sign = el('div', 'sign');
  sign.append(el('span', 'signature', 'A. Stillwell'), el('span', 'reg', 'Licensed to prescribe stillness · Reg. PM-0001'));
  slip.append(sign);

  const actions = el('div', 'actions');
  const open = el('a', 'btn' + (validId(rx.videoId) ? '' : ' primary'));
  open.href = validId(rx.videoId) ? watchUrl(rx.videoId) : searchUrl(rx);
  open.target = '_blank'; open.rel = 'noopener';
  open.insertAdjacentHTML('afterbegin', validId(rx.videoId) ? ICON.link : ICON.play);
  open.append(document.createTextNode(validId(rx.videoId) ? 'Open in YouTube' : 'Find it on YouTube'));
  const fav = button('Save', 'fav', () => {
    const on = !find(rx.id)?.fav;
    patch(rx.id, on ? { fav: true, disliked: false, dislikeReason: '' } : { fav: false });
    if (on) count({ favs: 1 });
  }, ICON.heart);
  fav.dataset.role = 'fav';
  const nope = button('Not for me', 'nope', () => {
    if (find(rx.id)?.disliked) { patch(rx.id, { disliked: false, dislikeReason: '' }); return; }
    reasons.hidden = !reasons.hidden;
  }, ICON.down);
  nope.dataset.role = 'nope';
  actions.append(open, fav, nope);
  slip.append(actions);

  const reasons = el('div', 'reasons'); reasons.hidden = true;
  reasons.append(el('span', '', 'What was wrong?'));
  ["Didn't like the voice", 'Wrong length', 'Wrong kind of practice', "Didn't help"].forEach(reason => {
    const c = el('button', 'chip', reason); c.type = 'button';
    c.onclick = async () => {
      reasons.hidden = true;
      await patch(rx.id, { disliked: true, dislikeReason: reason, fav: false });
      count({ dislikes: 1, reasons: [reason] });
      if (context === 'chat' && !S.busy) {
        showView('consult');
        if (canSwap()) {
          setNext(button('Prescribe something else', '', () => prescribe(
            `The patient just turned down "${rx.title}" (${rx.technique} with ${rx.teacher}) because: ${reason}. Prescribe something clearly different that still fits them, and set repeatOf to null.`,
            { swap: true }), ICON.bell));
          scrollDown();
        } else {
          doctorSays("I'm sorry that one wasn't right either. I've noted it, and tomorrow I'll find you something different.");
        }
      }
    };
    reasons.append(c);
  });
  slip.append(reasons);

  applySlipState(slip, find(rx.id) || rx);
  return slip;
}
function applySlipState(slip, r) {
  const fav = slip.querySelector('[data-role="fav"]'), nope = slip.querySelector('[data-role="nope"]');
  fav.setAttribute('aria-pressed', String(!!r.fav)); fav.lastChild.textContent = r.fav ? 'Saved' : 'Save';
  nope.setAttribute('aria-pressed', String(!!r.disliked)); nope.lastChild.textContent = r.disliked ? 'Disliked · undo' : 'Not for me';
  slip.classList.toggle('is-disliked', !!r.disliked);
}
function syncSlips() { thread.querySelectorAll('.slip[data-rx]').forEach(s => { const r = find(s.dataset.rx); if (r) applySlipState(s, r); }); }

function empty(title, body) { const d = el('div', 'empty'); d.append(el('strong', '', title), el('span', '', body)); return d; }
function renderLists() {
  const favs = S.rxs.filter(r => r.fav);
  $('#fav-count').textContent = favs.length || '';
  $('#file-count').textContent = S.rxs.length || '';
  $('#fav-list').replaceChildren(...(favs.length ? favs.map(r => renderSlip(r, { context: 'list' }))
    : [empty('No favourites yet', 'Tap Save on any prescription and it will be kept here.')]));
  $('#file-list').replaceChildren(...(S.rxs.length ? S.rxs.map(r => renderSlip(r, { context: 'list' }))
    : [empty('Your file is empty', 'Each prescription Dr. Stillwell writes is filed here, with what you said at the time.')]));
  syncSlips();
}

/* ---------- owner-only: which model answered ---------- */
function modelTag(t) {
  if (!isOwner() || !lastModel) return;
  t.closest('.bubble').append(el('div', 'model-tag', lastModel));
}

/* ---------- memos from Dr. Stillwell ---------- */
const memoDlg = $('#memo');
function showMemo(memo, onClose) {
  $('#memo-body').textContent = memo.text;
  $('#memo-date').textContent = fmtDate(memo.at || Date.now());
  memoDlg.onclose = () => { memoDlg.onclose = null; onClose?.(); };
  if (!memoDlg.open) memoDlg.showModal();
}
async function checkMemo() {
  if (!S.user) return;
  try {
    const [memos, state] = await Promise.all([fetchMemos(), getUserState(S.user.uid)]);
    const plan = isFull() ? 'full' : 'free';
    const now = Date.now();
    // Only the newest memo meant for this person, so pop-ups never stack up.
    const memo = memos.find(m => !m.withdrawn && (!m.until || m.until > now) && (m.audience === 'all' || m.audience === plan));
    if (!memo || state.memoSeen === memo.id) return;
    showMemo(memo, () => setUserState(S.user.uid, { memoSeen: memo.id }).catch(e => console.warn(e)));
  } catch (e) { console.warn('Memo check failed', e); }
}

/* ---------- admin menu (owner only) ---------- */
const admin = $('#admin');
const AUDIENCE = { all: 'everyone', free: 'free plan users', full: 'full version users' };
const fmtWhen = ms => new Date(ms).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' });

$('#plan').onclick = () => {
  if (!isOwner()) return;
  renderViewAs(); renderAllowance(); renderMemoList(); renderStats();
  $('#adm-test-note').textContent = ''; $('#memo-status').textContent = '';
  admin.showModal();
};

function renderViewAs() {
  const v = previewing() ? 'free' : 'full';
  $('#view-as').querySelectorAll('button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.view === v)));
}
function switchView(free) {
  writePref('pm-view-free', free ? '1' : null);
  renderPlan(); renderViewAs();
  if (admin.open) admin.close();
  greet();
}
$('#view-as').querySelectorAll('button').forEach(b => (b.onclick = () => switchView(b.dataset.view === 'free')));
$('#preview-exit').onclick = () => switchView(false);

$('#adm-reset').onclick = () => {
  writePref('pm-test-start', String(Date.now()));
  writePref('pm-usage-preview-' + S.user.uid, null);
  if (previewing()) { admin.close(); greet(); }
  else $('#adm-test-note').textContent = 'Free test day reset. Switch to the free version to use it.';
};
$('#adm-welcome').onclick = () => {
  writePref('pm-free-notice-' + S.user.uid, null);
  if (previewing()) { admin.close(); greet(); }
  else $('#adm-test-note').textContent = 'Done. Switch to the free version to see the welcome.';
};
$('#adm-crisis').onclick = () => {
  admin.close(); showView('consult');
  sysNote('Preview of the crisis card. Only you can see this.');
  thread.append(crisisCard()); scrollDown();
};

function renderAllowance() {
  const st = S.stats;
  const total = st?.total || 0;
  $('#adm-total').textContent = st === null ? "Today's figures couldn't be loaded."
    : st === undefined ? 'Loading…'
    : `${total} AI request${total === 1 ? '' : 's'} today across all users (about ${Math.round(total / 4)} consultation${Math.round(total / 4) === 1 ? '' : 's'}). YouTube searches: ${st?.yt || 0} of about 99.`;
  const here = restingOnThisDevice();
  const now = Date.now();
  $('#adm-models').replaceChildren(...ALL_MODELS.map(m => {
    const k = statKey(m);
    const until = Math.max(st?.out?.[k] || 0, here[m] || 0);
    const tr = el('tr');
    const status = el('td', until > now ? 'out' : 'ok', until > now ? 'Out until ' + fmtWhen(until) : 'Available');
    tr.append(el('td', 'mono', m), el('td', 'num', String(st?.used?.[k] || 0)), status);
    return tr;
  }));
}

/* ---------- admin: app stats (counts only) ---------- */
let statsRange = 1;
const REASON_LABELS = { didn_t_like_the_voice: "Didn't like the voice", wrong_length: 'Wrong length', wrong_kind_of_practice: 'Wrong kind of practice', didn_t_help: "Didn't help" };
const pretty = k => REASON_LABELS[k] || k.replace(/_/g, ' ').replace(/\b\w/, c => c.toUpperCase());
document.querySelectorAll('#stats-range button').forEach(b => (b.onclick = () => { statsRange = Number(b.dataset.days); renderStats(); }));
async function renderStats() {
  document.querySelectorAll('#stats-range button').forEach(b => b.setAttribute('aria-checked', String(Number(b.dataset.days) === statsRange)));
  const box = $('#stats-body');
  box.replaceChildren(el('p', 'admin-note', 'Loading…'));
  try {
    const days = [...Array(statsRange)].map((_, i) => irishDay(Date.now() - i * 864e5));
    const [rows, totals] = await Promise.all([fetchMetrics(days), fetchTotals()]);
    const sum = k => rows.reduce((a, r) => a + (r[k] || 0), 0);
    const merge = k => { const m = {}; rows.forEach(r => Object.entries(r[k] || {}).forEach(([n, v]) => { m[n] = (m[n] || 0) + v; })); return m; };
    const pct = (a, b) => (b ? Math.round((a / b) * 100) + '%' : '–');
    const tile = (n, label) => { const d = el('div', 'stat-tile'); d.append(el('b', '', String(n)), el('span', '', label)); return d; };
    const group = (title, tiles) => { const g = el('div', 'stat-group'); g.append(el('h4', '', title)); const t = el('div', 'stat-tiles'); t.append(...tiles); g.append(t); return g; };
    const top = (title, map, n = 5) => {
      const g = el('div', 'stat-group'); g.append(el('h4', '', title));
      const entries = Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, n);
      if (!entries.length) { g.append(el('p', 'admin-note', 'Nothing yet.')); return g; }
      const max = entries[0][1];
      const ul = el('ul', 'stat-bars');
      entries.forEach(([k, v]) => {
        const li = el('li'); li.append(el('span', 'stat-bar-label', pretty(k)), el('span', 'stat-bar-num', String(v)));
        const bar = el('span', 'stat-bar'); bar.style.width = Math.max(4, Math.round((v / max) * 100)) + '%'; li.append(bar);
        ul.append(li);
      });
      g.append(ul); return g;
    };
    const period = statsRange === 1 ? 'today' : `last ${statsRange} days`;
    const rx = sum('rx'), consults = sum('consults');
    box.replaceChildren(
      group('People', [
        tile(totals.users || 0, 'users in total'),
        tile(sum('newUsers'), `new, ${period}`),
        tile(statsRange === 1 ? sum('active') : sum('activeWeek'), statsRange === 1 ? 'active today' : `active, ${period}`),
        tile(sum('limitHit'), 'came back after their free meditation'),
      ]),
      group('Consultations', [
        tile(consults, 'started'),
        tile(rx, 'prescriptions written'),
        tile(pct(rx, consults), 'finished with a prescription'),
        tile(sum('swaps'), 'swaps'),
        tile(sum('aftercare'), 'told the doctor how it went'),
        tile(`${sum('rxFree')} / ${sum('rxFull')}`, 'free / full version'),
      ]),
      group('How well it is working', [
        tile(sum('favs'), 'saved to Favourites'),
        tile(sum('dislikes'), '"Not for me"'),
        tile(pct(sum('favs'), rx + sum('swaps')), 'of prescriptions saved'),
      ]),
      top('Why people said "Not for me"', merge('reasons'), 4),
      top('Most prescribed techniques', merge('techniques')),
      top('Most prescribed teachers', merge('teachers')),
      group('Video and AI', [
        tile(sum('videoInApp'), 'played in the app'),
        tile(sum('videoLink'), 'fell back to a YouTube link'),
        tile(sum('aiFull'), '"consulting room full" shown'),
      ]),
      group('Safety', [tile(sum('crisis'), 'times the crisis card was shown')]),
      el('p', 'admin-note', `Counts only, never names or what anyone said. Your own use isn't counted. Counting started on 3 Oct 2026.${sum('deleted') ? ` ${sum('deleted')} people deleted their prescription history in this period.` : ''}`),
    );
  } catch (e) {
    console.error(e);
    box.replaceChildren(el('p', 'admin-note', "The stats couldn't be loaded. Try again in a moment."));
  }
}

/* ---------- "Delete my prescription history" (any user; the account stays) ---------- */
$('#delete-data').onclick = () => { $('#delete-confirm').hidden = false; $('#delete-data').hidden = true; $('#delete-status').textContent = ''; };
$('#delete-no').onclick = () => { $('#delete-confirm').hidden = true; $('#delete-data').hidden = false; };
$('#delete-yes').onclick = async () => {
  const yes = $('#delete-yes'); yes.disabled = true;
  $('#delete-status').textContent = 'Deleting…';
  try {
    const n = await deletePrescriptionHistory(S.user.uid);
    count({ deleted: 1 });
    $('#delete-confirm').hidden = true; $('#delete-data').hidden = false;
    $('#delete-status').textContent = n ? 'Your prescription history has been deleted.' : 'There was nothing to delete.';
  } catch (e) {
    console.error(e);
    $('#delete-status').textContent = 'Something went wrong and not everything was deleted. Please try again.';
  } finally { yes.disabled = false; }
};

/* writing and managing memos */
const memoText = $('#memo-text'), memoAudience = $('#memo-audience'), memoUntil = $('#memo-until');
const memoStatus = t => { $('#memo-status').textContent = t; };
function draftMemo() {
  const text = memoText.value.trim();
  if (!text) { memoStatus('Write a message first.'); memoText.focus(); return null; }
  const until = memoUntil.value ? new Date(memoUntil.value + 'T23:59:59').getTime() : null;
  if (until && until < Date.now()) { memoStatus('That end date has already passed.'); return null; }
  return { text, audience: memoAudience.value, until };
}
$('#memo-preview').onclick = () => {
  const d = draftMemo(); if (!d) return;
  admin.close();
  showMemo({ ...d, at: Date.now() }, () => admin.showModal());
};
$('#memo-send').onclick = () => {
  const d = draftMemo(); if (!d) return;
  $('#memo-confirm-text').textContent = `Send this memo to ${AUDIENCE[d.audience]}? They'll see it the next time they open the app.`;
  $('#memo-confirm').hidden = false;
};
$('#memo-confirm-no').onclick = () => { $('#memo-confirm').hidden = true; };
$('#memo-confirm-yes').onclick = async () => {
  const d = draftMemo(); if (!d) return;
  const yes = $('#memo-confirm-yes'); yes.disabled = true;
  try {
    await sendMemo({ ...d, at: Date.now(), withdrawn: false });
    memoText.value = ''; memoUntil.value = ''; memoAudience.value = 'all';
    $('#memo-confirm').hidden = true;
    memoStatus('Memo sent.');
  } catch (e) {
    console.error(e);
    memoStatus("The memo couldn't be sent. Check your connection and try again.");
  } finally { yes.disabled = false; }
};

function renderMemoList() {
  const list = $('#memo-list');
  if (!S.memos.length) { list.replaceChildren(el('li', 'admin-note', 'No memos sent yet.')); return; }
  const now = Date.now();
  list.replaceChildren(...S.memos.map(m => {
    const live = !m.withdrawn && (!m.until || m.until > now);
    const li = el('li', live ? '' : 'gone');
    const head = el('div', 'memo-item-head');
    head.append(el('span', 'meta', `${fmtDate(m.at)} · ${AUDIENCE[m.audience] || 'everyone'}`),
      el('span', 'memo-state', m.withdrawn ? 'Withdrawn' : live ? (m.until ? 'Live until ' + fmtDate(m.until) : 'Live') : 'Ended'));
    li.append(head, el('p', '', m.text.length > 140 ? m.text.slice(0, 140) + '…' : m.text));
    if (live) {
      const w = el('button', 'btn small', 'Withdraw'); w.type = 'button';
      w.onclick = async () => {
        if (w.dataset.armed !== '1') { w.dataset.armed = '1'; w.textContent = 'Tap again to withdraw'; return; }
        w.disabled = true;
        try { await withdrawMemo(m.id); } catch (e) { console.error(e); memoStatus("That memo couldn't be withdrawn. Try again."); w.disabled = false; }
      };
      li.append(w);
    }
    return li;
  }));
}

/* ---------- composer ---------- */
function autosize() { msg.style.height = 'auto'; msg.style.height = Math.min(msg.scrollHeight, 160) + 'px'; }
msg.addEventListener('input', autosize);
msg.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(msg.value); } });
$('#composer').addEventListener('submit', e => { e.preventDefault(); send(msg.value); });
document.querySelectorAll('#time-chips .chip').forEach(c => (c.onclick = () => {
  const m = c.dataset.min;
  const phrase = m === '45' ? 'I have about 45 minutes or more.' : `I have about ${m} minutes.`;
  msg.value = msg.value.trim() ? msg.value.trim().replace(/[.\s]*$/, '. ') + phrase : phrase;
  autosize(); msg.focus();
}));

/* ---------- voice ---------- */
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const mic = $('#mic'), hint = $('#hint');
let rec = null;
if (Recognition) mic.hidden = false;
else hint.textContent = 'Voice input works in Chrome, Edge and Safari. On a phone you can also tap the microphone on your keyboard.';

function stopListening() { if (rec) { rec.stop(); } }
mic.onclick = () => {
  if (rec) { stopListening(); return; }
  rec = new Recognition();
  rec.lang = navigator.language || 'en-GB';
  rec.continuous = true;
  rec.interimResults = true;
  const before = msg.value.trim() ? msg.value.trim() + ' ' : '';
  rec.onresult = ev => {
    let said = '';
    for (let i = 0; i < ev.results.length; i++) said += ev.results[i][0].transcript;
    msg.value = before + said.trim();
    autosize();
  };
  rec.onerror = ev => {
    if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') hint.textContent = 'Microphone access is blocked. Allow it in your browser settings to talk to the doctor.';
    else if (ev.error === 'no-speech') hint.textContent = "I didn't catch anything. Tap the microphone and try again.";
  };
  rec.onend = () => { rec = null; mic.setAttribute('aria-pressed', 'false'); hint.textContent = 'Type, or tap the microphone and talk.'; };
  mic.setAttribute('aria-pressed', 'true');
  hint.textContent = 'Listening… tap the microphone again when you are done.';
  rec.start();
};
