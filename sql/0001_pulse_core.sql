-- AVNI Pulse 0001 - our own live audience interaction (Ravi 24-10-2026 19:42: "build AVNI Pulse, our own Slido").
-- What it holds: an EVENT (a class or a workshop session, joined with a 6-letter code), its ITEMS (poll, word cloud,
-- timed quiz, survey), the PEOPLE who joined (a random id kept in their phone browser, no sign-in), their ANSWERS,
-- and the Q&A QUESTIONS with UPVOTES.
-- Who can do what: nobody reads or writes these tables directly. Phones and the presenter screen call the pulse_*
-- functions below with the publishable key. The presenter proves the event is theirs with the presenter key that
-- pulse_create_event gave them (we keep only its sha256). The one table anyone may read is pulse_ticks: an event id and
-- a counter. Realtime sends its change to every screen of that event, and each screen then asks pulse_state again.
-- So no raw answer, name or question text ever leaves through realtime.

create table if not exists public.pulse_events (
  id            uuid primary key default gen_random_uuid(),
  code          text not null unique,
  title         text not null,
  host_hash     text not null,
  active_item   uuid,
  qa_open       boolean not null default true,
  closed        boolean not null default false,
  created_at    timestamptz not null default now(),
  last_activity timestamptz not null default now()
);

create table if not exists public.pulse_items (
  id           uuid primary key default gen_random_uuid(),
  event_id     uuid not null references public.pulse_events(id) on delete cascade,
  kind         text not null check (kind in ('poll', 'wordcloud', 'quiz', 'survey')),
  question     text not null check (char_length(question) between 1 and 300),
  options      jsonb not null default '[]'::jsonb,
  correct      int,
  seconds      int,
  state        text not null default 'draft' check (state in ('draft', 'live', 'closed')),
  show_results boolean not null default true,
  opened_at    timestamptz,
  position     int not null default 0,
  created_at   timestamptz not null default now()
);
create index if not exists pulse_items_event on public.pulse_items(event_id, position);

create table if not exists public.pulse_people (
  event_id  uuid not null references public.pulse_events(id) on delete cascade,
  pid       uuid not null,
  nickname  text,
  joined_at timestamptz not null default now(),
  primary key (event_id, pid)
);

create table if not exists public.pulse_answers (
  item_id  uuid not null references public.pulse_items(id) on delete cascade,
  pid      uuid not null,
  event_id uuid not null references public.pulse_events(id) on delete cascade,
  answer   jsonb not null,
  score    int not null default 0,
  at       timestamptz not null default now(),
  primary key (item_id, pid)
);
create index if not exists pulse_answers_event on public.pulse_answers(event_id);

create table if not exists public.pulse_questions (
  id         uuid primary key default gen_random_uuid(),
  event_id   uuid not null references public.pulse_events(id) on delete cascade,
  pid        uuid not null,
  body       text not null check (char_length(body) between 1 and 300),
  author     text,
  hidden     boolean not null default false,
  answered   boolean not null default false,
  votes      int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists pulse_questions_event on public.pulse_questions(event_id);

create table if not exists public.pulse_qvotes (
  question_id uuid not null references public.pulse_questions(id) on delete cascade,
  pid         uuid not null,
  primary key (question_id, pid)
);

create table if not exists public.pulse_ticks (
  event_id uuid primary key references public.pulse_events(id) on delete cascade,
  rev      bigint not null default 0,
  at       timestamptz not null default now()
);

alter table public.pulse_events    enable row level security;
alter table public.pulse_items     enable row level security;
alter table public.pulse_people    enable row level security;
alter table public.pulse_answers   enable row level security;
alter table public.pulse_questions enable row level security;
alter table public.pulse_qvotes    enable row level security;
alter table public.pulse_ticks     enable row level security;

revoke all on public.pulse_events, public.pulse_items, public.pulse_people, public.pulse_answers,
              public.pulse_questions, public.pulse_qvotes from anon, authenticated;
revoke all on public.pulse_ticks from anon, authenticated;
grant select on public.pulse_ticks to anon, authenticated;
drop policy if exists pulse_ticks_read on public.pulse_ticks;
create policy pulse_ticks_read on public.pulse_ticks for select to anon, authenticated using (true);

do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'pulse_ticks') then
    alter publication supabase_realtime add table public.pulse_ticks;
  end if;
