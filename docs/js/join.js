// AVNI Pulse - the phone page. A person opens the link (or scans the QR), types the code if the link has none,
// and answers whatever the presenter puts live. Their phone keeps a random id (no sign-in); that id is how we count
// one vote per phone and one upvote per question.
import { rpc, store, newId, watchEvent, esc, skewFrom } from './api.js';
import { renderBars, renderCloud, renderSurvey, renderLeaderboard, KIND_NAME } from './render.js';

const $ = (id) => document.getElementById(id);
const LETTERS = 'ABCDEFGH';

let pid = store.get('pulse.pid');
if (!pid) { pid = newId(); store.set('pulse.pid', pid); }

let code = null; let watcher = null; let S = null; let skew = 0; let liveKey = ''; let tick = null; let qaSort = 'top';

function codeFromUrl() {
  const u = new URL(location.href);
  const c = u.searchParams.get('c') || u.searchParams.get('code') || u.hash.replace(/^#\/?/, '');
  return (c || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || null;
}

function show(el, on) { el.classList.toggle('hidden', !on); }
function showError(el, msg) { el.textContent = msg; show(el, !!msg); }

async function join(c) {
  showError($('join-error'), '');
  try {
    const ev = await rpc('pulse_join', { p_code: c, p_pid: pid, p_nickname: store.get('pulse.name', '') || null });
    code = ev.code;
    history.replaceState(null, '', `${location.pathname}?c=${code}`);
    store.set('pulse.lastCode', code);
    $('ev-title').textContent = ev.title;
    document.title = `${ev.title} - AVNI Pulse`;
    show($('join-view'), false); show($('event-view'), true);
    $('nickname').value = store.get('pulse.name', '');
    $('ask-name').value = store.get('pulse.askName', '');
    if (watcher) watcher.stop();
    watcher = watchEvent(ev.event_id, refresh, (st) => {
      const el = $('live-state'); show(el, true);
      el.className = `live-state is-${st}`;
      el.textContent = st === 'live' ? 'Live' : 'Reconnecting';
    });
  } catch (e) {
    show($('join-view'), true); show($('event-view'), false);
    $('code').value = c;
    showError($('join-error'), e.message);
  }
}

async function refresh() {
  if (!code) return;
  S = await rpc('pulse_state', { p_code: code, p_pid: pid });
  skew = skewFrom(S.now);
  $('ev-title').textContent = S.event.title;
  $('ev-people').textContent = `${S.people} ${S.people === 1 ? 'person' : 'people'} joined`;
  renderLive();
  renderQa();
}

// ---------------------------------------------------------------- the live question

function renderLive() {
  const card = $('live-card');
  const it = S.item;
  if (S.event.closed) {
    liveKey = 'closed';
    card.innerHTML = '<h3>This session has ended</h3><p class="muted">Thank you for taking part.</p>';
    stopTick(); renderBoard(); return;
  }
  if (!it) {
    if (liveKey !== 'none') {
      liveKey = 'none';
      card.innerHTML = '<h3>Waiting for the presenter</h3><p class="muted">The next question appears here by itself. Meanwhile you can ask a question in Q&amp;A.</p>';
    }
    stopTick(); renderBoard(); return;
  }
  const answered = it.my_answer ? JSON.stringify(it.my_answer) : '';
  const key = [it.id, it.state, it.show_results, answered, it.correct, (it.options || []).length].join('|');
  if (key !== liveKey) {
    liveKey = key;
    card.innerHTML = `
      <div class="kind">${KIND_NAME[it.kind]}${it.state === 'closed' ? ' · closed' : ''}</div>
      <h3 class="live-q">${esc(it.question)}</h3>
      <div id="live-body"></div>
      <div class="error hidden" id="live-error"></div>
      <div id="live-results"></div>`;
    const body = $('live-body');
    if (it.kind === 'poll' || it.kind === 'quiz') buildChoices(body, it);
    else if (it.kind === 'wordcloud') buildWords(body, it);
    else buildSurvey(body, it);
  }
  updateResults(it);
  if (it.kind === 'quiz' && it.state === 'live') startTick(it); else stopTick();
  renderBoard();
}

function buildChoices(body, it) {
  const mine = it.my_answer ? it.my_answer.choice : null;
  const locked = it.state !== 'live' || (it.kind === 'quiz' && mine !== null);
  let html = '';
  if (it.kind === 'quiz' && it.state === 'live') {
    html += `<div class="row"><span class="muted grow">Time left</span><span class="timer-num" id="t-num"></span></div><div class="timer"><div id="t-bar" style="width:100%"></div></div>`;
  }
  html += `<div class="choices">${it.options.map((o, i) => {
    const cls = ['choice'];
    if (mine === i) cls.push('is-picked');
    if (it.correct != null) cls.push(it.correct === i ? 'is-correct' : 'is-wrong');
    return `<button class="${cls.join(' ')}" data-i="${i}" type="button" ${locked ? 'disabled' : ''}><span class="letter">${LETTERS[i]}</span><span>${esc(o)}</span></button>`;
  }).join('')}</div>`;
  if (it.kind === 'poll' && mine !== null && it.state === 'live') html += '<p class="note">Your vote is in. You can change it while voting is open.</p>';
  if (it.kind === 'quiz' && mine !== null && it.state === 'live') html += '<p class="note">Answer locked. The right answer shows when time is up.</p>';
  if (it.kind === 'quiz' && it.state === 'closed') {
    html += mine === null ? '<p class="muted">You did not answer this one.</p>'
      : (mine === it.correct ? `<p class="note">Correct! You scored <b>${it.my_score || 0}</b> points.</p>` : '<p class="error">Not this time. The right answer is marked in green.</p>');
  }
  if (it.kind === 'poll' && it.state === 'closed') html += '<p class="muted">Voting is closed.</p>';
  body.innerHTML = html;
  body.querySelectorAll('.choice').forEach((b) => b.addEventListener('click', () => send(it, { choice: Number(b.dataset.i) })));
}

function buildWords(body, it) {
  const mine = it.my_answer ? (it.my_answer.words || []).join(', ') : '';
  if (it.state !== 'live') { body.innerHTML = mine ? `<p class="muted">You sent: ${esc(mine)}</p>` : ''; return; }
  body.innerHTML = `
    <form id="w-form">
      <label class="field"><span>Up to 3 words or short phrases, separated by commas</span>
        <input class="input" id="w-text" maxlength="130" autocomplete="off" value="${esc(mine)}">
      </label>
      <button class="btn" type="submit">${mine ? 'Send again' : 'Send'}</button>
    </form>
    ${mine ? `<p class="note">Sent: ${esc(mine)}. Send again to change it.</p>` : ''}`;
  $('w-form').addEventListener('submit', (e) => { e.preventDefault(); send(it, { words: $('w-text').value }); });
}

function buildSurvey(body, it) {
  const prev = (it.my_answer && it.my_answer.answers) || [];
  const open = it.state === 'live';
  body.innerHTML = `<form id="s-form">${it.options.map((q, i) => {
    let field = '';
    if (q.type === 'choice') {
      field = `<div class="choices">${(q.options || []).map((o, j) => `<button type="button" class="choice ${prev[i] === j ? 'is-picked' : ''}" data-q="${i}" data-v="${j}" ${open ? '' : 'disabled'}><span class="letter">${LETTERS[j]}</span><span>${esc(o)}</span></button>`).join('')}</div>`;
    } else if (q.type === 'rating') {
      field = `<div class="stars">${[1, 2, 3, 4, 5].map((v) => `<button type="button" class="star ${prev[i] >= v ? 'is-on' : ''}" data-q="${i}" data-v="${v}" aria-label="${v} of 5" ${open ? '' : 'disabled'}>★</button>`).join('')}</div>`;
    } else {
      field = `<textarea class="input" rows="2" maxlength="500" data-q="${i}" ${open ? '' : 'disabled'}>${esc(prev[i] || '')}</textarea>`;
    }
    return `<div class="survey-q"><h4>${i + 1}. ${esc(q.q)}</h4>${field}</div>`;
  }).join('')}${open ? `<button class="btn" type="submit">${it.my_answer ? 'Update my answers' : 'Submit'}</button>` : ''}</form>
  ${it.my_answer ? '<p class="note">Thank you - your answers are in. You can change them while the survey is open.</p>' : ''}`;
  const picks = prev.slice();
  body.querySelectorAll('.choice[data-q]').forEach((b) => b.addEventListener('click', () => {
    const q = Number(b.dataset.q); picks[q] = Number(b.dataset.v);
    body.querySelectorAll(`.choice[data-q="${q}"]`).forEach((x) => x.classList.toggle('is-picked', x === b));
  }));
  body.querySelectorAll('.star').forEach((b) => b.addEventListener('click', () => {
    const q = Number(b.dataset.q); picks[q] = Number(b.dataset.v);
    body.querySelectorAll(`.star[data-q="${q}"]`).forEach((x) => x.classList.toggle('is-on', Number(x.dataset.v) <= picks[q]));
  }));
  const form = $('s-form');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const answers = it.options.map((q, i) => {
      if (q.type === 'text') { const t = form.querySelector(`textarea[data-q="${i}"]`).value.trim(); return t || null; }
      return picks[i] == null ? null : picks[i];
    });
    send(it, { answers });
  });
}

