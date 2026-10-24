// AVNI Pulse - end-to-end check of the database side, with disposable test data only.
// Makes one event named "TEST ...", runs every kind of activity with 3 test phones, checks the counts, then ends
// the event. Run: node tests/rpc_smoke.mjs   (exit 0 = all checks passed)
import { SUPABASE_URL, SUPABASE_KEY } from '../docs/js/config.js';

const call = async (fn, args) => {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST', headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(args),
  });
  const t = await r.text(); const b = t ? JSON.parse(t) : null;
  if (!r.ok) throw new Error(`${fn}: ${b && b.message}`);
  return b;
};
let failed = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'OK  ' : 'BAD '}${name}${ok ? '' : `  (got ${JSON.stringify(got)})`}`); if (!ok) failed++; };
const expectError = async (name, p, words) => {
  try { await p; check(name, false, 'no error'); } catch (e) { check(name, e.message.includes(words), e.message); }
};

const ev = await call('pulse_create_event', { p_title: `TEST rpc smoke ${new Date().toISOString()}` });
const H = { p_code: ev.code, p_key: ev.key };
const phones = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
for (const [i, p] of phones.entries()) await call('pulse_join', { p_code: ev.code, p_pid: p, p_nickname: `Test phone ${i + 1}` });

await expectError('wrong presenter key is refused', call('pulse_host_state', { p_code: ev.code, p_key: 'not-the-key' }), 'does not open');

// poll
const poll = await call('pulse_add_item', { ...H, p_kind: 'poll', p_question: 'TEST poll', p_options: ['A', 'B', 'C'] });
await expectError('no answer before the poll is live', call('pulse_answer', { p_code: ev.code, p_pid: phones[0], p_item: poll, p_answer: { choice: 0 } }), 'not open');
await call('pulse_set_live', { ...H, p_item: poll });
await call('pulse_answer', { p_code: ev.code, p_pid: phones[0], p_item: poll, p_answer: { choice: 1 } });
await call('pulse_answer', { p_code: ev.code, p_pid: phones[1], p_item: poll, p_answer: { choice: 1 } });
await call('pulse_answer', { p_code: ev.code, p_pid: phones[2], p_item: poll, p_answer: { choice: 2 } });
await call('pulse_answer', { p_code: ev.code, p_pid: phones[2], p_item: poll, p_answer: { choice: 0 } }); // a changed vote
let st = await call('pulse_state', { p_code: ev.code, p_pid: phones[0] });
check('poll counts 1/2/0 after a changed vote', JSON.stringify(st.item.results.counts) === '[1,2,0]', st.item.results.counts);

// word cloud
const wc = await call('pulse_add_item', { ...H, p_kind: 'wordcloud', p_question: 'TEST one word' });
await call('pulse_set_live', { ...H, p_item: wc });
await call('pulse_answer', { p_code: ev.code, p_pid: phones[0], p_item: wc, p_answer: { words: 'Service, Trust' } });
await call('pulse_answer', { p_code: ev.code, p_pid: phones[1], p_item: wc, p_answer: { words: 'service' } });
st = await call('pulse_state', { p_code: ev.code, p_pid: phones[0] });
const top = st.item.results.words[0];
check('word cloud joins "Service" and "service"', top.w === 'service' && top.n === 2, st.item.results.words);
let hs = await call('pulse_host_state', H);
check('poll closed when the word cloud went live', hs.items.find((i) => i.id === poll).state === 'closed', hs.items.find((i) => i.id === poll).state);

// quiz
const qz = await call('pulse_add_item', { ...H, p_kind: 'quiz', p_question: 'TEST capital of India', p_options: ['Mumbai', 'New Delhi'], p_correct: 1, p_seconds: 10 });
await call('pulse_set_live', { ...H, p_item: qz });
st = await call('pulse_state', { p_code: ev.code, p_pid: phones[0] });
check('quiz hides the right answer while live', st.item.correct === null || st.item.correct === undefined, st.item.correct);
await call('pulse_answer', { p_code: ev.code, p_pid: phones[0], p_item: qz, p_answer: { choice: 1 } });
await call('pulse_answer', { p_code: ev.code, p_pid: phones[1], p_item: qz, p_answer: { choice: 0 } });
await expectError('a quiz answer cannot be changed', call('pulse_answer', { p_code: ev.code, p_pid: phones[0], p_item: qz, p_answer: { choice: 0 } }), 'already answered');
await call('pulse_close_item', { ...H, p_item: qz });
st = await call('pulse_state', { p_code: ev.code, p_pid: phones[0] });
check('quiz shows the right answer after close', st.item.correct === 1, st.item.correct);
check('right and fast answer scores 500 to 1000', st.item.my_score > 500 && st.item.my_score <= 1000, st.item.my_score);
check('leaderboard puts Test phone 1 first', st.leaderboard[0].name === 'Test phone 1' && st.my_rank === 1, st.leaderboard);
await expectError('no answer after the quiz is closed', call('pulse_answer', { p_code: ev.code, p_pid: phones[2], p_item: qz, p_answer: { choice: 1 } }), 'not open');

// survey
const sv = await call('pulse_add_item', { ...H, p_kind: 'survey', p_question: 'TEST feedback', p_options: [
  { q: 'Useful?', type: 'rating' }, { q: 'Best part?', type: 'choice', options: ['Cases', 'Lecture'] }, { q: 'Change?', type: 'text' }] });
await call('pulse_set_live', { ...H, p_item: sv });
await call('pulse_answer', { p_code: ev.code, p_pid: phones[0], p_item: sv, p_answer: { answers: [5, 0, 'More cases'] } });
await call('pulse_answer', { p_code: ev.code, p_pid: phones[1], p_item: sv, p_answer: { answers: [4, 0, null] } });
hs = await call('pulse_host_state', H);
const sr = hs.items.find((i) => i.id === sv).results.questions;
check('survey rating average 4.5', Number(sr[0].avg) === 4.5, sr[0]);
check('survey choice counts 2/0', JSON.stringify(sr[1].counts) === '[2,0]', sr[1].counts);
check('survey text visible to the presenter', sr[2].texts[0] === 'More cases', sr[2]);
st = await call('pulse_state', { p_code: ev.code, p_pid: phones[2] });
check('survey text NOT sent to phones', st.item.results.questions[2].texts.length === 0, st.item.results.questions[2]);

// Q&A
const q1 = await call('pulse_ask', { p_code: ev.code, p_pid: phones[0], p_body: 'TEST question one', p_author: null });
const q2 = await call('pulse_ask', { p_code: ev.code, p_pid: phones[1], p_body: 'TEST question two', p_author: 'Test phone 2' });
await call('pulse_upvote', { p_code: ev.code, p_pid: phones[1], p_question: q1 });
await call('pulse_upvote', { p_code: ev.code, p_pid: phones[2], p_question: q1 });
await call('pulse_upvote', { p_code: ev.code, p_pid: phones[2], p_question: q2 });
const back = await call('pulse_upvote', { p_code: ev.code, p_pid: phones[2], p_question: q2 }); // takes it back
check('a second press takes the upvote back', back.voted === false && back.votes === 0, back);
st = await call('pulse_state', { p_code: ev.code, p_pid: phones[1] });
check('most upvoted question first, anonymous name kept', st.questions[0].id === q1 && st.questions[0].votes === 2 && st.questions[0].author === 'Anonymous' && st.questions[0].voted, st.questions[0]);
await call('pulse_qa_mod', { ...H, p_question: q2, p_action: 'hide' });
st = await call('pulse_state', { p_code: ev.code, p_pid: phones[1] });
check('a hidden question leaves the phones', st.questions.length === 1, st.questions.length);

// analytics
hs = await call('pulse_host_state', H);
const a = hs.analytics;
check('analytics: 3 people, 3 responders, 2 questions, 2 upvotes', a.people === 3 && a.responders === 3 && a.questions === 2 && a.upvotes === 2, a);

// realtime counter moved
check('the realtime counter moved with every change', hs.rev > 20, hs.rev);

await call('pulse_set_event', { ...H, p_closed: true });
await expectError('an ended event takes no answers', call('pulse_ask', { p_code: ev.code, p_pid: phones[0], p_body: 'late' }), 'ended');
console.log(failed ? `${failed} CHECK(S) FAILED - event ${ev.code}` : `ALL CHECKS PASSED - event ${ev.code} (ended)`);
process.exit(failed ? 1 : 0);