end $$;

-- ---------------------------------------------------------------- helpers (not callable from outside)

create or replace function public.pulse__hash(p text) returns text
language sql immutable set search_path = public, extensions as $$
  select encode(extensions.digest(coalesce(p, ''), 'sha256'), 'hex')
$$;

create or replace function public.pulse__bump(p_event uuid) returns void
language sql security definer set search_path = public, extensions as $$
  insert into public.pulse_ticks(event_id, rev, at) values (p_event, 1, now())
  on conflict (event_id) do update set rev = public.pulse_ticks.rev + 1, at = now();
  update public.pulse_events set last_activity = now() where id = p_event;
$$;

-- the event of a code, for a phone (must exist and be open)
create or replace function public.pulse__event(p_code text) returns public.pulse_events
language plpgsql stable security definer set search_path = public, extensions as $$
declare e public.pulse_events;
begin
  select * into e from public.pulse_events where code = upper(trim(p_code));
  if e.id is null then raise exception 'PULSE: no event with the code %', upper(trim(p_code)) using errcode = 'P0002'; end if;
  return e;
end $$;

-- the event of a code, for its presenter (the presenter key must match)
create or replace function public.pulse__host(p_code text, p_key text) returns public.pulse_events
language plpgsql stable security definer set search_path = public, extensions as $$
declare e public.pulse_events;
begin
  e := public.pulse__event(p_code);
  if e.host_hash <> public.pulse__hash(p_key) then
    raise exception 'PULSE: this presenter key does not open event %', e.code using errcode = '42501';
  end if;
  return e;
end $$;

-- results of one item. p_host = true adds survey text answers.
create or replace function public.pulse__results(p_item uuid, p_host boolean) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare it public.pulse_items; n int; r jsonb; q jsonb; i int; qs jsonb := '[]'::jsonb;
begin
  select * into it from public.pulse_items where id = p_item;
  if it.id is null then return null; end if;
  select count(*) into n from public.pulse_answers where item_id = p_item;
  if it.kind in ('poll', 'quiz') then
    select coalesce(jsonb_agg(coalesce(c.n, 0) order by o.idx), '[]'::jsonb) into r
      from generate_series(0, jsonb_array_length(it.options) - 1) as o(idx)
      left join (select (answer->>'choice')::int as ch, count(*) as n from public.pulse_answers
                 where item_id = p_item group by 1) c on c.ch = o.idx;
    return jsonb_build_object('total', n, 'counts', r);
  elsif it.kind = 'wordcloud' then
    select coalesce(jsonb_agg(jsonb_build_object('w', w, 'n', cnt) order by cnt desc, w), '[]'::jsonb) into r
      from (select w, count(*) as cnt from (
              select lower(trim(x)) as w from public.pulse_answers a,
                     jsonb_array_elements_text(a.answer->'words') as x where a.item_id = p_item) s
            where w <> '' group by w order by count(*) desc, w limit 60) t;
    return jsonb_build_object('total', n, 'words', r);
  else -- survey: one block per question
    for i in 0 .. jsonb_array_length(it.options) - 1 loop
      q := it.options->i;
      if q->>'type' = 'choice' then
        select coalesce(jsonb_agg(coalesce(c.n, 0) order by o.idx), '[]'::jsonb) into r
          from generate_series(0, greatest(jsonb_array_length(q->'options') - 1, 0)) as o(idx)
          left join (select (answer->'answers'->>i)::int as ch, count(*) as n from public.pulse_answers
                     where item_id = p_item and jsonb_typeof(answer->'answers'->i) = 'number' group by 1) c on c.ch = o.idx;
        qs := qs || jsonb_build_array(jsonb_build_object('type', 'choice', 'counts', r));
      elsif q->>'type' = 'rating' then
        select jsonb_build_object('type', 'rating',
                 'avg', round(avg((answer->'answers'->>i)::numeric), 2),
                 'n', count(*),
                 'counts', (select jsonb_agg(coalesce((select count(*) from public.pulse_answers b
                              where b.item_id = p_item and jsonb_typeof(b.answer->'answers'->i) = 'number'
                                and (b.answer->'answers'->>i)::int = s), 0) order by s) from generate_series(1, 5) s))
          into r from public.pulse_answers where item_id = p_item and jsonb_typeof(answer->'answers'->i) = 'number';
        qs := qs || jsonb_build_array(r);
      else
        select jsonb_build_object('type', 'text', 'n', count(*),
                 'texts', case when p_host then coalesce(jsonb_agg(answer->'answers'->>i order by at desc), '[]'::jsonb) else '[]'::jsonb end)
          into r from public.pulse_answers where item_id = p_item and coalesce(answer->'answers'->>i, '') <> '';
        qs := qs || jsonb_build_array(r);
      end if;
    end loop;
    return jsonb_build_object('total', n, 'questions', qs);
  end if;
