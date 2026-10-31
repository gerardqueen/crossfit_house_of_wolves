-- House of Wolves app: core schema, access rules and booking logic.
-- Run once on a fresh Supabase project (SQL editor or `supabase db push`), then run seed.sql.
-- All times are Europe/London local times stored as date + time.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- enums
do $$ begin
  create type member_role as enum ('member','coach','owner');
exception when duplicate_object then null; end $$;
do $$ begin
  create type member_status as enum ('lead','pending','active','frozen','past_due','cancelled');
exception when duplicate_object then null; end $$;
do $$ begin
  create type booking_status as enum ('booked','waitlist','cancelled','late_cancel','attended','no_show');
exception when duplicate_object then null; end $$;
do $$ begin
  create type og_status as enum ('booked','in','done','cancelled');
exception when duplicate_object then null; end $$;
do $$ begin
  create type prog_status as enum ('draft','scheduled','published');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------- settings (single row, readable by all signed-in users)
create table if not exists settings (
  id int primary key default 1 check (id = 1),
  gym_name text not null default 'House of Wolves',
  legal_name text not null default '[Gym legal entity name]',
  address text not null default 'Centrex House, Unit 2, Livingston, EH54 7BH',
  contact_email text not null default 'info@crossfithouseofwolves.com',
  ico_number text default '[ICO registration number]',
  accent text not null default '#f2f2f0',
  logo_url text,
  late_cancel_hours int not null default 2,
  book_ahead_days int not null default 7,
  og_capacity int not null default 10,
  auto_promote boolean not null default true,
  release_time time not null default '20:00',
  intro_remind_days int not null default 7,
  show_attendee_names boolean not null default true,
  door_mode text not null default 'booked_only' check (door_mode in ('booked_only','active_members','off')),
  door_provider text not null default 'none' check (door_provider in ('none','webhook','shelly_cloud','switchbot')),
  gym_lat double precision,
  gym_lng double precision,
  door_radius_m int not null default 150,
  app_url text,
  updated_at timestamptz not null default now()
);

