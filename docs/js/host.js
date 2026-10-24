// AVNI Pulse - the presenter screen (opens inside AVNI.exe; works in any browser too).
// The presenter makes an event, adds activities (poll, quiz, word cloud, survey), puts one at a time on the phones,
// watches the answers arrive live, and runs the Q&A. The presenter key of each event stays in this computer's
// browser storage; the Analytics tab shows it so the event can be opened on another computer too.
import { rpc, store, watchEvent, esc, skewFrom } from './api.js';
import { qrSvg } from './qr.js';
import { JOIN_BASE } from './config.js';
import { renderBars, renderCloud, renderSurvey, renderLeaderboard, parseSurvey, KIND_NAME } from './render.js';

const $ = (id) => document.getElementById(id);
const show = (el, on) => el.classList.toggle('hidden', !on);
const showError = (el, msg) => { el.textContent = msg || ''; show(el, !!msg); };

let ev = null; // { code, key, title }
let H = null; let watcher = null; let skew = 0; let stageKey = ''; let tick = null; let closing = null;
let view = 'stage'; let qaFilter = 'top';

const events = () => store.get('pulse.host.events', []);
function remember(e) {
  const list = events().filter((x) => x.code !== e.code);
  list.unshift({ code: e.code, key: e.key, title: e.title, created: e.created || new Date().toISOString() });
  store.set('pulse.host.events', list.slice(0, 200));
}
const joinUrl = (code) => `${JOIN_BASE}?c=${code}`;
const host = (fn, args = {}) => rpc(fn, { p_code: ev.code, p_key: ev.key, ...args });

// ---------------------------------------------------------------- home

function renderHome() {
  show($('home-view'), true); show($('event-view'), false);
  ['back-btn', 'present-btn', 'live-state'].forEach((id) => show($(id), false));
  document.title = 'AVNI Pulse - presenter';
  const list = events();
  $('event-list').innerHTML = list.length ? list.map((e) => `
    <li><span class="ev-title">${esc(e.title)}<br><span class="muted" style="font-weight:400;font-size:13px">Code ${esc(e.code)} · made ${new Date(e.created).toLocaleDateString('en-IN')}</span></span>
      <button class="btn small" data-code="${esc(e.code)}" type="button">Open</button></li>`).join('')
    : '<li class="muted">No events on this computer yet. Make one above.</li>';
  $('event-list').querySelectorAll('button[data-code]').forEach((b) => b.addEventListener('click', () => openEvent(events().find((x) => x.code === b.dataset.code))));
}

$('create-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const r = await rpc('pulse_create_event', { p_title: $('new-title').value.trim() });
    const rec = { code: r.code, key: r.key, title: r.title };
    remember(rec);
    $('new-title').value = '';
    openEvent(rec);
  } catch (er) { showError($('create-error'), er.message); }
});
$('open-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const rec = { code: $('open-code').value.trim().toUpperCase(), key: $('open-key').value.trim() };
  try {
    const st = await rpc('pulse_host_state', { p_code: rec.code, p_key: rec.key });
    rec.title = st.event.title; rec.created = st.event.created_at;
    remember(rec); openEvent(rec);
  } catch (er) { showError($('open-error'), er.message); }
});

// ---------------------------------------------------------------- one event