end $$;

create or replace function public.pulse__leaderboard(p_event uuid) returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select coalesce(jsonb_agg(jsonb_build_object('name', name, 'score', score, 'pid', pid) order by score desc, name), '[]'::jsonb)
  from (select a.pid, coalesce(nullif(p.nickname, ''), 'Guest ' || upper(left(a.pid::text, 4))) as name, sum(a.score)::int as score
          from public.pulse_answers a join public.pulse_items i on i.id = a.item_id and i.kind = 'quiz'
          left join public.pulse_people p on p.event_id = a.event_id and p.pid = a.pid
         where a.event_id = p_event group by a.pid, p.nickname order by sum(a.score) desc limit 10) t
$$;

-- ---------------------------------------------------------------- presenter

create or replace function public.pulse_create_event(p_title text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare k text; c text; alphabet text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; i int; tries int := 0; e uuid;
begin
  if coalesce(trim(p_title), '') = '' or char_length(p_title) > 120 then raise exception 'PULSE: give the event a name of 1 to 120 letters'; end if;
  if (select count(*) from public.pulse_events where created_at > now() - interval '1 hour') >= 60 then
    raise exception 'PULSE: too many new events in the last hour - please try again in a few minutes';
  end if;
  k := encode(extensions.gen_random_bytes(18), 'hex');
  loop
    c := '';
    for i in 1 .. 6 loop c := c || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1); end loop;
    exit when not exists (select 1 from public.pulse_events where code = c);
    tries := tries + 1;
    if tries > 20 then raise exception 'PULSE: could not find a free code'; end if;
  end loop;
  insert into public.pulse_events(code, title, host_hash) values (c, trim(p_title), public.pulse__hash(k)) returning id into e;
  insert into public.pulse_ticks(event_id) values (e);
  return jsonb_build_object('event_id', e, 'code', c, 'key', k, 'title', trim(p_title));
end $$;

create or replace function public.pulse_add_item(p_code text, p_key text, p_kind text, p_question text,
                                                 p_options jsonb default '[]'::jsonb, p_correct int default null,
                                                 p_seconds int default null) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare e public.pulse_events; n int; q jsonb; v_id uuid; pos int;