-- private values only the service role can read (Stripe webhook secret, door secrets, provider config)
create table if not exists secrets (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- catalogue
create table if not exists plans (
  id text primary key,
  name text not null,
  description text not null default '',
  price_pence int not null,
  unit text not null default 'month',
  monthly boolean not null default true,
  per_week int,
  pack int,
  valid_days int,
  tracks text[] not null,
  open_gym boolean not null default false,
  intro_discount_pence int not null default 0,
  converts_to text references plans(id),
  active boolean not null default true,
  sort int not null default 0,
  stripe_product_id text,
  stripe_price_id text
);

create table if not exists class_types (
  id text primary key,
  name text not null,
  colour text not null default '#d9d9d6',
  track text not null,
  default_capacity int not null default 16
);

create table if not exists timetable (
  id uuid primary key default gen_random_uuid(),
  weekday int not null check (weekday between 0 and 6), -- 0 = Monday
  start_time time not null,
  minutes int not null default 60,
  type text not null references class_types(id),
  coach text not null default '',
  capacity int not null default 16,
  active boolean not null default true
);

create table if not exists class_overrides (
  class_date date not null,
  timetable_id uuid not null references timetable(id) on delete cascade,
  cancelled boolean not null default false,
  reason text,
  coach text,
  primary key (class_date, timetable_id)
);

create table if not exists kit (
  id text primary key,
  name text not null,
  qty int not null check (qty >= 0),
  sort int not null default 0
);

create table if not exists og_windows (
  id uuid primary key default gen_random_uuid(),
  weekday int not null check (weekday between 0 and 6),
  start_time time not null,
  end_time time not null check (end_time > start_time)
);

-- ---------------------------------------------------------------- people
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role member_role not null default 'member',
  status member_status not null default 'pending',
  first_name text not null default '',
  last_name text not null default '',
  email text not null default '',
  phone text not null default '',
  dob date,
  address text not null default '',
  postcode text not null default '',
  ec_name text not null default '',
  ec_relationship text not null default '',
  ec_phone text not null default '',
  injuries text not null default '',
  goals text not null default '',
  experience text not null default '',
  preferred_times text[] not null default '{}',
  heard_from text not null default '',
  parq jsonb not null default '{}'::jsonb,
  parq_flag boolean not null default false,
  waiver_signed_at timestamptz,
  waiver_signature text,
  waiver_version text,
  photo_consent boolean not null default false,
  marketing_consent boolean not null default false,
  plan_id text references plans(id),
  plan_started date,
  credits int not null default 0,
  credits_expire date,
  frozen_until date,
  stripe_customer_id text,
  stripe_subscription_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists staff_notes (
  member_id uuid primary key references profiles(id) on delete cascade,
  notes text not null default '',
  updated_at timestamptz not null default now()
);

create table if not exists consents (
  id bigint generated always as identity primary key,
  member_id uuid not null references profiles(id) on delete cascade,
  kind text not null, -- privacy, waiver, health_data, photo, marketing
  version text not null,
  granted boolean not null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- activity
create table if not exists bookings (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references profiles(id) on delete cascade,
  class_date date not null,
  timetable_id uuid not null references timetable(id) on delete cascade,
  status booking_status not null,
  used_credit boolean not null default false,
  checked_in_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists bookings_one_live on bookings(member_id, class_date, timetable_id)
  where status in ('booked','waitlist','attended');
create index if not exists bookings_class on bookings(class_date, timetable_id);

create table if not exists og_bookings (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references profiles(id) on delete cascade,
  og_date date not null,
  start_time time not null,
  minutes int not null check (minutes in (60,90,120)),
  focus text not null default '',
  plan_text text not null default '',
  kit jsonb not null default '{}'::jsonb,
  injury text not null default '',
  buddy text not null default '',
  safety_confirmed boolean not null default false,
  status og_status not null default 'booked',
  in_at timestamptz,
  out_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists og_date_idx on og_bookings(og_date);

create table if not exists programming (
  prog_date date not null,
  track text not null,
  status prog_status not null default 'draft',
  release_at timestamptz,
  sections jsonb not null default '[]'::jsonb,
  author uuid references profiles(id),
  updated_at timestamptz not null default now(),
  primary key (prog_date, track)
);

create table if not exists scores (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references profiles(id) on delete cascade,
  prog_date date not null,
  track text not null,
  section_id text not null,
  raw text not null,
  division text not null check (division in ('Rx','Scaled','Foundations')),
  note text not null default '',
  created_at timestamptz not null default now(),
  unique (member_id, prog_date, track, section_id)
);

create table if not exists high_fives (
  score_id uuid not null references scores(id) on delete cascade,
  member_id uuid not null references profiles(id) on delete cascade,
  primary key (score_id, member_id)
);

create table if not exists prs (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references profiles(id) on delete cascade,
  name text not null,
  kind text not null check (kind in ('load','time','rounds','reps')),
  value numeric not null,
  pr_date date not null default current_date,
  created_at timestamptz not null default now()
);

create table if not exists leads (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null default '',
  phone text not null default '',
  interest text not null default 'CrossFit',
  experience text not null default '',
  source text not null default '',
  status text not null default 'new' check (status in ('new','booked','attended','joined','lost')),
  class_date date,
  timetable_id uuid references timetable(id) on delete set null,
  consent boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists notifications (
  id bigint generated always as identity primary key,
  member_id uuid not null references profiles(id) on delete cascade,
  body text not null,
  read boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists payments (
  id bigint generated always as identity primary key,
  member_id uuid references profiles(id) on delete set null,
  amount_pence int not null,
  description text not null,
  stripe_object text unique,
  status text not null,
  created_at timestamptz not null default now()
);

create table if not exists access_log (
  id bigint generated always as identity primary key,
  member_id uuid references profiles(id) on delete set null,
  allowed boolean not null,
  reason text not null,
  method text not null, -- qr, app, staff
  created_at timestamptz not null default now()
);

create table if not exists activity_log (
  id bigint generated always as identity primary key,
  actor uuid,
  body text not null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- helpers
create or replace function is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and role in ('coach','owner'));
$$;

create or replace function is_owner() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'owner');
$$;

create or replace function local_now() returns timestamp
language sql stable as $$ select (now() at time zone 'Europe/London'); $$;

create or replace function class_start(p_date date, p_tt uuid) returns timestamp
language sql stable as $$ select p_date + start_time from timetable where id = p_tt; $$;

create or replace function log_activity(p_body text) returns void
language sql security definer set search_path = public as $$
  insert into activity_log(actor, body) values (auth.uid(), p_body);
$$;

create or replace function notify_member(p_member uuid, p_body text) returns void
language sql security definer set search_path = public as $$
  insert into notifications(member_id, body) values (p_member, p_body);
$$;

-- classes counted against a weekly limit: booked, attended, no-show and late cancels in the Mon-Sun week
create or replace function week_used(p_member uuid, p_date date, p_exclude uuid default null) returns int
language sql stable security definer set search_path = public as $$
  select count(*)::int from bookings
  where member_id = p_member
    and class_date between date_trunc('week', p_date)::date and date_trunc('week', p_date)::date + 6
    and status in ('booked','attended','no_show','late_cancel')
    and (p_exclude is null or timetable_id <> p_exclude or class_date <> p_date);
$$;

-- why a member can or can't book a class; null = allowed
create or replace function booking_block_reason(p_member uuid, p_date date, p_tt uuid) returns text
language plpgsql stable security definer set search_path = public as $$
declare
  m profiles; p plans; t timetable; o class_overrides; s settings;
begin
  select * into m from profiles where id = p_member;
  select * into t from timetable where id = p_tt;
  select * into s from settings where id = 1;
  select * into o from class_overrides where class_date = p_date and timetable_id = p_tt;
  if t.id is null or not t.active or extract(isodow from p_date)::int - 1 <> t.weekday then return 'Class not found'; end if;
  if o.cancelled then return 'Class cancelled'; end if;
  if p_date + t.start_time < local_now() then return 'Class has started'; end if;
  if p_date > (local_now())::date + s.book_ahead_days then return 'Booking not open yet'; end if;
  if m.status = 'frozen' then return 'Membership frozen'; end if;
  if m.status = 'past_due' then return 'Payment overdue'; end if;
  if m.status <> 'active' then return 'No active membership'; end if;
  select * into p from plans where id = m.plan_id;
  if p.id is null then return 'No membership plan'; end if;
  if not (t.type = any(p.tracks)) then return 'Not on your plan'; end if;
  if p.pack is not null then
    if m.credits <= 0 then return 'No credits left'; end if;
    if m.credits_expire is not null and m.credits_expire < p_date then return 'Credits expire first'; end if;
  end if;
  if p.per_week is not null and week_used(p_member, p_date, p_tt) >= p.per_week then
    return p.per_week || ' a week used';
  end if;
  return null;
end $$;

-- ---------------------------------------------------------------- booking RPCs
create or replace function book_class(p_date date, p_tt uuid) returns text
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid(); reason text; cap int; taken int; p plans; m profiles; t timetable;
begin
  if me is null then raise exception 'Not signed in'; end if;
  -- serialise bookings per class so two people can't take the last space
  perform pg_advisory_xact_lock(hashtext(p_date::text || p_tt::text));
  if exists (select 1 from bookings where member_id = me and class_date = p_date and timetable_id = p_tt and status in ('booked','waitlist')) then
    return 'already';
  end if;
  reason := booking_block_reason(me, p_date, p_tt);
  if reason is not null then raise exception '%', reason; end if;
  select * into t from timetable where id = p_tt;
  select * into m from profiles where id = me;
  select * into p from plans where id = m.plan_id;
  cap := t.capacity;
  select count(*) into taken from bookings where class_date = p_date and timetable_id = p_tt and status in ('booked','attended');
  if taken >= cap then
    insert into bookings(member_id, class_date, timetable_id, status) values (me, p_date, p_tt, 'waitlist');
    return 'waitlist';
  end if;
  insert into bookings(member_id, class_date, timetable_id, status, used_credit)
    values (me, p_date, p_tt, 'booked', p.pack is not null);
  if p.pack is not null then update profiles set credits = credits - 1 where id = me; end if;
  return 'booked';
end $$;

create or replace function promote_waitlist(p_date date, p_tt uuid) returns int
language plpgsql security definer set search_path = public as $$
declare
  cap int; taken int; w record; moved int := 0; p plans; reason text; t timetable;
begin
  if not (select auto_promote from settings where id = 1) then return 0; end if;
  select * into t from timetable where id = p_tt;
  cap := t.capacity;
  for w in select * from bookings where class_date = p_date and timetable_id = p_tt and status = 'waitlist' order by created_at loop
    select count(*) into taken from bookings where class_date = p_date and timetable_id = p_tt and status in ('booked','attended');
    exit when taken >= cap;
    reason := booking_block_reason(w.member_id, p_date, p_tt);
    if reason is not null then
      update bookings set status = 'cancelled', updated_at = now() where id = w.id;
      perform notify_member(w.member_id, 'A space opened in ' || to_char(p_date, 'Dy DD Mon') || ' ' || to_char(t.start_time, 'HH24:MI') || ' but you could not be booked: ' || reason);
      continue;
    end if;
    select pl.* into p from plans pl join profiles pr on pr.plan_id = pl.id where pr.id = w.member_id;
    update bookings set status = 'booked', used_credit = (p.pack is not null), updated_at = now() where id = w.id;
    if p.pack is not null then update profiles set credits = credits - 1 where id = w.member_id; end if;
    perform notify_member(w.member_id, 'You''re in! Moved off the waitlist for ' || to_char(p_date, 'Dy DD Mon') || ' ' || to_char(t.start_time, 'HH24:MI') || '.');
    moved := moved + 1;
  end loop;
  return moved;
end $$;

create or replace function cancel_booking(p_booking uuid) returns text
language plpgsql security definer set search_path = public as $$
declare
  b bookings; late boolean; hrs numeric; staff boolean := is_staff();
begin
  select * into b from bookings where id = p_booking for update;
  if b.id is null then raise exception 'Booking not found'; end if;
  if b.member_id <> auth.uid() and not staff then raise exception 'Not your booking'; end if;
  if b.status = 'waitlist' then
    update bookings set status = 'cancelled', updated_at = now() where id = b.id;
    return 'left_waitlist';
  end if;
  if b.status <> 'booked' then raise exception 'Booking can''t be cancelled'; end if;
  hrs := extract(epoch from (class_start(b.class_date, b.timetable_id) - local_now())) / 3600;
  late := (not staff) and hrs < (select late_cancel_hours from settings where id = 1);
  update bookings set status = case when late then 'late_cancel'::booking_status else 'cancelled'::booking_status end, updated_at = now() where id = b.id;
  if b.used_credit and not late then update profiles set credits = credits + 1 where id = b.member_id; end if;
  perform promote_waitlist(b.class_date, b.timetable_id);
  return case when late then 'late_cancel' else 'cancelled' end;
end $$;

create or replace function check_in(p_booking uuid) returns void
language plpgsql security definer set search_path = public as $$
declare b bookings; mins numeric;
begin
  select * into b from bookings where id = p_booking;
  if b.id is null then raise exception 'Booking not found'; end if;
  if not is_staff() then
    if b.member_id <> auth.uid() then raise exception 'Not your booking'; end if;
    mins := extract(epoch from (class_start(b.class_date, b.timetable_id) - local_now())) / 60;
    if mins > 30 or mins < -15 then raise exception 'Check-in opens 30 minutes before class'; end if;
  end if;
  if b.status not in ('booked','no_show') then raise exception 'Not booked'; end if;
  update bookings set status = 'attended', checked_in_at = now(), updated_at = now() where id = b.id;
end $$;

-- staff tools
create or replace function staff_set_attendance(p_booking uuid, p_attended boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_staff() then raise exception 'Staff only'; end if;
  update bookings set status = case when p_attended then 'attended'::booking_status else 'booked'::booking_status end,
    checked_in_at = case when p_attended then now() else null end, updated_at = now()
  where id = p_booking and status in ('booked','attended','no_show');
end $$;

create or replace function staff_add_booking(p_member uuid, p_date date, p_tt uuid) returns void
language plpgsql security definer set search_path = public as $$
declare p plans;
begin
  if not is_staff() then raise exception 'Staff only'; end if;
  select pl.* into p from plans pl join profiles pr on pr.plan_id = pl.id where pr.id = p_member;
  update bookings set status = 'booked', updated_at = now() where member_id = p_member and class_date = p_date and timetable_id = p_tt and status = 'waitlist';
  if not found then
    insert into bookings(member_id, class_date, timetable_id, status, used_credit) values (p_member, p_date, p_tt, 'booked', p.pack is not null)
    on conflict do nothing;
    if p.pack is not null then update profiles set credits = greatest(credits - 1, 0) where id = p_member; end if;
  end if;
  perform notify_member(p_member, 'A coach booked you into ' || to_char(p_date, 'Dy DD Mon') || '.');
end $$;

create or replace function staff_cancel_class(p_date date, p_tt uuid, p_reason text) returns int
language plpgsql security definer set search_path = public as $$
declare b record; n int := 0;
begin
  if not is_staff() then raise exception 'Staff only'; end if;
  insert into class_overrides(class_date, timetable_id, cancelled, reason) values (p_date, p_tt, true, p_reason)
    on conflict (class_date, timetable_id) do update set cancelled = true, reason = excluded.reason;
  for b in select * from bookings where class_date = p_date and timetable_id = p_tt and status in ('booked','waitlist') loop
    update bookings set status = 'cancelled', updated_at = now() where id = b.id;
    if b.used_credit then update profiles set credits = credits + 1 where id = b.member_id; end if;
    perform notify_member(b.member_id, 'Class cancelled ' || to_char(p_date, 'Dy DD Mon') || ': ' || p_reason);
    n := n + 1;
  end loop;
  perform log_activity('Cancelled class ' || p_date || ', ' || n || ' notified');
  return n;
end $$;

-- public class summary: counts (and first names if the gym allows) for a date range
create or replace function class_summary(p_from date, p_to date)
returns table(class_date date, timetable_id uuid, booked int, waitlist int, names text[], my_booking uuid, my_status booking_status, my_position int)
language sql stable security definer set search_path = public as $$
  with days as (select d::date as class_date from generate_series(p_from, p_to, interval '1 day') d),
  inst as (
    select days.class_date, t.id as timetable_id from days join timetable t
      on t.weekday = extract(isodow from days.class_date)::int - 1 and t.active
  )
  select i.class_date, i.timetable_id,
    (select count(*)::int from bookings b where b.class_date = i.class_date and b.timetable_id = i.timetable_id and b.status in ('booked','attended')),
    (select count(*)::int from bookings b where b.class_date = i.class_date and b.timetable_id = i.timetable_id and b.status = 'waitlist'),
    case when (select show_attendee_names from settings where id = 1) or is_staff() then
      (select coalesce(array_agg(p.first_name order by b.created_at), '{}') from bookings b join profiles p on p.id = b.member_id
        where b.class_date = i.class_date and b.timetable_id = i.timetable_id and b.status in ('booked','attended'))
    else '{}'::text[] end,
    mb.id, mb.status,
    case when mb.status = 'waitlist' then (select count(*)::int + 1 from bookings w where w.class_date = i.class_date and w.timetable_id = i.timetable_id and w.status = 'waitlist' and w.created_at < mb.created_at) end
  from inst i
  left join lateral (select * from bookings b where b.class_date = i.class_date and b.timetable_id = i.timetable_id and b.member_id = auth.uid()
    and b.status in ('booked','waitlist','attended','late_cancel') order by b.created_at desc limit 1) mb on true
  order by i.class_date;
$$;

-- ---------------------------------------------------------------- open gym
create or replace function og_load(p_date date, p_start time, p_minutes int, p_exclude uuid default null)
returns table(people int, kit jsonb)
language plpgsql stable security definer set search_path = public as $$
declare
  t time; best_people int := 0; k jsonb := '{}'::jsonb; slice_people int; key text; val int;
begin
  t := p_start;
  while t < p_start + make_interval(mins => p_minutes) loop
    select count(*)::int into slice_people from og_bookings o
      where o.og_date = p_date and o.status in ('booked','in') and (p_exclude is null or o.id <> p_exclude)
        and o.start_time <= t and t < o.start_time + make_interval(mins => o.minutes);
    best_people := greatest(best_people, slice_people);
    for key, val in
      select e.key, sum((e.value)::int)::int from og_bookings o, jsonb_each_text(o.kit) e
      where o.og_date = p_date and o.status in ('booked','in') and (p_exclude is null or o.id <> p_exclude)
        and o.start_time <= t and t < o.start_time + make_interval(mins => o.minutes)
      group by e.key
    loop
      if coalesce((k ->> key)::int, 0) < val then k := k || jsonb_build_object(key, val); end if;
    end loop;
    t := t + interval '30 minutes';
  end loop;
  return query select best_people, k;
end $$;

create or replace function book_open_gym(p_date date, p_start time, p_minutes int, p_focus text, p_plan text,
  p_kit jsonb, p_injury text, p_buddy text, p_safety boolean, p_edit uuid default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid(); m profiles; p plans; s settings; ld record; k record; id_out uuid; fits boolean;
begin
  if me is null then raise exception 'Not signed in'; end if;
  if not p_safety then raise exception 'Please confirm the safety checks'; end if;
  select * into m from profiles where id = me;
  select * into p from plans where id = m.plan_id;
  select * into s from settings where id = 1;
  if m.status <> 'active' then raise exception 'No active membership'; end if;
  if not coalesce(p.open_gym, false) then raise exception 'Open Gym is not on your plan'; end if;
  if p_date + p_start + make_interval(mins => p_minutes) <= local_now() then raise exception 'That time has passed'; end if;
  select exists (select 1 from og_windows w where w.weekday = extract(isodow from p_date)::int - 1
    and w.start_time <= p_start and p_start + make_interval(mins => p_minutes) <= w.end_time) into fits;
  if not fits then raise exception 'Outside Open Gym hours'; end if;
  perform pg_advisory_xact_lock(hashtext('og' || p_date::text));
  select * into ld from og_load(p_date, p_start, p_minutes, p_edit);
  if ld.people >= s.og_capacity then raise exception 'That slot is full'; end if;
  for k in select kt.id, kt.name, kt.qty from kit kt loop
    if coalesce((p_kit ->> k.id)::int, 0) > k.qty - coalesce((ld.kit ->> k.id)::int, 0) then
      raise exception 'Not enough % free for that slot', k.name;
    end if;
  end loop;
  if p_edit is not null then
    update og_bookings set og_date = p_date, start_time = p_start, minutes = p_minutes, focus = p_focus, plan_text = p_plan,
      kit = p_kit, injury = p_injury, buddy = p_buddy, safety_confirmed = true
    where id = p_edit and member_id = me and status = 'booked' returning id into id_out;
    if id_out is null then raise exception 'Booking not found'; end if;
  else
    if exists (select 1 from og_bookings where member_id = me and og_date = p_date and status = 'booked') then
      raise exception 'You already have Open Gym booked that day';
    end if;
    insert into og_bookings(member_id, og_date, start_time, minutes, focus, plan_text, kit, injury, buddy, safety_confirmed)
      values (me, p_date, p_start, p_minutes, p_focus, p_plan, p_kit, p_injury, p_buddy, true) returning id into id_out;
  end if;
  return id_out;
end $$;

create or replace function og_set_status(p_id uuid, p_status og_status) returns void
language plpgsql security definer set search_path = public as $$
declare o og_bookings;
begin
  select * into o from og_bookings where id = p_id;
  if o.id is null then raise exception 'Booking not found'; end if;
  if o.member_id <> auth.uid() and not is_staff() then raise exception 'Not your booking'; end if;
  update og_bookings set status = p_status,
    in_at = case when p_status = 'in' then now() else in_at end,
    out_at = case when p_status = 'done' then now() else out_at end
  where id = p_id;
end $$;

-- open gym occupancy for members (no names, no details)
create or replace function og_day_load(p_date date) returns table(slot time, people int)
language sql stable security definer set search_path = public as $$
  select w.slot::time, (select count(*)::int from og_bookings o where o.og_date = p_date and o.status in ('booked','in')
    and o.start_time <= w.slot::time and w.slot::time < o.start_time + make_interval(mins => o.minutes))
  from (select generate_series(p_date + start_time, p_date + end_time - interval '30 minutes', interval '30 minutes') as slot
        from og_windows where weekday = extract(isodow from p_date)::int - 1) w order by 1;
$$;


-- other members' Open Gym bookings without names, so the app can show free spaces and kit
create or replace function og_anon(p_from date, p_to date)
returns table(id uuid, og_date date, start_time time, minutes int, kit jsonb, status og_status, mine boolean)
language sql stable security definer set search_path = public as $$
  select o.id, o.og_date, o.start_time, o.minutes, o.kit, o.status, o.member_id = auth.uid()
  from og_bookings o where o.og_date between p_from and p_to and o.status in ('booked','in');
$$;

-- ---------------------------------------------------------------- programming visible to members (coach notes removed)
create or replace view programming_public with (security_invoker = false) as
  select prog_date, track, release_at,
    (select coalesce(jsonb_agg(s - 'notes'), '[]'::jsonb) from jsonb_array_elements(sections) s) as sections
  from programming
  where status = 'published' or (status = 'scheduled' and release_at <= now());

-- leaderboard rows with display names only
create or replace view leaderboard as
  select s.id, s.prog_date, s.track, s.section_id, s.raw, s.division, s.note, s.member_id,
    p.first_name || ' ' || left(p.last_name, 1) as display_name,
    (select count(*)::int from high_fives h where h.score_id = s.id) as high_fives,
    exists (select 1 from high_fives h where h.score_id = s.id and h.member_id = auth.uid()) as i_high_fived
  from scores s join profiles p on p.id = s.member_id;

-- ---------------------------------------------------------------- freeze, profile safety
create or replace function request_freeze(p_until date, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); b record;
begin
  if p_until < current_date + 7 or p_until > current_date + 92 then raise exception 'Freeze must be 7 to 92 days'; end if;
  update profiles set status = 'frozen', frozen_until = p_until where id = me and status = 'active';
  if not found then raise exception 'Only active memberships can be frozen'; end if;
  for b in select * from bookings where member_id = me and class_date between current_date and p_until and status in ('booked','waitlist') loop
    update bookings set status = 'cancelled' where id = b.id;
    if b.used_credit then update profiles set credits = credits + 1 where id = me; end if;
    perform promote_waitlist(b.class_date, b.timetable_id);
  end loop;
  perform log_activity('Freeze until ' || p_until || ' (' || p_reason || ')');
end $$;

-- members can't change their own role, status, plan, credits or Stripe ids.
-- Runs as the caller: direct edits from the app run as 'authenticated'; the booking functions and edge functions run as the owner.
create or replace function protect_profile() returns trigger
language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  if current_user not in ('authenticated','anon') or is_owner() then return new; end if;
  if is_staff() then
    if new.role is distinct from old.role then raise exception 'Only the owner can change roles'; end if;
    return new;
  end if;
  if new.role is distinct from old.role or new.status is distinct from old.status or new.plan_id is distinct from old.plan_id
     or new.credits is distinct from old.credits or new.credits_expire is distinct from old.credits_expire
     or new.stripe_customer_id is distinct from old.stripe_customer_id or new.stripe_subscription_id is distinct from old.stripe_subscription_id
     or new.frozen_until is distinct from old.frozen_until or new.plan_started is distinct from old.plan_started then
    raise exception 'Not allowed';
  end if;
  return new;
end $$;
drop trigger if exists profiles_protect on profiles;
create trigger profiles_protect before update on profiles for each row execute function protect_profile();

-- new auth user -> profile row. The join form sends its answers as sign-up metadata, so they are saved even when
-- email confirmation is switched on. Only safe fields are copied: never role, status, plan or credits.
create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare md jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb); signed boolean := coalesce((md ->> 'waiver_signed')::boolean, false);
begin
  insert into profiles(id, email, first_name, last_name, phone, dob, address, postcode, ec_name, ec_relationship, ec_phone,
    injuries, goals, experience, preferred_times, heard_from, parq, parq_flag, waiver_signed_at, waiver_signature, waiver_version,
    photo_consent, marketing_consent)
  values (new.id, coalesce(new.email, ''), coalesce(md ->> 'first_name', ''), coalesce(md ->> 'last_name', ''),
    coalesce(md ->> 'phone', ''), nullif(md ->> 'dob', '')::date, coalesce(md ->> 'address', ''), coalesce(md ->> 'postcode', ''),
    coalesce(md ->> 'ec_name', ''), coalesce(md ->> 'ec_relationship', ''), coalesce(md ->> 'ec_phone', ''),
    coalesce(md ->> 'injuries', ''), coalesce(md ->> 'goals', ''), coalesce(md ->> 'experience', ''),
    coalesce(array(select jsonb_array_elements_text(coalesce(md -> 'preferred_times', '[]'::jsonb))), '{}'),
    coalesce(md ->> 'heard_from', ''), coalesce(md -> 'parq', '{}'::jsonb), coalesce((md ->> 'parq_flag')::boolean, false),
    case when signed then now() end, case when signed then md ->> 'waiver_signature' end, case when signed then md ->> 'waiver_version' end,
    coalesce((md ->> 'photo_consent')::boolean, false), coalesce((md ->> 'marketing_consent')::boolean, false))
  on conflict (id) do nothing;
  if signed then
    insert into consents(member_id, kind, version, granted) values
      (new.id, 'privacy', coalesce(md ->> 'waiver_version', ''), true),
      (new.id, 'waiver', coalesce(md ->> 'waiver_version', ''), true),
      (new.id, 'health_data', coalesce(md ->> 'waiver_version', ''), true),
      (new.id, 'photo', coalesce(md ->> 'waiver_version', ''), coalesce((md ->> 'photo_consent')::boolean, false)),
      (new.id, 'marketing', coalesce(md ->> 'waiver_version', ''), coalesce((md ->> 'marketing_consent')::boolean, false));
  end if;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function handle_new_user();

-- daily housekeeping: unfreeze, mark no-shows, expire credits, retention
create or replace function daily_housekeeping() returns void
language plpgsql security definer set search_path = public as $$
begin
  update profiles set status = 'active', frozen_until = null where status = 'frozen' and frozen_until < current_date;
  update bookings set status = 'no_show' where status = 'booked' and class_date < current_date;
  update profiles set credits = 0 where credits > 0 and credits_expire < current_date;
  -- intro month moves to its follow-on plan after 30 days (Stripe keeps billing the same subscription)
  update profiles pr set plan_id = p.converts_to from plans p
    where pr.plan_id = p.id and p.converts_to is not null and pr.plan_started <= current_date - 30;
  delete from access_log where created_at < now() - interval '90 days';
  delete from notifications where created_at < now() - interval '180 days';
  delete from leads where status in ('new','lost','attended') and created_at < now() - interval '12 months';
  -- health answers removed 12 months after a membership is cancelled
  update profiles set parq = '{}'::jsonb, injuries = '', parq_flag = false
    where status = 'cancelled' and updated_at < now() - interval '12 months';
end $$;


-- ---------------------------------------------------------------- door buzzer (called by the door-access edge function only)
-- booked_only: from 30 min before a class to 15 min after it starts, or 15 min before an Open Gym slot until it ends;
-- buzzing in also checks the member in.
-- active_members: any active member. off: nobody but staff.
create or replace function door_check(p_member uuid, p_method text default 'app')
returns table(allowed boolean, reason text, display_name text)
language plpgsql security definer set search_path = public as $$
declare m profiles; s settings; b record; o record; nm text; now_l timestamp := local_now();
begin
  select * into m from profiles where id = p_member;
  select * into s from settings where id = 1;
  if m.id is null then
    insert into access_log(member_id, allowed, reason, method) values (null, false, 'Unknown member', p_method);
    return query select false, 'Unknown member', ''::text; return;
  end if;
  nm := trim(m.first_name || ' ' || m.last_name);
  if m.role in ('coach','owner') then
    insert into access_log(member_id, allowed, reason, method) values (m.id, true, 'Staff', p_method);
    return query select true, 'Staff', nm; return;
  end if;
  if s.door_mode = 'off' then
    insert into access_log(member_id, allowed, reason, method) values (m.id, false, 'Door access off', p_method);
    return query select false, 'Door access is switched off', nm; return;
  end if;
  if m.status <> 'active' then
    insert into access_log(member_id, allowed, reason, method) values (m.id, false, 'Membership ' || m.status, p_method);
    return query select false, 'Membership is ' || m.status::text, nm; return;
  end if;
  if s.door_mode = 'active_members' then
    insert into access_log(member_id, allowed, reason, method) values (m.id, true, 'Active member', p_method);
    return query select true, 'Active member', nm; return;
  end if;
  select bk.* into b from bookings bk join timetable t on t.id = bk.timetable_id
    where bk.member_id = m.id and bk.class_date = now_l::date and bk.status in ('booked','attended')
      and now_l between bk.class_date + t.start_time - interval '30 minutes' and bk.class_date + t.start_time + interval '15 minutes'
    limit 1;
  if b.id is not null then
    update bookings set status = 'attended', checked_in_at = coalesce(checked_in_at, now()) where id = b.id;
    insert into access_log(member_id, allowed, reason, method) values (m.id, true, 'Class booking', p_method);
    return query select true, 'Class booking', nm; return;
  end if;
  select og.* into o from og_bookings og
    where og.member_id = m.id and og.og_date = now_l::date and og.status in ('booked','in')
      and now_l between og.og_date + og.start_time - interval '15 minutes' and og.og_date + og.start_time + make_interval(mins => og.minutes)
    limit 1;
  if o.id is not null then
    update og_bookings set status = 'in', in_at = coalesce(in_at, now()) where id = o.id;
    insert into access_log(member_id, allowed, reason, method) values (m.id, true, 'Open Gym booking', p_method);
    return query select true, 'Open Gym booking', nm; return;
  end if;
  insert into access_log(member_id, allowed, reason, method) values (m.id, false, 'No booking now', p_method);
  return query select false, 'No class or Open Gym booking right now', nm;
end $$;
revoke all on function door_check from public, anon, authenticated;

-- ---------------------------------------------------------------- row level security
alter table settings enable row level security;
alter table secrets enable row level security;
alter table plans enable row level security;
alter table class_types enable row level security;
alter table timetable enable row level security;
alter table class_overrides enable row level security;
alter table kit enable row level security;
alter table og_windows enable row level security;
alter table profiles enable row level security;
alter table staff_notes enable row level security;
alter table consents enable row level security;
alter table bookings enable row level security;
alter table og_bookings enable row level security;
alter table programming enable row level security;
alter table scores enable row level security;
alter table high_fives enable row level security;
alter table prs enable row level security;
alter table leads enable row level security;
alter table notifications enable row level security;
alter table payments enable row level security;
alter table access_log enable row level security;
alter table activity_log enable row level security;
-- secrets: no policies at all, so only the service role (edge functions) can read or write

-- public catalogue: anyone can read (the join page needs plans before sign-up)
drop policy if exists r_settings on settings; create policy r_settings on settings for select using (true);
drop policy if exists w_settings on settings; create policy w_settings on settings for update using (is_owner()) with check (is_owner());
drop policy if exists r_plans on plans; create policy r_plans on plans for select using (true);
drop policy if exists w_plans on plans; create policy w_plans on plans for all using (is_owner()) with check (is_owner());
drop policy if exists r_types on class_types; create policy r_types on class_types for select using (true);
drop policy if exists w_types on class_types; create policy w_types on class_types for all using (is_staff()) with check (is_staff());
drop policy if exists r_tt on timetable; create policy r_tt on timetable for select using (true);
drop policy if exists w_tt on timetable; create policy w_tt on timetable for all using (is_staff()) with check (is_staff());
drop policy if exists r_ov on class_overrides; create policy r_ov on class_overrides for select using (true);
drop policy if exists w_ov on class_overrides; create policy w_ov on class_overrides for all using (is_staff()) with check (is_staff());
drop policy if exists r_kit on kit; create policy r_kit on kit for select using (true);
drop policy if exists w_kit on kit; create policy w_kit on kit for all using (is_staff()) with check (is_staff());
drop policy if exists r_ogw on og_windows; create policy r_ogw on og_windows for select using (true);
drop policy if exists w_ogw on og_windows; create policy w_ogw on og_windows for all using (is_staff()) with check (is_staff());

-- people
drop policy if exists r_profiles on profiles; create policy r_profiles on profiles for select using (id = auth.uid() or is_staff());
drop policy if exists u_profiles on profiles; create policy u_profiles on profiles for update using (id = auth.uid() or is_staff()) with check (id = auth.uid() or is_staff());
drop policy if exists a_notes on staff_notes; create policy a_notes on staff_notes for all using (is_staff()) with check (is_staff());
drop policy if exists r_consents on consents; create policy r_consents on consents for select using (member_id = auth.uid() or is_staff());
drop policy if exists i_consents on consents; create policy i_consents on consents for insert with check (member_id = auth.uid());

-- activity (writes go through the functions above)
drop policy if exists r_bookings on bookings; create policy r_bookings on bookings for select using (member_id = auth.uid() or is_staff());
drop policy if exists r_og on og_bookings; create policy r_og on og_bookings for select using (member_id = auth.uid() or is_staff());
drop policy if exists a_prog on programming; create policy a_prog on programming for all using (is_staff()) with check (is_staff());
drop policy if exists r_scores on scores; create policy r_scores on scores for select using (auth.uid() is not null);
drop policy if exists w_scores on scores; create policy w_scores on scores for insert with check (member_id = auth.uid());
drop policy if exists u_scores on scores; create policy u_scores on scores for update using (member_id = auth.uid()) with check (member_id = auth.uid());
drop policy if exists d_scores on scores; create policy d_scores on scores for delete using (member_id = auth.uid() or is_staff());
drop policy if exists r_hf on high_fives; create policy r_hf on high_fives for select using (auth.uid() is not null);
drop policy if exists i_hf on high_fives; create policy i_hf on high_fives for insert with check (member_id = auth.uid());
drop policy if exists d_hf on high_fives; create policy d_hf on high_fives for delete using (member_id = auth.uid());
drop policy if exists a_prs on prs; create policy a_prs on prs for all using (member_id = auth.uid() or is_staff()) with check (member_id = auth.uid() or is_staff());
drop policy if exists a_leads on leads; create policy a_leads on leads for all using (is_staff()) with check (is_staff());
drop policy if exists r_notif on notifications; create policy r_notif on notifications for select using (member_id = auth.uid());
drop policy if exists u_notif on notifications; create policy u_notif on notifications for update using (member_id = auth.uid()) with check (member_id = auth.uid());
drop policy if exists i_notif on notifications; create policy i_notif on notifications for insert with check (is_staff());
drop policy if exists r_pay on payments; create policy r_pay on payments for select using (member_id = auth.uid() or is_staff());
drop policy if exists r_access on access_log; create policy r_access on access_log for select using (is_staff());
drop policy if exists r_act on activity_log; create policy r_act on activity_log for select using (is_staff());

-- public taster sign-up (no account needed)
create or replace function submit_taster(p_name text, p_email text, p_phone text, p_interest text, p_experience text,
  p_class_date date, p_tt uuid, p_consent boolean) returns uuid
language plpgsql security definer set search_path = public as $$
declare id_out uuid;
begin
  if not p_consent then raise exception 'Consent is required'; end if;
  if length(coalesce(p_name,'')) < 2 or length(coalesce(p_email,'')) < 5 then raise exception 'Name and email are required'; end if;
  insert into leads(name, email, phone, interest, experience, source, status, class_date, timetable_id, consent)
  values (p_name, p_email, p_phone, p_interest, p_experience, 'App', case when p_class_date is null then 'new' else 'booked' end, p_class_date, p_tt, true)
  returning id into id_out;
  return id_out;
end $$;

-- function permissions: signed-in users for member actions, anon only for taster + catalogue reads
revoke all on function book_class, cancel_booking, check_in, book_open_gym, og_set_status, request_freeze, class_summary, og_day_load, og_anon,
  staff_set_attendance, staff_add_booking, staff_cancel_class, promote_waitlist, daily_housekeeping, og_load, booking_block_reason, week_used,
  notify_member, log_activity, submit_taster from public, anon, authenticated;
grant execute on function book_class, cancel_booking, check_in, book_open_gym, og_set_status, request_freeze, class_summary, og_day_load, og_anon,
  staff_set_attendance, staff_add_booking, staff_cancel_class to authenticated;
grant execute on function submit_taster to anon, authenticated;
grant select on programming_public, leaderboard to authenticated;
revoke all on programming_public, leaderboard from anon;
