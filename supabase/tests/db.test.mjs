// Database rule tests. Run: npm i @electric-sql/pglite@0.2 && node supabase/tests/db.test.mjs
import { PGlite } from '@electric-sql/pglite';

import fs from 'fs';

const db = new PGlite();
const repo = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const q = async (s, p) => (await db.query(s, p)).rows;
const asUser = async (uid) => { await db.exec(`select set_config('request.jwt.claim.sub', '${uid}', false); set role authenticated;`); };
const asSuper = async () => { await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`); };
const tryq = async (s, p) => { try { return { rows: await q(s, p) }; } catch (e) { return { err: e.message }; } };

// Supabase stand-ins
await db.exec(`
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create schema auth;
  create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}');
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth to authenticated, anon; grant execute on function auth.uid() to authenticated, anon;
`);
await db.exec(fs.readFileSync(`${repo}/migrations/20261101000000_init.sql`, 'utf8').replace('create extension if not exists pgcrypto;',''));
await db.exec(fs.readFileSync(`${repo}/seed.sql`, 'utf8'));
await db.exec(`grant usage on schema public to authenticated, anon;
  grant select, insert, update, delete on all tables in schema public to authenticated;
  grant select on all tables in schema public to anon;`);
ok((await q('select count(*)::int n from timetable'))[0].n === 31, 'sample timetable seeded (31 classes)');
ok((await q('select count(*)::int n from plans'))[0].n === 7, '7 plans seeded');

// users
const U = n => `00000000-0000-0000-0000-00000000000${n}`;
for (let i = 1; i <= 6; i++) await q(`insert into auth.users(id, email, raw_user_meta_data) values ($1, $2, $3)`, [U(i), `u${i}@x.com`, JSON.stringify({ first_name: 'User' + i, last_name: 'Test' })]);
ok((await q('select count(*)::int n from profiles'))[0].n === 6, 'profiles auto-created from auth users');
await q(`update profiles set status='active', plan_id='unl', role='owner' where id=$1`, [U(1)]);
await q(`update profiles set status='active', plan_id='two' where id=$1`, [U(2)]);
await q(`update profiles set status='active', plan_id='hyrox10', credits=2, credits_expire=current_date+30 where id=$1`, [U(3)]);
await q(`update profiles set status='active', plan_id='unl' where id in ($1,$2)`, [U(4), U(5)]);

// next Monday-Friday dates
const nextMon = (await q(`select (date_trunc('week', current_date) + interval '7 days')::date d`))[0].d;
const ds = d => new Date(d).toISOString().slice(0, 10);
const mon = ds(nextMon), tue = ds(new Date(+nextMon + 864e5)), wed = ds(new Date(+nextMon + 2 * 864e5));
const tt = async (wd, time) => (await q(`select id from timetable where weekday=$1 and start_time=$2`, [wd, time]))[0].id;
await asSuper(); await q(`update settings set book_ahead_days = 14`);
const monWod = await tt(0, '06:15'), monWod2 = await tt(0, '09:30'), monWod3 = await tt(0, '12:15'), tueHyrox = await tt(1, '18:15');

// plan rules
await asUser(U(2));
ok((await q(`select book_class($1,$2) r`, [mon, monWod]))[0].r === 'booked', '2-a-week member books class 1');
ok((await q(`select book_class($1,$2) r`, [mon, monWod2]))[0].r === 'booked', '2-a-week member books class 2');
let r = await tryq(`select book_class($1,$2) r`, [mon, monWod3]);
ok(r.err && r.err.includes('2 a week used'), 'third class in the week blocked: ' + r.err);
r = await tryq(`select book_class($1,$2) r`, [tue, tueHyrox]);
ok(r.err && r.err.includes('Not on your plan'), 'Hyrox blocked on CrossFit-only plan');
r = await tryq(`update profiles set plan_id='unl' where id=$1`, [U(2)]);
ok(r.err && r.err.includes('Not allowed'), 'member cannot change own plan');
r = await tryq(`update profiles set phone='0770' where id=$1 returning phone`, [U(2)]);
ok(!r.err && r.rows.length === 1, 'member can edit own phone');
r = await tryq(`select count(*)::int n from profiles`);
ok(r.rows[0].n === 1, 'member only sees own profile (RLS)');

// pack credits
await asUser(U(3));
ok((await q(`select book_class($1,$2) r`, [tue, tueHyrox]))[0].r === 'booked', 'pack member books Hyrox');
await asSuper();
ok((await q(`select credits from profiles where id=$1`, [U(3)]))[0].credits === 1, 'credit used');

// capacity + waitlist + promotion
await q(`update timetable set capacity = 2 where id=$1`, [monWod]); // U2 already in
await asUser(U(4)); ok((await q(`select book_class($1,$2) r`, [mon, monWod]))[0].r === 'booked', 'U4 takes last space');
await asUser(U(5)); ok((await q(`select book_class($1,$2) r`, [mon, monWod]))[0].r === 'waitlist', 'U5 goes on waitlist');
const sum = await q(`select * from class_summary($1,$1) where timetable_id=$2`, [mon, monWod]);
ok(sum[0].booked === 2 && sum[0].waitlist === 1 && sum[0].my_status === 'waitlist' && sum[0].my_position === 1, 'class summary shows counts and my waitlist position');
await asUser(U(4));
const b4 = (await q(`select id from bookings where member_id=$1 and class_date=$2 and timetable_id=$3`, [U(4), mon, monWod]))[0].id;
ok((await q(`select cancel_booking($1) r`, [b4]))[0].r === 'cancelled', 'U4 cancels early (no penalty)');
await asSuper();
ok((await q(`select status from bookings where member_id=$1 and class_date=$2 and timetable_id=$3`, [U(5), mon, monWod]))[0].status === 'booked', 'U5 promoted from waitlist');
ok((await q(`select count(*)::int n from notifications where member_id=$1`, [U(5)]))[0].n === 1, 'U5 notified');

// someone else's booking
await asUser(U(4));
const b5 = (await q(`select id from bookings where member_id=$1 and status='booked' and timetable_id=$2`, [U(5), monWod]).catch(() => [])) ;
ok(b5.length === 0, 'member cannot see other members bookings');
await asSuper(); const b5id = (await q(`select id from bookings where member_id=$1 and timetable_id=$2 and status='booked'`, [U(5), monWod]))[0].id;
await asUser(U(4)); r = await tryq(`select cancel_booking($1)`, [b5id]);
ok(r.err && r.err.includes('Not your booking'), 'cannot cancel someone else\'s booking');

// staff
await asUser(U(1));
ok((await q(`select count(*)::int n from profiles`))[0].n === 6, 'owner sees all profiles');
const n = (await q(`select staff_cancel_class($1,$2,'Coach ill') n`, [mon, monWod]))[0].n;
ok(n === 2, 'staff cancel notifies 2 booked members');
await asUser(U(2)); r = await tryq(`select book_class($1,$2)`, [mon, monWod]);
ok(r.err && r.err.includes('cancelled'), 'cannot book a cancelled class');

// programming visibility + notes stripped
await asSuper();
await q(`insert into programming(prog_date, track, status, sections) values (current_date, 'wod', 'published', '[{"id":"s1","title":"Fran","notes":"coach only"}]'),
  (current_date+1, 'wod', 'draft', '[{"id":"s1","title":"Secret"}]'), (current_date+2, 'wod', 'scheduled', '[{"id":"s1","title":"Later"}]')`);
await q(`update programming set release_at = now() + interval '1 day' where status='scheduled'`);
await asUser(U(2));
const pp = await q(`select * from programming_public order by prog_date`);
ok(pp.length === 1 && !('notes' in pp[0].sections[0]), 'members see published only, coach notes removed');
r = await tryq(`select * from programming`); ok(!r.err && r.rows.length === 0, 'members cannot read raw programming');

// open gym
await asSuper();
const monOG = mon;
await asUser(U(4));
r = await tryq(`select book_open_gym($1,'10:30',90,'Lifting','Snatch','{"lift":2,"row":1}','', '', true) id`, [monOG]);
ok(!r.err, 'open gym booking with kit ' + (r.err || ''));
await asUser(U(5));
r = await tryq(`select book_open_gym($1,'11:00',60,'Lifting','','{"lift":4}','', '', true) id`, [monOG]);
ok(r.err && r.err.includes('Lifting platform'), 'kit over capacity blocked: ' + r.err);
r = await tryq(`select book_open_gym($1,'11:00',60,'Lifting','','{"lift":3}','', '', true) id`, [monOG]);
ok(!r.err, 'remaining kit bookable');
r = await tryq(`select book_open_gym($1,'12:00',60,'x','','{}','', '', true) id`, [monOG]);
ok(r.err, 'already booked that day / outside hours blocked: ' + r.err);
await asUser(U(2));
r = await tryq(`select book_open_gym($1,'14:00',60,'x','','{}','', '', true) id`, [monOG]);
ok(r.err && r.err.includes('not on your plan'), 'Open Gym blocked on 2-a-week plan');
const load = await q(`select * from og_day_load($1)`, [monOG]);
ok(load.find(x => x.slot === '11:00:00').people === 2, 'occupancy by slot');

// freeze
await asUser(U(5));
await q(`select request_freeze(current_date + 14, 'Holiday')`);
await asSuper();
ok((await q(`select status from profiles where id=$1`, [U(5)]))[0].status === 'frozen', 'freeze works');

// taster
await db.exec('set role anon');
r = await tryq(`select submit_taster('Kerry A','k@x.com','0770','CrossFit','Never',null,null,true) id`);
ok(!r.err, 'anonymous taster sign-up ' + (r.err || ''));
r = await tryq(`select * from leads`); ok(r.err || r.rows.length === 0, 'anon cannot read leads');
await asSuper();


// door check (service role path)
await asSuper();
await q(`update settings set door_mode='booked_only'`);
let d = await q(`select * from door_check($1)`, [U(2)]);
ok(d[0].allowed === false, 'door: member with no booking now is refused (' + d[0].reason + ')');
d = await q(`select * from door_check($1)`, [U(1)]);
ok(d[0].allowed === true, 'door: staff allowed');
await q(`update settings set door_mode='active_members'`);
d = await q(`select * from door_check($1)`, [U(4)]);
ok(d[0].allowed === true, 'door: active member allowed in active_members mode');
d = await q(`select * from door_check($1)`, [U(5)]);
ok(d[0].allowed === false, 'door: frozen member refused');
ok((await q(`select count(*)::int n from access_log`))[0].n === 4, 'door attempts logged');
await q(`select daily_housekeeping()`);
ok(true, 'housekeeping runs');

// join metadata -> profile + consents
await asSuper();
await q(`insert into auth.users(id, email, raw_user_meta_data) values ($1,'j@x.com',$2)`, ['00000000-0000-0000-0000-000000000009',
  JSON.stringify({first_name:'Jo', last_name:'New', phone:'0771', dob:'1990-01-02', ec_name:'Mum', ec_phone:'0772', parq:{q0:'n'}, parq_flag:true,
   waiver_signed:true, waiver_signature:'Jo New', waiver_version:'2026-11', preferred_times:['Evening'], role:'owner', status:'active'})]);
const jp = (await q(`select * from profiles where id=$1`, ['00000000-0000-0000-0000-000000000009']))[0];
ok(jp.role === 'member' && jp.status === 'pending' && jp.parq_flag && jp.waiver_signed_at && jp.preferred_times[0] === 'Evening', 'join answers saved, role/status not spoofable');
ok((await q(`select count(*)::int n from consents where member_id=$1`, ['00000000-0000-0000-0000-000000000009']))[0].n === 5, 'consents recorded');
await asUser(U(2));
const anon = await q(`select * from og_anon(current_date, current_date + 14)`);
ok(anon.length === 2 && anon.every(r => r.mine === false && !('member_id' in r)), 'other members open gym visible without names');

console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
