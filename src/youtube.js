// Finds one real, embeddable YouTube video for a prescription using the YouTube Data API.
// Without VITE_YOUTUBE_API_KEY the app falls back to a YouTube search link.
const KEY = import.meta.env.VITE_YOUTUBE_API_KEY;
export const youtubeEnabled = Boolean(KEY);
const API = 'https://www.googleapis.com/youtube/v3/';

export function searchUrl(rx) {
  return 'https://www.youtube.com/results?search_query=' + encodeURIComponent(rx.query);
}
export function watchUrl(id) { return 'https://www.youtube.com/watch?v=' + encodeURIComponent(id); }
export const validId = id => typeof id === 'string' && /^[\w-]{11}$/.test(id);

function seconds(iso) {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || '');
  if (!m) return 0;
  return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
}

/**
 * Pick the best video for a prescription.
 * @param rx       the prescription ({query, teacher, minutes})
 * @param exclude  video ids never to return (disliked, or already prescribed)
 * @returns {Promise<{videoId, videoTitle, videoChannel, videoSeconds} | null>}
 */
export async function findVideo(rx, exclude = new Set()) {
  if (!KEY) return null;
  const m = rx.minutes;
  const duration = m < 4 ? 'short' : m <= 20 ? 'medium' : 'long';
  const params = new URLSearchParams({
    part: 'snippet', type: 'video', maxResults: '15', q: rx.query, videoEmbeddable: 'true',
    videoDuration: duration, safeSearch: 'moderate', relevanceLanguage: 'en', key: KEY,
  });
  const res = await fetch(API + 'search?' + params);
  if (!res.ok) throw new Error('YouTube search failed: ' + res.status);
  const items = ((await res.json()).items || []).filter(i => validId(i.id?.videoId) && !exclude.has(i.id.videoId));
  if (!items.length) return null;

  // Look up real lengths so the dose matches the time the patient has.
  const ids = items.map(i => i.id.videoId).join(',');
  const det = await fetch(API + 'videos?' + new URLSearchParams({ part: 'contentDetails', id: ids, key: KEY }));
  const lengths = {};
  if (det.ok) for (const v of (await det.json()).items || []) lengths[v.id] = seconds(v.contentDetails?.duration);

  const teacher = (rx.teacher || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2);
  const target = m * 60;
  let best = null, bestScore = Infinity;
  items.forEach((it, rank) => {
    const len = lengths[it.id.videoId] || 0;
    const channel = (it.snippet?.channelTitle || '').toLowerCase();
    const title = (it.snippet?.title || '').toLowerCase();
    let score = rank * 0.6;                                         // trust YouTube's relevance a little
    score += len ? Math.abs(len - target) / 60 : 6;                 // minutes away from the dose
    if (len > target * 1.35 + 120) score += 12;                     // much longer than the time they have
    if (teacher.length && teacher.every(w => channel.includes(w))) score -= 12;   // the teacher's own channel
    else if (teacher.length && teacher.some(w => title.includes(w))) score -= 3;  // someone else's video of their method
    if (/\b(music only|no talking|asmr|sleep music|binaural)\b/.test(title)) score += 6; // we want *guided*
    if (score < bestScore) { bestScore = score; best = it; }
  });
  const decode = s => { const t = document.createElement('textarea'); t.innerHTML = s || ''; return t.value; };
  return {
    videoId: best.id.videoId,
    videoTitle: decode(best.snippet?.title),
    videoChannel: decode(best.snippet?.channelTitle),
    videoSeconds: lengths[best.id.videoId] || 0,
  };
}