function updateResults(it) {
  const box = $('live-results');
  if (!box) return;
  const r = it.results;
  if (!r) { box.innerHTML = ''; return; }
  if (it.kind === 'poll' || it.kind === 'quiz') {
    let bars = box.querySelector('.bars');
    if (!bars) { box.innerHTML = '<h4 style="margin-top:16px">Results</h4><div class="bars"></div><p class="muted small-total"></p>'; bars = box.querySelector('.bars'); }
    renderBars(bars, it.options, r.counts, { correct: it.correct, mine: it.my_answer ? it.my_answer.choice : null });
    box.querySelector('.small-total').textContent = `${r.total} ${r.total === 1 ? 'answer' : 'answers'}`;
  } else if (it.kind === 'wordcloud') {
    if (!box.querySelector('.cloud')) box.innerHTML = '<h4 style="margin-top:16px">What everyone says</h4><div class="cloud"></div>';
    renderCloud(box.querySelector('.cloud'), r.words);
  } else {
    if (!box.querySelector('.survey-res')) box.innerHTML = '<h4 style="margin-top:16px">Results so far</h4><div class="survey-res"></div>';
    renderSurvey(box.querySelector('.survey-res'), it.options, r);
  }
}

function startTick(it) {
  stopTick();
  const step = () => {
    const end = Date.parse(it.opened_at) + it.seconds * 1000;
    const left = Math.max(0, end - (Date.now() + skew));
    const n = $('t-num'); const bar = $('t-bar');
    if (n) n.textContent = `${Math.ceil(left / 1000)} s`;
    if (bar) bar.style.width = `${(left * 100) / (it.seconds * 1000)}%`;
    if (left <= 0) {
      document.querySelectorAll('#live-body .choice').forEach((b) => { b.disabled = true; });
      stopTick();
    }
  };
  step();
  tick = setInterval(step, 250);
}
function stopTick() { if (tick) { clearInterval(tick); tick = null; } }

