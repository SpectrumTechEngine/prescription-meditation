// A singing-bowl strike, synthesised: a few sine partials with long exponential decays.
let ctx = null;
let soundOn = read('pm-sound', '1') === '1';

function read(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } }
function write(k, v) { try { localStorage.setItem(k, v); } catch {} }

export const isSoundOn = () => soundOn;
export function setSoundOn(on) { soundOn = on; write('pm-sound', on ? '1' : '0'); }

export function ringBell() {
  document.querySelectorAll('.bell-svg').forEach(b => {
    b.classList.remove('ringing');
    void b.getBoundingClientRect();
    b.classList.add('ringing');
  });
  if (!soundOn) return;
  try {
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    const now = ctx.currentTime, base = 392;
    const master = ctx.createGain();
    master.gain.value = 0.2;
    master.connect(ctx.destination);
    // [frequency multiple, gain, decay seconds]
    [[1, 1, 7], [1.004, 0.5, 7], [2.0, 0.2, 4], [2.76, 0.42, 5], [5.4, 0.16, 3], [8.93, 0.07, 2]].forEach(([m, g, d]) => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = base * m;
      const gn = ctx.createGain();
      gn.gain.setValueAtTime(0.0001, now);
      gn.gain.exponentialRampToValueAtTime(g, now + 0.012);
      gn.gain.exponentialRampToValueAtTime(0.0001, now + d);
      o.connect(gn);
      gn.connect(master);
      o.start(now);
      o.stop(now + d + 0.1);
    });
  } catch {}
}

// The bell drawing, inlined into every .bell-svg so CSS can animate its parts.
export const BELL_INNER = `
  <g class="waves" fill="none" style="stroke:var(--brass)" stroke-width="1.6" stroke-linecap="round">
    <path d="M6 19 q-3.5 7 0 14"/><path d="M42 19 q3.5 7 0 14"/>
    <path d="M1.5 16 q-4.5 10 0 20"/><path d="M46.5 16 q4.5 10 0 20"/>
  </g>
  <g class="body">
    <circle cx="24" cy="5" r="2.6" fill="none" style="stroke:var(--brass-lo)" stroke-width="1.8"/>
    <path d="M24 8.5c-7.4 0-10.6 5.8-10.6 12.6v8.2c0 3.2-2.6 5.4-5 7.2h31.2c-2.4-1.8-5-4-5-7.2v-8.2C34.6 14.3 31.4 8.5 24 8.5z" fill="url(#brass)"/>
    <path d="M18.2 14.5c-1.4 2-2 4.4-2 7.4v6.6" fill="none" style="stroke:var(--brass-hi)" stroke-width="1.4" stroke-linecap="round" opacity=".8"/>
    <rect x="7" y="36.2" width="34" height="3" rx="1.5" style="fill:var(--brass-lo)"/>
    <circle cx="24" cy="42.6" r="2.9" style="fill:var(--brass-lo)"/>
  </g>`;
export const BELL_SVG = `<svg class="bell-svg" viewBox="0 0 48 48" aria-hidden="true">${BELL_INNER}</svg>`;
export function drawBells(root = document) {
  root.querySelectorAll('svg.bell-svg').forEach(s => { s.setAttribute('viewBox', '0 0 48 48'); s.innerHTML = BELL_INNER; });
}