begin
  e := public.pulse__host(p_code, p_key);
  if p_kind not in ('poll', 'wordcloud', 'quiz', 'survey') then raise exception 'PULSE: unknown kind %', p_kind; end if;
  if coalesce(trim(p_question), '') = '' then raise exception 'PULSE: the question is empty'; end if;
  if (select count(*) from public.pulse_items where event_id = e.id) >= 100 then raise exception 'PULSE: an event holds at most 100 items'; end if;
  p_options := coalesce(p_options, '[]'::jsonb);
  if jsonb_typeof(p_options) <> 'array' then raise exception 'PULSE: options must be a list'; end if;
  n := jsonb_array_length(p_options);
  if p_kind in ('poll', 'quiz') then
    if n < 2 or n > 8 then raise exception 'PULSE: a % needs 2 to 8 options', p_kind; end if;
    if exists (select 1 from jsonb_array_elements(p_options) o where jsonb_typeof(o) <> 'string' or char_length(trim(o #>> '{}')) not between 1 and 120) then
      raise exception 'PULSE: every option needs 1 to 120 letters';
    end if;
  elsif p_kind = 'survey' then
    if n < 1 or n > 15 then raise exception 'PULSE: a survey needs 1 to 15 questions'; end if;
    for q in select * from jsonb_array_elements(p_options) loop
      if coalesce(q->>'q', '') = '' or coalesce(q->>'type', '') not in ('choice', 'rating', 'text') then
        raise exception 'PULSE: every survey question needs a text and a type (choice, rating or text)';
      end if;
      if q->>'type' = 'choice' and (jsonb_typeof(q->'options') <> 'array' or jsonb_array_length(q->'options') not between 2 and 8) then
        raise exception 'PULSE: a choice question in a survey needs 2 to 8 options';
      end if;
    end loop;
  else
    p_options := '[]'::jsonb;
  end if;
  if p_kind = 'quiz' then
    if p_correct is null or p_correct < 0 or p_correct >= n then raise exception 'PULSE: mark the right answer of the quiz question'; end if;
    p_seconds := least(greatest(coalesce(p_seconds, 20), 5), 300);
  else
    p_correct := null; p_seconds := null;
  end if;
  select coalesce(max(position), 0) + 1 into pos from public.pulse_items where event_id = e.id;
  insert into public.pulse_items(event_id, kind, question, options, correct, seconds, position)
    values (e.id, p_kind, trim(p_question), p_options, p_correct, p_seconds, pos) returning pulse_items.id into v_id;
  perform public.pulse__bump(e.id);
  return v_id;
end $$;

create or replace function public.pulse_delete_item(p_code text, p_key text, p_item uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare e public.pulse_events;
begin
  e := public.pulse__host(p_code, p_key);
  if e.active_item = p_item then update public.pulse_events set active_item = null where id = e.id; end if;
  delete from public.pulse_items where id = p_item and event_id = e.id;
  perform public.pulse__bump(e.id);
end $$;

-- put one item on the phones (or nothing, p_item null). The item shown before is closed.
create or replace function public.pulse_set_live(p_code text, p_key text, p_item uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare e public.pulse_events;
begin
  e := public.pulse__host(p_code, p_key);
  if p_item is not null and not exists (select 1 from public.pulse_items where id = p_item and event_id = e.id) then
    raise exception 'PULSE: that item is not in this event';
  end if;
  update public.pulse_items set state = 'closed' where event_id = e.id and state = 'live' and id is distinct from p_item;
  if p_item is not null then
    update public.pulse_items set state = 'live', opened_at = case when state = 'draft' or opened_at is null then now() else opened_at end
     where id = p_item and state <> 'live';
  end if;
  update public.pulse_events set active_item = p_item where id = e.id;
  perform public.pulse__bump(e.id);
end $$;

-- stop taking answers (a quiz then shows its right answer)
create or replace function public.pulse_close_item(p_code text, p_key text, p_item uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare e public.pulse_events;
begin
  e := public.pulse__host(p_code, p_key);
  update public.pulse_items set state = 'closed' where id = p_item and event_id = e.id;
  perform public.pulse__bump(e.id);
end $$;

create or replace function public.pulse_show_results(p_code text, p_key text, p_item uuid, p_show boolean) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare e public.pulse_events;
begin
  e := public.pulse__host(p_code, p_key);
  update public.pulse_items set show_results = p_show where id = p_item and event_id = e.id;
  perform public.pulse__bump(e.id);
end $$;

-- clear the answers of one item and make it new again (for a second run or a test)
create or replace function public.pulse_reset_item(p_code text, p_key text, p_item uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare e public.pulse_events;
begin
  e := public.pulse__host(p_code, p_key);
  delete from public.pulse_answers where item_id = p_item and event_id = e.id;
  update public.pulse_items set state = case when e.active_item = p_item then 'live' else 'draft' end,
         opened_at = case when e.active_item = p_item then now() else null end
   where id = p_item and event_id = e.id;
  perform public.pulse__bump(e.id);
end $$;

create or replace function public.pulse_qa_mod(p_code text, p_key text, p_question uuid, p_action text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare e public.pulse_events;
begin
  e := public.pulse__host(p_code, p_key);
  if p_action = 'answered' then update public.pulse_questions set answered = true where id = p_question and event_id = e.id;
  elsif p_action = 'unanswered' then update public.pulse_questions set answered = false where id = p_question and event_id = e.id;
  elsif p_action = 'hide' then update public.pulse_questions set hidden = true where id = p_question and event_id = e.id;
  elsif p_action = 'show' then update public.pulse_questions set hidden = false where id = p_question and event_id = e.id;
  elsif p_action = 'delete' then delete from public.pulse_questions where id = p_question and event_id = e.id;
  else raise exception 'PULSE: unknown Q&A action %', p_action; end if;
  perform public.pulse__bump(e.id);
end $$;

create or replace function public.pulse_set_event(p_code text, p_key text, p_title text default null,
                                                  p_qa_open boolean default null, p_closed boolean default null) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare e public.pulse_events;
begin
  e := public.pulse__host(p_code, p_key);
  update public.pulse_events set
    title   = coalesce(nullif(trim(p_title), ''), title),
    qa_open = coalesce(p_qa_open, qa_open),
    closed  = coalesce(p_closed, closed)
   where id = e.id;
  perform public.pulse__bump(e.id);
end $$;

-- everything the presenter screen shows, in one read
create or replace function public.pulse_host_state(p_code text, p_key text) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare e public.pulse_events; people int;
begin
  e := public.pulse__host(p_code, p_key);
  select count(*) into people from public.pulse_people where event_id = e.id;
  return jsonb_build_object(
    'now', now(),
    'event', jsonb_build_object('id', e.id, 'code', e.code, 'title', e.title, 'active_item', e.active_item,
                                'qa_open', e.qa_open, 'closed', e.closed, 'created_at', e.created_at),
    'rev', (select rev from public.pulse_ticks where event_id = e.id),
    'items', coalesce((select jsonb_agg(jsonb_build_object(
                 'id', i.id, 'kind', i.kind, 'question', i.question, 'options', i.options, 'correct', i.correct,
                 'seconds', i.seconds, 'state', i.state, 'show_results', i.show_results, 'opened_at', i.opened_at,
                 'position', i.position, 'results', public.pulse__results(i.id, true)) order by i.position)
               from public.pulse_items i where i.event_id = e.id), '[]'::jsonb),
    'questions', coalesce((select jsonb_agg(jsonb_build_object(
                 'id', q.id, 'body', q.body, 'author', coalesce(nullif(q.author, ''), 'Anonymous'), 'votes', q.votes,
                 'hidden', q.hidden, 'answered', q.answered, 'created_at', q.created_at) order by q.votes desc, q.created_at)
               from public.pulse_questions q where q.event_id = e.id), '[]'::jsonb),
    'leaderboard', public.pulse__leaderboard(e.id),
    'analytics', jsonb_build_object(
       'people', people,
       'answers', (select count(*) from public.pulse_answers where event_id = e.id),
       'responders', (select count(distinct pid) from public.pulse_answers where event_id = e.id),
       'questions', (select count(*) from public.pulse_questions where event_id = e.id),
       'askers', (select count(distinct pid) from public.pulse_questions where event_id = e.id),
       'upvotes', (select count(*) from public.pulse_qvotes v join public.pulse_questions q on q.id = v.question_id where q.event_id = e.id),
       'per_item', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'question', i.question, 'kind', i.kind,
                       'responses', (select count(*) from public.pulse_answers a where a.item_id = i.id)) order by i.position)
                     from public.pulse_items i where i.event_id = e.id), '[]'::jsonb))
  );
end $$;

-- ---------------------------------------------------------------- phones (participants)

create or replace function public.pulse_join(p_code text, p_pid uuid, p_nickname text default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare e public.pulse_events; nick text := nullif(left(trim(coalesce(p_nickname, '')), 40), '');
begin
  e := public.pulse__event(p_code);
  if e.closed then raise exception 'PULSE: event % has ended', e.code; end if;
  if p_pid is null then raise exception 'PULSE: no participant id'; end if;
  insert into public.pulse_people(event_id, pid, nickname) values (e.id, p_pid, nick)
  on conflict (event_id, pid) do update set nickname = coalesce(excluded.nickname, public.pulse_people.nickname);
  perform public.pulse__bump(e.id);
  return jsonb_build_object('event_id', e.id, 'code', e.code, 'title', e.title);
end $$;

create or replace function public.pulse_state(p_code text, p_pid uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare e public.pulse_events; it public.pulse_items; item jsonb := null; mine jsonb; lb jsonb; my_total int; my_rank int;
begin
  e := public.pulse__event(p_code);
  if e.active_item is not null then
    select * into it from public.pulse_items where id = e.active_item;
    if it.id is not null then
      select answer into mine from public.pulse_answers where item_id = it.id and pid = p_pid;
      item := jsonb_build_object(
        'id', it.id, 'kind', it.kind, 'question', it.question, 'options', it.options, 'seconds', it.seconds,
        'state', it.state, 'opened_at', it.opened_at, 'show_results', it.show_results,
        'correct', case when it.kind = 'quiz' and it.state = 'closed' then it.correct end,
        'my_answer', mine,
        'my_score', (select score from public.pulse_answers where item_id = it.id and pid = p_pid),
        'results', case when (it.kind <> 'quiz' and it.show_results) or it.state = 'closed'
                        then public.pulse__results(it.id, false) end);
    end if;
  end if;
  if exists (select 1 from public.pulse_items where event_id = e.id and kind = 'quiz' and state = 'closed') then
    lb := public.pulse__leaderboard(e.id);
    select sum(a.score)::int into my_total from public.pulse_answers a join public.pulse_items i on i.id = a.item_id and i.kind = 'quiz'
     where a.event_id = e.id and a.pid = p_pid;
    select r into my_rank from (select pid, rank() over (order by sum(score) desc) r from public.pulse_answers a
                                 join public.pulse_items i on i.id = a.item_id and i.kind = 'quiz'
                                 where a.event_id = e.id group by pid) t where t.pid = p_pid;
  end if;
  return jsonb_build_object(
    'now', now(),
    'event', jsonb_build_object('code', e.code, 'title', e.title, 'qa_open', e.qa_open, 'closed', e.closed),
    'rev', (select rev from public.pulse_ticks where event_id = e.id),
    'people', (select count(*) from public.pulse_people where event_id = e.id),
    'item', item,
    'questions', coalesce((select jsonb_agg(jsonb_build_object(
                    'id', q.id, 'body', q.body, 'author', coalesce(nullif(q.author, ''), 'Anonymous'), 'votes', q.votes,
                    'answered', q.answered, 'mine', q.pid = p_pid,
                    'voted', exists (select 1 from public.pulse_qvotes v where v.question_id = q.id and v.pid = p_pid))
                    order by q.answered, q.votes desc, q.created_at)
                  from (select * from public.pulse_questions where event_id = e.id and not hidden
                        order by votes desc, created_at limit 200) q), '[]'::jsonb),
    'leaderboard', lb,
    'my_total', my_total,
    'my_rank', my_rank
  );
end $$;

create or replace function public.pulse_answer(p_code text, p_pid uuid, p_item uuid, p_answer jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare e public.pulse_events; it public.pulse_items; ch int; n int; sc int := 0; elapsed numeric; words jsonb; q jsonb; i int; v jsonb; clean jsonb := '[]'::jsonb;
begin
  e := public.pulse__event(p_code);
  if e.closed then raise exception 'PULSE: event % has ended', e.code; end if;
  select * into it from public.pulse_items where id = p_item and event_id = e.id;
  if it.id is null or it.state <> 'live' or e.active_item is distinct from it.id then
    raise exception 'PULSE: this question is not open for answers now';
  end if;
  if not exists (select 1 from public.pulse_people where event_id = e.id and pid = p_pid) then
    insert into public.pulse_people(event_id, pid) values (e.id, p_pid) on conflict do nothing;
  end if;
  if it.kind in ('poll', 'quiz') then
    if jsonb_typeof(p_answer->'choice') <> 'number' then raise exception 'PULSE: pick one option'; end if;
    ch := (p_answer->>'choice')::int; n := jsonb_array_length(it.options);
    if ch < 0 or ch >= n then raise exception 'PULSE: that option does not exist'; end if;
    if it.kind = 'quiz' then
      elapsed := extract(epoch from now() - it.opened_at);
      if elapsed > it.seconds + 1.5 then raise exception 'PULSE: time is up for this question'; end if;
      if exists (select 1 from public.pulse_answers where item_id = it.id and pid = p_pid) then
        raise exception 'PULSE: you have already answered this quiz question';
      end if;
      if ch = it.correct then sc := 500 + round(500 * greatest(0, 1 - elapsed / it.seconds))::int; end if;
    end if;
    p_answer := jsonb_build_object('choice', ch);
  elsif it.kind = 'wordcloud' then
    if jsonb_typeof(p_answer->'words') = 'string' then
      words := (select coalesce(jsonb_agg(w), '[]'::jsonb) from (
                 select left(trim(x), 40) w from regexp_split_to_table(p_answer->>'words', ',') x where trim(x) <> '' limit 3) s);
    else
      words := (select coalesce(jsonb_agg(left(trim(x), 40)), '[]'::jsonb) from (
                 select x from jsonb_array_elements_text(coalesce(p_answer->'words', '[]'::jsonb)) x where trim(x) <> '' limit 3) s);
    end if;
    if jsonb_array_length(words) = 0 then raise exception 'PULSE: write at least one word'; end if;
    p_answer := jsonb_build_object('words', words);
  else -- survey
    if jsonb_typeof(p_answer->'answers') <> 'array' then raise exception 'PULSE: no survey answers'; end if;
    for i in 0 .. jsonb_array_length(it.options) - 1 loop
      q := it.options->i; v := p_answer->'answers'->i;
      if v is null or jsonb_typeof(v) = 'null' then clean := clean || jsonb_build_array(null::jsonb);
      elsif q->>'type' = 'choice' and jsonb_typeof(v) = 'number' and (v #>> '{}')::int between 0 and jsonb_array_length(q->'options') - 1 then
        clean := clean || jsonb_build_array(to_jsonb((v #>> '{}')::int));
      elsif q->>'type' = 'rating' and jsonb_typeof(v) = 'number' and (v #>> '{}')::int between 1 and 5 then
        clean := clean || jsonb_build_array(to_jsonb((v #>> '{}')::int));
      elsif q->>'type' = 'text' and jsonb_typeof(v) = 'string' then
        clean := clean || jsonb_build_array(to_jsonb(left(trim(v #>> '{}'), 500)));
      else clean := clean || jsonb_build_array(null::jsonb);
      end if;
    end loop;
    p_answer := jsonb_build_object('answers', clean);
  end if;
  insert into public.pulse_answers(item_id, pid, event_id, answer, score) values (it.id, p_pid, e.id, p_answer, sc)
  on conflict (item_id, pid) do update set answer = excluded.answer, at = now();
  perform public.pulse__bump(e.id);
  return jsonb_build_object('ok', true, 'answer', p_answer);
end $$;

create or replace function public.pulse_ask(p_code text, p_pid uuid, p_body text, p_author text default null) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare e public.pulse_events; v_id uuid;
begin
  e := public.pulse__event(p_code);
  if e.closed then raise exception 'PULSE: event % has ended', e.code; end if;
  if not e.qa_open then raise exception 'PULSE: questions are closed for now'; end if;
  if coalesce(trim(p_body), '') = '' or char_length(p_body) > 300 then raise exception 'PULSE: a question needs 1 to 300 letters'; end if;
  if (select count(*) from public.pulse_questions where event_id = e.id and pid = p_pid and created_at > now() - interval '10 minutes') >= 10 then
    raise exception 'PULSE: at most 10 questions in 10 minutes from one phone';
  end if;
  insert into public.pulse_people(event_id, pid) values (e.id, p_pid) on conflict do nothing;
  insert into public.pulse_questions(event_id, pid, body, author)
    values (e.id, p_pid, trim(p_body), nullif(left(trim(coalesce(p_author, '')), 40), '')) returning pulse_questions.id into v_id;
  perform public.pulse__bump(e.id);
  return v_id;
end $$;

-- one upvote per phone per question; a second press takes it back
create or replace function public.pulse_upvote(p_code text, p_pid uuid, p_question uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare e public.pulse_events; voted boolean; n int;
begin
  e := public.pulse__event(p_code);
  if not exists (select 1 from public.pulse_questions where id = p_question and event_id = e.id and not hidden) then
    raise exception 'PULSE: that question is not in this event';
  end if;
  if exists (select 1 from public.pulse_qvotes where question_id = p_question and pid = p_pid) then
    delete from public.pulse_qvotes where question_id = p_question and pid = p_pid; voted := false;
  else
    insert into public.pulse_qvotes(question_id, pid) values (p_question, p_pid); voted := true;
  end if;
  update public.pulse_questions set votes = (select count(*) from public.pulse_qvotes where question_id = p_question)
   where id = p_question returning votes into n;
  perform public.pulse__bump(e.id);
  return jsonb_build_object('voted', voted, 'votes', n);
end $$;

-- the release line's live check: answers without touching any event
create or replace function public.pulse_ping() returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select jsonb_build_object('ok', true, 'schema', 1, 'now', now())
$$;

-- ---------------------------------------------------------------- who may call what
revoke all on function public.pulse__hash(text), public.pulse__bump(uuid), public.pulse__event(text),
                       public.pulse__host(text, text), public.pulse__results(uuid, boolean), public.pulse__leaderboard(uuid)
  from public, anon, authenticated;
grant execute on function
  public.pulse_create_event(text), public.pulse_add_item(text, text, text, text, jsonb, int, int),
  public.pulse_delete_item(text, text, uuid), public.pulse_set_live(text, text, uuid), public.pulse_close_item(text, text, uuid),
  public.pulse_show_results(text, text, uuid, boolean), public.pulse_reset_item(text, text, uuid),
  public.pulse_qa_mod(text, text, uuid, text), public.pulse_set_event(text, text, text, boolean, boolean),
  public.pulse_host_state(text, text), public.pulse_join(text, uuid, text), public.pulse_state(text, uuid),
  public.pulse_answer(text, uuid, uuid, jsonb), public.pulse_ask(text, uuid, text, text), public.pulse_upvote(text, uuid, uuid),
  public.pulse_ping()
  to anon, authenticated;