async function openEvent(rec) {
  if (!rec) return;
  ev = rec; H = null; stageKey = '';
  history.replaceState(null, '', `${location.pathname}?e=${rec.code}`);
  show($('home-view'), false); show($('event-view'), true);
  show($('back-btn'), true); show($('present-btn'), true);
  $('ev-title').textContent = rec.title || rec.code;
  $('join-code').textContent = rec.code;
  $('join-url').textContent = JOIN_BASE.replace(/^https:\/\//, '');
  $('qr').innerHTML = qrSvg(joinUrl(rec.code));
  try {
    H = await host('pulse_host_state');
  } catch (er) {
    $('stage').innerHTML = `<div class="error">${esc(er.message)}</div>`;
    return;
  }
  if (watcher) watcher.stop();
  watcher = watchEvent(H.event.id, refresh, (st) => {
    const el = $('live-state'); show(el, true);
    el.className = `live-state is-${st}`;
    el.textContent = st === 'live' ? 'Live' : 'Reconnecting - checking every 3 s';
  });
}

async function refresh() {
  if (!ev) return;
  H = await host('pulse_host_state');
  skew = skewFrom(H.now);
  ev.title = H.event.title;
  $('ev-title').textContent = H.event.title;
  document.title = `${H.event.title} - AVNI Pulse`;
  const a = H.analytics;
  $('people').textContent = `${a.people} joined · ${a.responders} answered`;
  renderItems(); renderStage(); renderQa();
  if (view === 'board') renderLeaderboard($('board'), H.leaderboard);
  if (view === 'stats') renderStats();
}

function activeItem() { return H && H.items.find((i) => i.id === H.event.active_item) || null; }

function renderItems() {
  const act = H.event.active_item;
  $('items').innerHTML = H.items.length ? H.items.map((it) => {
    const on = it.id === act; const n = it.results ? it.results.total : 0;
    const b = [];
    if (!on) b.push(`<button class="btn small" data-a="live" data-id="${it.id}" type="button">Show on phones</button>`);
    if (on && it.state === 'live') b.push(`<button class="btn small dark" data-a="close" data-id="${it.id}" type="button">Stop answers</button>`);
    if (on) b.push(`<button class="btn ghost small" data-a="off" data-id="${it.id}" type="button">Take off phones</button>`);
    if (it.kind !== 'quiz') b.push(`<button class="btn ghost small" data-a="results" data-id="${it.id}" type="button">${it.show_results ? 'Hide results on phones' : 'Show results on phones'}</button>`);
    if (n) b.push(`<button class="btn ghost small" data-a="reset" data-id="${it.id}" type="button">${it.kind === 'quiz' ? 'Run again' : 'Clear answers'}</button>`);
    b.push(`<button class="btn danger small" data-a="delete" data-id="${it.id}" type="button">Delete</button>`);
    return `<li class="item ${on ? 'is-active' : ''}">
      <div class="item-head"><span class="kind">${KIND_NAME[it.kind]}</span><span class="chip ${it.state === 'live' ? 'good' : it.state === 'closed' ? '' : 'warn'}">${it.state === 'draft' ? 'not shown yet' : it.state}</span><span class="chip">${n} ${n === 1 ? 'answer' : 'answers'}</span></div>
      <div class="item-q">${esc(it.question)}</div>
      <div class="item-actions">${b.join('')}</div></li>`;
  }).join('') : '<li class="muted">No activities yet. Add a poll above.</li>';
  $('items').querySelectorAll('button[data-a]').forEach((btn) => btn.addEventListener('click', () => itemAction(btn.dataset.a, btn.dataset.id, btn)));
}

async function itemAction(a, id, btn) {
  const it = H.items.find((x) => x.id === id);
  if (a === 'delete' && !confirm(`Delete "${it.question}" and all its answers?`)) return;
  if (a === 'reset' && !confirm(`Clear all ${it.results.total} answers of "${it.question}"?`)) return;
  btn.disabled = true;
  try {
    if (a === 'live') await host('pulse_set_live', { p_item: id });
    if (a === 'off') await host('pulse_set_live', { p_item: null });
    if (a === 'close') await host('pulse_close_item', { p_item: id });
    if (a === 'results') await host('pulse_show_results', { p_item: id, p_show: !it.show_results });
    if (a === 'reset') await host('pulse_reset_item', { p_item: id });
    if (a === 'delete') await host('pulse_delete_item', { p_item: id });
    stageKey = '';
    await watcher.now();
  } catch (er) { alert(er.message); }
  btn.disabled = false;
}

// ---------------------------------------------------------------- the stage (big picture of the live activity)

function renderStage() {
  const st = $('stage'); const it = activeItem();
  if (!it) {
    stopTick();
    if (stageKey !== 'none') {
      stageKey = 'none';
      st.innerHTML = `<div class="stage-empty"><div><h2>Nothing on the phones right now</h2>
        <p class="muted">Press "Show on phones" next to an activity. People can still send questions in Q&amp;A.</p>
        <p style="font-size:1.4rem">Join at <b>${esc(JOIN_BASE.replace(/^https:\/\//, ''))}</b> with code <b style="color:var(--orange)">${esc(ev.code)}</b></p></div></div>`;
    }
    return;
  }
  const key = [it.id, it.state, it.correct, (it.options || []).length].join('|');
  if (key !== stageKey) {
    stageKey = key;
    st.innerHTML = `<div class="kind">${KIND_NAME[it.kind]} · ${it.state === 'live' ? 'taking answers' : 'closed'}</div>
      <h2 class="stage-q">${esc(it.question)}</h2>
      <div class="stage-meta"><span id="st-count"></span><span id="st-timer"></span></div>
      ${it.kind === 'quiz' && it.state === 'live' ? '<div class="timer"><div id="st-bar" style="width:100%"></div></div>' : ''}
      <div id="st-body"></div>`;
  }
  const r = it.results || {}; const people = H.analytics.people;
  $('st-count').textContent = `${r.total || 0} of ${people} answered`;
  const body = $('st-body');
  if (it.kind === 'poll' || it.kind === 'quiz') {
    let bars = body.querySelector('.bars');
    if (!bars) { body.innerHTML = '<div class="bars"></div>'; bars = body.querySelector('.bars'); }
    // a quiz shows the right answer only after answers stop, so the room does not see it early
    renderBars(bars, it.options, r.counts, { correct: it.kind === 'quiz' && it.state === 'closed' ? it.correct : null, big: true });
  } else if (it.kind === 'wordcloud') {
    if (!body.querySelector('.cloud')) body.innerHTML = '<div class="cloud"></div>';
    renderCloud(body.querySelector('.cloud'), r.words);
  } else {
    if (!body.querySelector('.survey-res')) body.innerHTML = '<div class="survey-res"></div>';
    renderSurvey(body.querySelector('.survey-res'), it.options, r, { host: true });
  }
  if (it.kind === 'quiz' && it.state === 'live') startTick(it); else stopTick();
}

function startTick(it) {
  if (tick && tick.id === it.id) return;
  stopTick();
  const step = () => {
    const end = Date.parse(it.opened_at) + it.seconds * 1000;
    const left = Math.max(0, end - (Date.now() + skew));
    const t = $('st-timer'); const bar = $('st-bar');
    if (t) t.textContent = `${Math.ceil(left / 1000)} s left`;
    if (bar) bar.style.width = `${(left * 100) / (it.seconds * 1000)}%`;
    // time is up: stop answers so the phones show the right answer and the scores
    if (left <= 0 && closing !== it.id) {
      closing = it.id;
      setTimeout(() => host('pulse_close_item', { p_item: it.id }).then(() => watcher.now()).catch(() => { closing = null; }), 1600);
    }
  };
  step();
  tick = { id: it.id, h: setInterval(step, 250) };
}
function stopTick() { if (tick) { clearInterval(tick.h); tick = null; } }

// ---------------------------------------------------------------- Q&A

function renderQa() {
  $('qa-toggle').textContent = H.event.qa_open ? 'Close questions' : 'Open questions';
  let qs = H.questions.slice();
  if (qaFilter === 'top') qs = qs.filter((q) => !q.hidden && !q.answered);
  if (qaFilter === 'new') qs = qs.filter((q) => !q.hidden).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  if (qaFilter === 'answered') qs = qs.filter((q) => q.answered && !q.hidden);
  if (qaFilter === 'hidden') qs = qs.filter((q) => q.hidden);
  $('qa-list').innerHTML = qs.length ? qs.map((q) => `
    <li class="qa-item ${q.answered ? 'is-answered' : ''}">
      <div class="vote" title="Upvotes"><span class="arrow">▲</span><span>${q.votes}</span></div>
      <div class="qa-body">${esc(q.body)}
        <div class="qa-meta">${esc(q.author)} · ${new Date(q.created_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</div>
        <div class="item-actions" style="margin-top:6px">
          <button class="btn ghost small" data-q="${q.id}" data-a="${q.answered ? 'unanswered' : 'answered'}" type="button">${q.answered ? 'Not answered' : 'Mark answered'}</button>
          <button class="btn ghost small" data-q="${q.id}" data-a="${q.hidden ? 'show' : 'hide'}" type="button">${q.hidden ? 'Show' : 'Hide'}</button>
          <button class="btn danger small" data-q="${q.id}" data-a="delete" type="button">Delete</button>
        </div>
      </div>
    </li>`).join('') : `<li class="muted">${qaFilter === 'top' ? 'No open questions yet.' : 'Nothing here.'}</li>`;
  $('qa-list').querySelectorAll('button[data-q]').forEach((b) => b.addEventListener('click', async () => {
    if (b.dataset.a === 'delete' && !confirm('Delete this question for everyone?')) return;
    b.disabled = true;
    try { await host('pulse_qa_mod', { p_question: b.dataset.q, p_action: b.dataset.a }); await watcher.now(); } catch (er) { alert(er.message); }
    b.disabled = false;
  }));
}
$('qa-toggle').addEventListener('click', async () => {
  try { await host('pulse_set_event', { p_qa_open: !H.event.qa_open }); await watcher.now(); } catch (er) { alert(er.message); }
});
$('qa-tabs').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
  qaFilter = b.dataset.f;
  $('qa-tabs').querySelectorAll('button').forEach((x) => x.classList.toggle('is-on', x === b));
  if (H) renderQa();
}));