function renderBoard() {
  const lb = S && S.leaderboard;
  show($('board-card'), !!(lb && lb.length));
  if (!lb || !lb.length) return;
  renderLeaderboard($('board'), lb, { myPid: pid });
  $('my-rank').textContent = S.my_total != null ? `Your total: ${S.my_total} points · rank ${S.my_rank}` : 'Answer a quiz question to get on the board.';
}

async function send(it, answer) {
  const err = $('live-error');
  try {
    await rpc('pulse_answer', { p_code: code, p_pid: pid, p_item: it.id, p_answer: answer });
    showError(err, '');
    liveKey = '';
    watcher && watcher.now();
  } catch (e) { if (err) showError(err, e.message); }
}

// ---------------------------------------------------------------- Q&A

function renderQa() {
  const qs = (S.questions || []).slice();
  $('qa-count').textContent = qs.length ? `(${qs.length})` : '';
  show($('ask-form'), S.event.qa_open); show($('qa-closed'), !S.event.qa_open);
  if (qaSort === 'new') qs.reverse();
  $('qa-list').innerHTML = qs.length ? qs.map((q) => `
    <li class="qa-item ${q.answered ? 'is-answered' : ''}">
      <button class="vote ${q.voted ? 'is-on' : ''}" data-id="${q.id}" type="button" aria-label="Upvote"><span class="arrow">▲</span><span>${q.votes}</span></button>
      <div class="qa-body">${esc(q.body)}
        <div class="qa-meta">${esc(q.author)}${q.mine ? '<span class="chip">yours</span>' : ''}${q.answered ? '<span class="chip good">answered</span>' : ''}</div>
      </div>
    </li>`).join('') : '<li class="muted">No questions yet. Be the first to ask.</li>';
  $('qa-list').querySelectorAll('.vote').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try { await rpc('pulse_upvote', { p_code: code, p_pid: pid, p_question: b.dataset.id }); watcher.now(); } catch (e) { showError($('ask-error'), e.message); }
    b.disabled = false;
  }));
}

// ---------------------------------------------------------------- wiring

$('join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const c = $('code').value.trim().toUpperCase();
  if (c) join(c);
});
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('is-on', x === t));
  show($('tab-live'), t.dataset.tab === 'live'); show($('tab-qa'), t.dataset.tab === 'qa');
}));
$('qa-sort').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
  qaSort = b.dataset.sort;
  $('qa-sort').querySelectorAll('button').forEach((x) => x.classList.toggle('is-on', x === b));
  if (S) renderQa();
}));
$('name-btn').addEventListener('click', () => show($('name-form'), $('name-form').classList.contains('hidden')));
$('name-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('nickname').value.trim();
  store.set('pulse.name', name);
  try { await rpc('pulse_join', { p_code: code, p_pid: pid, p_nickname: name || null }); show($('name-form'), false); } catch (er) { alert(er.message); }
});
$('ask-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = $('ask-text').value.trim(); const name = $('ask-name').value.trim();
  if (!body) return;
  store.set('pulse.askName', name);
  try {
    await rpc('pulse_ask', { p_code: code, p_pid: pid, p_body: body, p_author: name || null });
    $('ask-text').value = ''; showError($('ask-error'), '');
    watcher.now();
  } catch (er) { showError($('ask-error'), er.message); }
});

const first = codeFromUrl();
if (first) join(first);
else { show($('join-view'), true); $('code').value = store.get('pulse.lastCode', '') || ''; $('code').focus(); }
