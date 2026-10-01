// Dr. Stillwell: the intake conversation and the prescription, both on Gemini via Firebase AI Logic.
import { geminiModel } from './firebase.js';

// Gemini "thinks" before answering, and that thinking counts toward the output limit.
// Keep it minimal for the short intake replies and low for the prescription.
const THINK = { intake: { thinkingLevel: 'MINIMAL' }, rx: { thinkingLevel: 'LOW' } };

/** Run a request, retrying once after a short pause if the service hiccups (401/429/5xx, network). */
async function withRetry(run, signal) {
  try { return await run(); }
  catch (e) {
    if (e?.name === 'AbortError' || signal?.aborted) throw e;
    const transient = /fetch-error/.test(String(e?.code)) && !/\[(400|403|404)/.test(String(e?.message));
    if (!transient) throw e;
    await new Promise(r => setTimeout(r, 1200 + Math.random() * 800));
    return run();
  }
}

/** How many follow-up questions each kind of consultation may ask, at most. */
export const MODES = {
  standard: { label: 'Standard', max: 3 },
  deep: { label: 'Take your time', max: 5 },
};

const PERSONA = `You are Dr. Stillwell, the attending meditation physician at Prescription Meditation. You hold a (playful) licence to prescribe guided meditations, and you are in a live one-on-one consultation with a patient.`;

const SAFETY = `If the patient mentions wanting to harm themselves or someone else, or being in danger: respond with care and tell them to contact local emergency services or a crisis line now (Samaritans 116 123 in the UK and Ireland, 988 in the US). Then gently ask how they are right now, and end with <<ASK>>.`;

function intakeInstruction(n, mode) {
  const plan = mode === 'deep'
    ? `This is a longer consultation the patient chose so they could take their time. Ask 4 follow-up questions, or 5 if something important is still unclear. You are on follow-up question ${n}. Go a little deeper each time: what they feel, where they feel it in the body, what is behind it, what they need (rest, sleep, courage, release, focus), how much time they have and where they are.`
    : `A standard consultation has 2 follow-up questions. You are on follow-up question ${n}.${
      n === 1 ? ' Ask about whatever would most change which meditation is right: how it feels in their body, what exactly they are worried or afraid of, or what is behind the feeling.'
      : n === 2 ? ' This is normally the last question. If they have not said how much time they have, ask that (you may fold it into one question with one other thing). Otherwise ask the one detail you still most need.'
      : ' You have already asked two. Only ask this third question if their answers so far are too vague to choose a meditation; otherwise hand over.'}`;
  return `${PERSONA}

You are doing intake, not prescribing. ${plan}

How to reply:
- 1 to 3 short sentences. Warm, calm, plain words, specific to what they actually said. Sound like a kind doctor who is listening closely, not a chatbot. No lists, no emoji, no exclamation marks.
- Reflect one concrete thing they said, then ask exactly ONE gentle question. End your reply with a final line that is exactly <<ASK>>
- Never recommend a meditation yourself.
- Hand over early ONLY if the patient is clearly in a rush (they have 5 minutes or less, or something is about to start), or if you have already asked every question you need. To hand over, reply with one short sentence such as "Thank you. Let me write something for you." and end with a final line that is exactly <<READY>>
- ${SAFETY}`;
}

const toContents = turns => [
  { role: 'user', parts: [{ text: '(The patient has opened the app and sat down.)' }] },
  ...turns.map(t => ({ role: t.role === 'user' ? 'user' : 'model', parts: [{ text: t.content }] })),
];

export const cleanReply = s => s.replace(/<<[\s\S]*$/, '').replace(/<$/, '').trim();

/**
 * One intake reply, streamed.
 * @returns {Promise<{reply: string, ready: boolean}>}
 */
export async function askFollowUp({ turns, n, mode, onText, signal }) {
  const model = geminiModel({
    systemInstruction: intakeInstruction(n, mode),
    generationConfig: { temperature: 0.8, maxOutputTokens: 2048, thinkingConfig: THINK.intake },
  });
  const result = await withRetry(() => model.generateContentStream({ contents: toContents(turns) }, { signal }), signal);
  let text = '';
  for await (const chunk of result.stream) {
    text += chunk.text();
    const shown = cleanReply(text);
    if (shown) onText(shown);
  }
  return { reply: cleanReply(text), ready: /<<READY>>/.test(text) };
}

const fmtDate = ms => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(ms));

function patientFile(rxs) {
  return rxs.slice(0, 30).map(r => ({
    id: r.id, date: fmtDate(r.at), mood: (r.mood || '').slice(0, 240), summary: r.summary,
    title: r.title, technique: r.technique, teacher: r.teacher, minutes: r.minutes, query: r.query,
    ...(r.videoTitle ? { video: r.videoTitle } : {}),
    favourite: !!r.fav, disliked: !!r.disliked, ...(r.dislikeReason ? { dislikeReason: r.dislikeReason } : {}),
  }));
}