// ---------------------------------------------------------------- analytics

function renderStats() {
  const a = H.analytics; const people = a.people || 0;
  $('stats-view').innerHTML = `
    <h2>Participation</h2>
    <div class="stats">
      <div class="stat"><b>${people}</b><span>people joined</span></div>
      <div class="stat"><b>${a.responders}</b><span>answered at least once</span></div>
      <div class="stat"><b>${a.answers}</b><span>answers in all</span></div>
      <div class="stat"><b>${a.questions}</b><span>questions asked (by ${a.askers})</span></div>
      <div class="stat"><b>${a.upvotes}</b><span>upvotes</span></div>
    </div>
    <h3>Answers per activity</h3>
    <div class="bars" id="per-item"></div>
    <p style="margin-top:16px"><button class="btn dark small" id="csv-btn" type="button">Download all answers (CSV)</button></p>
    <h3 style="margin-top:18px">Presenter key</h3>
    <p class="muted">Keep this to open the event on another computer (home page > "Open an event from another computer"). Do not show it on the projector.</p>
    <p><code id="the-key" style="font-size:15px;overflow-wrap:anywhere">${esc(ev.key)}</code></p>`;
  const per = a.per_item || [];
  // participation = share of the people who joined that answered this activity
  const box = $('per-item');
  box.innerHTML = per.length ? per.map((p) => {
    const pct = people ? Math.round((p.responses * 100) / people) : 0;
    return `<div class="bar-row"><div class="bar-label"><span class="bar-letter">${KIND_NAME[p.kind]}</span><span class="bar-text">${esc(p.question)}</span><span class="bar-num">${p.responses} · ${pct}%</span></div><div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div></div>`;
  }).join('') : '<p class="muted">No activities yet.</p>';
  $('csv-btn').addEventListener('click', downloadCsv);
}

