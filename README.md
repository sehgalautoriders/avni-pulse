# AVNI Pulse (WP-0067) - our own live polls, Q&A and quizzes

**What it is.** AVNI Pulse is our own version of Slido. A presenter runs live polls, a Q&A with upvotes, word clouds,
timed quizzes with a leaderboard and short surveys. The audience joins from any phone browser with a 6-letter code or a
QR picture. Nobody signs in. It does not depend on Slido in any way.

**Why we need it.** Ravi's IIMK classes need live polls and quizzes. At Sehgal we need technician assessments, manager
feedback and training checks. Planned on 08-10-2026; built on Ravi's GO of 24-10-2026 19:42.

**A real example.** Ravi opens AVNI.exe > AVNI Pulse and makes the event "IIMK Marketing - Session 4". The screen shows
the code (say K7M9QX) and a QR picture. Students scan it. Ravi adds a poll "Which channel works best for rural buyers?"
and presses **Show on phones**. Votes come in and the bars move on the projector within a second or two. A student asks
"Will the case slides be shared?" in Q&A; others upvote it, so it rises to the top.

## The flow, step by step

1. **Presenter makes an event** (`host.html` > New event). The database gives a 6-letter code and a secret
   **presenter key**. The key stays in that computer's browser. The Analytics tab shows it, so the event can also be
   opened on another computer.
2. **Presenter adds activities**: Poll (2-8 options), Quiz (options, `*` before the right one, seconds to answer),
   Word cloud (up to 3 words each), Survey (one question per line: `rating:`, `text:` or `choice: Question | a | b`).
3. **Audience joins** at https://sehgalautoriders.github.io/avni-pulse/ with the code (or the QR, which carries it).
   The phone keeps a random id. That id gives one vote per phone and one upvote per question.
4. **Show on phones** puts one activity live. The one shown before it closes by itself.
5. **Live results.** Every change bumps a counter row (`pulse_ticks`). Supabase Realtime tells every open screen of that
   event, and each screen fetches the fresh state once. If the live line drops, screens check every 3 seconds instead.
6. **Quiz**: the right answer stays hidden until time is up. The presenter screen stops answers by itself at zero.
   Score = 500 for a right answer + up to 500 more for speed. The leaderboard shows the top 10.
7. **Q&A**: anonymous unless the person types a name. The presenter can mark answered, hide or delete.
8. **Analytics**: people joined, people who answered, answers, questions, upvotes, and the share of people who answered
   each activity. **Download all answers (CSV)** gives the full table.

## Where things live

| Part | Place |
| --- | --- |
| Web pages | `docs/` - `index.html` (phones), `host.html` (presenter), plain JavaScript modules, no build step, no outside library |
| QR picture | `docs/js/qr.js` - our own QR maker, so no outside service sees the join link |
| Live data | Supabase project "Sehgal Hero" (Mumbai), tables `pulse_*`, schema in `sql/0001_pulse_core.sql` |
| Site | GitHub `sehgalautoriders/avni-pulse`, Pages from `docs/` on `main` |
| Inside AVNI.exe | its own row "AVNI Pulse" (a separate Stage 1 job) opens `host.html` |
| Release | target `AVNI-PULSE`, version line "AVNI Pulse r{n}", script `tools/release/Pulse-Release.ps1` |

## Controls

- Nobody reads or writes the `pulse_*` tables directly. Every action goes through a `pulse_*` database function that
  checks the rules: the presenter key (we keep only its sha256), the live state, the quiz timer, one answer per phone,
  at most 10 questions per phone in 10 minutes, and at most 60 new events an hour.
- The only table the public key can read is `pulse_ticks` (an event id and a number). Names, answers and questions
  never travel over Realtime.
- Survey written answers are shown only to the presenter, never on the phones.
- Tests use disposable "TEST ..." events only, and end them after.

## Checks

- `node tests/rpc_smoke.mjs` - 21 checks of the database side (poll, word cloud, quiz scoring, survey, Q&A upvotes,
  hiding, analytics, ended event).
- `python3.12 tests/qr_check.py` - our QR pictures are read back by two independent readers (zxing-cpp and OpenCV).

## Next steps (not built yet)

1. Hindi and Marathi screens (labels first, then questions typed in those languages - already stored as plain text).
2. Voice: speak a question into Q&A, and read out results.
3. Old events: clear events older than 90 days, and a list of past events per presenter across computers (needs our
   own sign-in for presenters).
4. Multiple-answer polls, image options, and a ranking question type.
5. A presenter view on the phone for walking around a workshop floor.
