// AVNI Pulse - pictures of results, shared by the presenter screen and the phones.
// Bars keep their element between refreshes, so a new vote makes the bar slide to its new length.
import { esc } from './api.js';

export const KIND_NAME = { poll: 'Poll', quiz: 'Quiz', wordcloud: 'Word cloud', survey: 'Survey' };
const LETTERS = 'ABCDEFGH';

/** Bars for a poll or quiz. container keeps its rows; correct = index of the right answer (quiz, after close). */
export function renderBars(container, options, counts, { correct = null, mine = null, big = false } = {}) {
  const total = (counts || []).reduce((a, b) => a + b, 0);
  if (container.dataset.n !== String(options.length) || container.dataset.sig !== options.join('\u0001')) {
    container.innerHTML = options.map((o, i) => `
      <div class="bar-row" data-i="${i}">
        <div class="bar-label"><span class="bar-letter">${LETTERS[i]}</span><span class="bar-text">${esc(o)}</span><span class="bar-num"></span></div>
        <div class="bar-track"><div class="bar-fill" style="width:0%"></div></div>
      </div>`).join('');
    container.dataset.n = String(options.length);
    container.dataset.sig = options.join('\u0001');
  }
  container.classList.toggle('bars-big', big);
  options.forEach((_, i) => {
    const row = container.querySelector(`.bar-row[data-i="${i}"]`);
    const n = (counts && counts[i]) || 0;
    const pct = total ? Math.round((n * 100) / total) : 0;
    row.querySelector('.bar-fill').style.width = `${pct}%`;
    row.querySelector('.bar-num').textContent = `${pct}% · ${n}`;
    row.classList.toggle('is-correct', correct === i);
    row.classList.toggle('is-wrong', correct !== null && correct !== i);
    row.classList.toggle('is-mine', mine === i);
  });
  container.dataset.total = String(total);
}

export function renderCloud(container, words) {
  if (!words || !words.length) { container.innerHTML = '<p class="muted center">No words yet.</p>'; return; }
  const max = Math.max(...words.map((w) => w.n));
  const min = Math.min(...words.map((w) => w.n));
  const hues = ['#F47B20', '#1A1F2B', '#E8590B', '#3B6EA8', '#5F6670', '#2E8B57'];
  // largest in the middle: alternate left and right of the biggest word
  const sorted = [...words].sort((a, b) => b.n - a.n);
  const arranged = [];
  sorted.forEach((w, i) => { if (i % 2) arranged.push(w); else arranged.unshift(w); });
  container.innerHTML = arranged.map((w, i) => {
    const t = max === min ? 1 : (w.n - min) / (max - min);
    const size = 1 + t * 2.6;
    return `<span class="cloud-word" style="font-size:${size.toFixed(2)}em;color:${hues[i % hues.length]}" title="${w.n}">${esc(w.w)}</span>`;
  }).join(' ');
}

export function renderSurvey(container, questions, results, { host = false } = {}) {
  const r = (results && results.questions) || [];
  container.innerHTML = questions.map((q, i) => {
    const res = r[i] || {};
    let body = '';
    if (q.type === 'choice') {
      body = `<div class="bars" data-q="${i}"></div>`;
    } else if (q.type === 'rating') {
      const avg = res.avg == null ? '-' : Number(res.avg).toFixed(1);
      body = `<p class="rating-avg"><b>${avg}</b> out of 5 <span class="muted">from ${res.n || 0} answers</span></p><div class="bars" data-q="${i}"></div>`;
    } else {
      const texts = res.texts || [];
      body = `<p class="muted">${res.n || 0} written answers</p>` +
        (host && texts.length ? `<ul class="texts">${texts.slice(0, 100).map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : '');
    }
    return `<div class="survey-q"><h4>${i + 1}. ${esc(q.q)}</h4>${body}</div>`;
  }).join('');
  questions.forEach((q, i) => {
    const el = container.querySelector(`.bars[data-q="${i}"]`);
    if (!el) return;
    if (q.type === 'choice') renderBars(el, q.options || [], (r[i] && r[i].counts) || []);
    if (q.type === 'rating') renderBars(el, ['1 star', '2 stars', '3 stars', '4 stars', '5 stars'], (r[i] && r[i].counts) || []);
  });
}

export function renderLeaderboard(container, rows, { myPid = null } = {}) {
  if (!rows || !rows.length) { container.innerHTML = '<p class="muted">No quiz scores yet.</p>'; return; }
  container.innerHTML = `<ol class="leader">${rows.map((r, i) => `
    <li class="${r.pid === myPid ? 'is-me' : ''}"><span class="rank">${i + 1}</span><span class="name">${esc(r.name)}</span><span class="score">${r.score}</span></li>`).join('')}</ol>`;
}

/** Turns the presenter's survey text box into questions. One question per line:
 *  "rating: How useful was the session?"  "text: What should we change?"  "choice: Best day? | Monday | Tuesday" */
export function parseSurvey(text) {
  return String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((line) => {
    const m = line.match(/^(rating|text|choice)\s*:\s*(.*)$/i);
    const type = m ? m[1].toLowerCase() : 'text';
    const rest = m ? m[2] : line;
    if (type === 'choice') {
      const parts = rest.split('|').map((s) => s.trim()).filter(Boolean);
      return { q: parts[0] || '', type, options: parts.slice(1) };
    }
    return { q: rest.trim(), type };
  });
}