function downloadCsv() {
  const rows = [['event', 'code', 'kind', 'question', 'option or word', 'count']];
  H.items.forEach((it) => {
    const r = it.results || {};
    if (it.kind === 'poll' || it.kind === 'quiz') it.options.forEach((o, i) => rows.push([H.event.title, H.event.code, it.kind, it.question, o + (it.correct === i ? ' (right answer)' : ''), (r.counts || [])[i] || 0]));
    if (it.kind === 'wordcloud') (r.words || []).forEach((w) => rows.push([H.event.title, H.event.code, it.kind, it.question, w.w, w.n]));
    if (it.kind === 'survey') it.options.forEach((q, i) => {
      const qr = (r.questions || [])[i] || {};
      if (q.type === 'choice') (q.options || []).forEach((o, j) => rows.push([H.event.title, H.event.code, 'survey choice', q.q, o, (qr.counts || [])[j] || 0]));
      if (q.type === 'rating') rows.push([H.event.title, H.event.code, 'survey rating', q.q, `average ${qr.avg ?? '-'}`, qr.n || 0]);
      if (q.type === 'text') (qr.texts || []).forEach((t) => rows.push([H.event.title, H.event.code, 'survey text', q.q, t, 1]));
    });
  });
  H.questions.forEach((q) => rows.push([H.event.title, H.event.code, 'Q&A', q.body, `${q.author}${q.answered ? ' (answered)' : ''}${q.hidden ? ' (hidden)' : ''}`, q.votes]));
  const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
  a.download = `AVNI Pulse ${H.event.code} ${new Date().toLocaleDateString('en-IN').replace(/\//g, '-')}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

$('view-tabs').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
  view = b.dataset.view;
  $('view-tabs').querySelectorAll('button').forEach((x) => x.classList.toggle('is-on', x === b));
  show($('stage'), view === 'stage'); show($('board-view'), view === 'board'); show($('stats-view'), view === 'stats');
  if (H && view === 'board') renderLeaderboard($('board'), H.leaderboard);
  if (H && view === 'stats') renderStats();
}));

// ---------------------------------------------------------------- add an activity

function syncAddForm() {
  const k = $('add-kind').value;
  show($('add-secs-field'), k === 'quiz');
  show($('add-opts-field'), k !== 'wordcloud');
  $('add-q-label').textContent = k === 'survey' ? 'Survey title' : 'Question';
  $('add-opts-label').textContent = {
    poll: 'Options, one per line (2 to 8)',
    quiz: 'Options, one per line - put * in front of the right answer',
    survey: 'Questions, one per line. Start each with rating:, text: or choice: (choice: Question | option | option)',
  }[k] || '';
  $('add-opts').placeholder = {
    poll: 'Yes\nNo\nNot sure',
    quiz: 'Mumbai\n*New Delhi\nKolkata',
    survey: 'rating: How useful was today\'s session?\nchoice: Which part helped most? | Cases | Lecture | Group work\ntext: What should we change?',
  }[k] || '';
}
$('add-kind').addEventListener('change', syncAddForm);
syncAddForm();

$('add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const kind = $('add-kind').value; const q = $('add-q').value.trim();
  const lines = $('add-opts').value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let options = []; let correct = null; let seconds = null;
  if (kind === 'poll') options = lines;
  if (kind === 'quiz') {
    options = lines.map((l) => l.replace(/^\*\s*/, ''));
    correct = lines.findIndex((l) => l.startsWith('*'));
    if (correct < 0) { showError($('add-error'), 'Put * in front of the right answer.'); return; }
    seconds = Number($('add-secs').value) || 20;
  }
  if (kind === 'survey') options = parseSurvey($('add-opts').value);
  try {
    await host('pulse_add_item', { p_kind: kind, p_question: q, p_options: options, p_correct: correct, p_seconds: seconds });
    $('add-q').value = ''; $('add-opts').value = ''; showError($('add-error'), '');
    await watcher.now();
  } catch (er) { showError($('add-error'), er.message); }
});

// ---------------------------------------------------------------- big join picture, present mode, back

function openOverlay() {
  $('qr-big').innerHTML = qrSvg(joinUrl(ev.code));
  $('big-url').textContent = JOIN_BASE.replace(/^https:\/\//, '');
  $('big-code').textContent = ev.code;
  show($('overlay'), true);
}
$('qr').addEventListener('click', openOverlay);
$('overlay-close').addEventListener('click', () => show($('overlay'), false));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { show($('overlay'), false); document.body.classList.remove('present'); } });
$('present-btn').addEventListener('click', () => {
  const on = document.body.classList.toggle('present');
  $('present-btn').textContent = on ? 'Exit present' : 'Present';
});
$('back-btn').addEventListener('click', () => {
  if (watcher) watcher.stop(); watcher = null; ev = null; stopTick();
  document.body.classList.remove('present');
  history.replaceState(null, '', location.pathname);
  renderHome();
});

// ---------------------------------------------------------------- start
const want = new URL(location.href).searchParams.get('e');
const rec = want && events().find((x) => x.code === want.toUpperCase());
if (rec) openEvent(rec); else renderHome();
