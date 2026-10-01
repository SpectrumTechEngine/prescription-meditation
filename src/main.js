import './style.css';
import { configured, signIn, logOut, watchUser, watchPrescriptions, savePrescription, updatePrescription } from './firebase.js';
import { MODES, askFollowUp, writePrescription, errorCopy } from './doctor.js';
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
};

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
  S.user = user; S.rxs = [];
  if (!user) { show('gate'); return; }
  show('app');
  const patient = $('#patient');
  const name = user.displayName || 'You';
  if (user.photoURL) { const img = el('img'); img.src = user.photoURL; img.alt = ''; img.referrerPolicy = 'no-referrer'; patient.replaceChildren(img, el('span', '', name)); }
  else patient.replaceChildren(el('span', '', name));
  S.unwatch = watchPrescriptions(user.uid, rxs => { S.rxs = rxs; renderLists(); },
    err => { console.error(err); sysNote("Your patient file couldn't be loaded. Check the Firestore rules are deployed.", true); });
  renderLists();
  greet();
});

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
  setBusy(false); lockMode(false);
  thread.replaceChildren(); setNext();
  const first = (S.user?.displayName || '').split(' ')[0];
  const g = `${partOfDay()}${first ? ', ' + first : ''}. I'm Dr. Stillwell. What's going on with you?`;
  const t = addMsg('doctor');
  await typeInto(t, g);
  const t2 = addMsg('doctor');
  await typeInto(t2, "Tell me how you're feeling, anything you're worried about, and how much time you have. However it comes out is fine.");
  S.turns.push({ role: 'assistant', content: g + ' ' + t2.textContent });
}

async function send(text) {
  text = text.trim();
  if (!text || S.busy) return;
  stopListening();
  msg.value = ''; autosize();
  addMsg('patient', text);
  S.turns.push({ role: 'user', content: text });
  S.moodWords.push(text);
  S.patientTurns++;
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
    S.patientTurns--;                              // the next message stands in for this one
    t.closest('.msg').remove();
    if (e?.name === 'AbortError') return;
    console.error(e);
    sysNote(errorCopy(e), true);
    return;
  }
  setBusy(false);
  const reply = out.reply || 'Tell me a little more about that?';
  t.textContent = reply;
  S.turns.push({ role: 'assistant', content: reply });
  if (out.ready) { await wait(500); await prescribe(); }
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

async function prescribe(extra) {
  if (S.busy) return;
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
    if (e?.name !== 'AbortError') { console.error(e); sysNote(errorCopy(e), true); }
    setNext(button('Write my prescription', '', () => prescribe(extra), ICON.bell));
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
    try { const v = await findVideo(rx, exclude); if (v) Object.assign(rx, v); }
    catch (e) { console.warn(e); }
  }

  rx.at = Date.now();
  rx.id = 'rx_' + rx.at;
  rx.no = nextNo();
  rx.mood = S.moodWords.join(' / ').slice(0, 800);
  rx.mode = S.mode;
  rx.fav = false; rx.disliked = false; rx.dislikeReason = '';

  card.remove();
  const slip = renderSlip(rx, { context: 'chat' });
  slip.classList.add('arrive');
  thread.append(slip); scrollDown();
  ringBell();
  setBusy(false);
  S.lastRx = rx;
  savePrescription(S.user.uid, rx).catch(e => { console.error(e); sysNote("This prescription couldn't be filed. It's still here on screen.", true); });

  if (rx.closing) { await wait(900); const t = addMsg('doctor'); await typeInto(t, rx.closing); }
  S.turns.push({ role: 'assistant', content: `[Prescribed ${rx.no}: "${rx.title}", ${rx.technique} with ${rx.teacher}, ${rx.minutes} minutes]` });
  S.patientTurns = 0; S.moodWords = [];
  setNext(button('Start a new consultation', '', () => greet()));
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
      if (context === 'chat' && !S.busy) {
        showView('consult');
        setNext(button('Prescribe something else', '', () => prescribe(
          `The patient just turned down "${rx.title}" (${rx.technique} with ${rx.teacher}) because: ${reason}. Prescribe something clearly different that still fits them, and set repeatOf to null.`), ICON.bell));
        scrollDown();
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