function prescriptionPrompt(turns, rxs, extra) {
  const transcript = turns.map(t => (t.role === 'user' ? 'Patient: ' : 'Doctor: ') + t.content).join('\n');
  return `${PERSONA} You have just finished the intake. Write ONE prescription for a guided meditation on YouTube that fits exactly what this patient needs at this moment.

CONSULTATION (oldest first):
${transcript}

PATIENT FILE: previous prescriptions, newest first (JSON):
${JSON.stringify(patientFile(rxs))}

RULES
- Dose: fit the minutes to the time they have. If they never said, assume 10. Use a whole number no larger than the time they have.
- Technique: choose for what is actually going on. Examples: racing thoughts at bedtime → yoga nidra or a sleep body scan; panic or a tight chest → slow paced breathing; grief or shame → self-compassion or loving-kindness; anger → RAIN; dread about tomorrow → grounding and noting; flat or exhausted → gentle energising breath or NSDR; scattered at work → a short focus or 5-4-3-2-1 grounding practice.
- Teacher: name a real teacher or YouTube channel you are confident publishes guided meditations of this kind (for example Tara Brach, Jack Kornfield, Jon Kabat-Zinn, Sarah Blondin, Kristin Neff, The Honest Guys, Great Meditation, Michael Sealey, Jason Stephenson, Headspace, Calm, Goodful, Declutter The Mind, Lavendaire, Boho Beautiful, Yoga With Adriene, Mindful Peace, UCLA Mindful). Do not invent video titles.
- Query: a YouTube search query of 4 to 9 words that will surface that kind of video by that teacher, including the length, e.g. "Tara Brach RAIN meditation anxiety 20 minutes".
- Repeats: only if the patient's current state is near-identical to a previous entry's mood (same core feelings, same situation, similar time available) AND that entry is not disliked, set "repeatOf" to that entry's id. Otherwise set "repeatOf" to null and choose a prescription whose query and teacher both differ from every previous entry.
- Never prescribe a teacher or style the patient disliked, and respect their reasons. Lean toward what is in their favourites when it genuinely fits.
- Voice: speak to the patient directly, warmly and plainly. No clichés, no exclamation marks.${extra ? '\n- ' + extra : ''}

Reply with only this JSON object:
{"summary": "3 to 8 word clinical-style note of their state, e.g. Work dread, tight chest, tired",
 "assessment": "1 to 2 sentences reflecting back what you heard",
 "title": "a name for this prescription, e.g. RAIN for a tight chest",
 "technique": "e.g. Body scan",
 "teacher": "teacher or channel",
 "minutes": 10,
 "query": "the YouTube search query",
 "why": "2 sentences on why this fits them right now",
 "directions": ["three short directions for taking it, e.g. Sit with your back supported"],
 "closing": "one sentence you say as you hand it over, inviting them back to tell you how it went",
 "repeatOf": null}`;
}

function parseJson(text) {
  try { return JSON.parse(text); } catch {}
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fence) try { return JSON.parse(fence[1]); } catch {}
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a >= 0 && b > a) try { return JSON.parse(text.slice(a, b + 1)); } catch {}
  return null;
}

function normalise(r) {
  r = r && typeof r === 'object' && !Array.isArray(r) ? r : {};
  const s = (v, d = '') => (typeof v === 'string' && v.trim() ? v.trim() : d);
  let minutes = Math.round(Number(r.minutes));
  if (!(minutes > 0 && minutes <= 180)) minutes = 10;
  const teacher = s(r.teacher), technique = s(r.technique, 'Guided meditation');
  return {
    summary: s(r.summary), assessment: s(r.assessment), title: s(r.title, 'A guided meditation for right now'),
    technique, teacher, minutes,
    query: s(r.query, `${teacher} ${technique} guided meditation ${minutes} minutes`.trim()),
    why: s(r.why),
    directions: Array.isArray(r.directions) ? r.directions.filter(x => typeof x === 'string' && x.trim()).slice(0, 4) : [],
    closing: s(r.closing),
    repeatOf: typeof r.repeatOf === 'string' && r.repeatOf ? r.repeatOf : null,
  };
}

/** Write the prescription. Throws {code:'invalid_json'} if the reply can't be read. */
export async function writePrescription({ turns, rxs, extra, signal }) {
  const model = geminiModel({
    generationConfig: { temperature: 0.7, responseMimeType: 'application/json', maxOutputTokens: 8192, thinkingConfig: THINK.rx },
  });
  const result = await withRetry(() => model.generateContent(prescriptionPrompt(turns, rxs, extra), { signal }), signal);
  const parsed = parseJson(result.response.text());
  if (!parsed) throw { code: 'invalid_json' };
  return normalise(parsed);
}

/** Map an error to words for the patient. */
export function errorCopy(e) {
  const code = String(e?.code || ''), msg = String(e?.message || '');
  if (code === 'invalid_json') return 'My pen slipped. Try once more.';
  if (code.includes('api-not-enabled')) return 'The AI service is not switched on for this Firebase project yet. Turn on AI Logic in the Firebase console.';
  if (/429|quota|exhausted/i.test(msg)) return 'The consulting room is busy right now. Give it a minute, then try again.';
  if (/blocked|safety|SAFETY/.test(msg)) return "I can't respond to that here. If you're in danger, call your local emergency number or Samaritans on 116 123.";
  if (/model.*not found|404/i.test(msg)) return 'The AI model in the settings is not available. Check VITE_GEMINI_MODEL in .env.local.';
  return 'The line dropped for a moment. Try again when you are ready.';
}
