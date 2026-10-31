-- House of Wolves starting data. Run after the migration. Safe to re-run: it updates rather than duplicates.
-- Class times are a SAMPLE timetable; edit them in the app (Coach > Timetable) before go-live.

insert into settings (id) values (1) on conflict (id) do nothing;

insert into plans (id, name, description, price_pence, unit, monthly, per_week, pack, valid_days, tracks, open_gym, intro_discount_pence, converts_to, sort) values
  ('unl',     'CFHOW Unlimited',     'Every class, every track, plus Open Gym.',                       10000, 'month',      true,  null, null, null, '{wod,partner,gym,barbell,hyrox}', true,  0,    null,  2),
  ('intro',   'Introductory Month',  'Unlimited classes and Open Gym for your first month. £20 less than Unlimited.', 10000, 'month', true, null, null, null, '{wod,partner,gym,barbell,hyrox}', true, 2000, 'unl', 1),
  ('three',   'CFHOW 3 a Week',      'Any 3 classes a week, Hyrox included. No Open Gym.',             6500,  'month',      true,  3,    null, null, '{wod,partner,gym,barbell,hyrox}', false, 0,    null,  3),
  ('two',     'CrossFit 2 a Week',   'Any 2 CrossFit classes a week: WoD, Gymnastics, Barbell.',       5000,  'month',      true,  2,    null, null, '{wod,partner,gym,barbell}',       false, 0,    null,  4),
  ('hyrox2',  'Hyrox 2 a Week',      'Both weekly Hyrox classes.',                                     5000,  'month',      true,  2,    null, null, '{hyrox}',                         false, 0,    null,  5),
  ('hyrox10', 'Hyrox 10-Class Pass', '10 Hyrox classes, use within 2 months.',                         7500,  '10 classes', false, null, 10,   60,   '{hyrox}',                         false, 0,    null,  6),
  ('drop',    'Drop-in',             'Single class. Visiting? Welcome to the pack.',                   1200,  'class',      false, null, 1,    30,   '{wod,partner,gym,barbell,hyrox}', false, 0,    null,  7)
on conflict (id) do update set name = excluded.name, description = excluded.description, price_pence = excluded.price_pence,
  unit = excluded.unit, monthly = excluded.monthly, per_week = excluded.per_week, pack = excluded.pack, valid_days = excluded.valid_days,
  tracks = excluded.tracks, open_gym = excluded.open_gym, intro_discount_pence = excluded.intro_discount_pence, converts_to = excluded.converts_to, sort = excluded.sort;

insert into class_types (id, name, colour, track, default_capacity) values
  ('wod',     'CrossFit WoD', '#d9d9d6', 'wod',     16),
  ('partner', 'Partner WoD',  '#b48ce0', 'wod',     20),
  ('gym',     'Gymnastics',   '#6fb3e0', 'gym',     12),
  ('barbell', 'Barbell Club', '#e07a6f', 'barbell', 10),
  ('hyrox',   'Hyrox',        '#f2c94c', 'hyrox',   16)
on conflict (id) do update set name = excluded.name, colour = excluded.colour, track = excluded.track, default_capacity = excluded.default_capacity;

insert into kit (id, name, qty, sort) values
  ('lift', 'Lifting platform + bar', 5, 1), ('rig', 'Rig space', 8, 2), ('rope', 'Rope climb', 5, 3),
  ('row', 'RowErg', 6, 4), ('ski', 'SkiErg', 6, 5), ('bike', 'BikeErg', 1, 6), ('assault', 'Assault Bike', 2, 7),
  ('sled', 'Sled', 1, 8), ('sandbag', 'Sandbag', 4, 9)
on conflict (id) do update set name = excluded.name, qty = excluded.qty, sort = excluded.sort;

-- sample timetable (only inserted if the timetable is empty)
do $$
declare d int;
begin
  if exists (select 1 from timetable) then return; end if;
  for d in 0..4 loop
    insert into timetable (weekday, start_time, type, coach, capacity) values
      (d, '06:15', 'wod', 'Huw', 16), (d, '09:30', 'wod', 'Kirsty', 16), (d, '12:15', 'wod', 'Rachael', 16), (d, '17:15', 'wod', 'Kanisha', 16);
    if d < 4 then
      insert into timetable (weekday, start_time, type, coach, capacity) values
        (d, '18:15', case when d = 1 then 'hyrox' else 'wod' end, case when d = 1 then 'Gavin' else 'Mike' end, 16);
    end if;
    if d in (0, 2) then insert into timetable (weekday, start_time, type, coach, capacity) values (d, '19:15', 'gym', 'Rachael', 12); end if;
    if d in (1, 3) then insert into timetable (weekday, start_time, type, coach, capacity) values (d, '19:15', 'barbell', 'Andun', 10); end if;
  end loop;
  insert into timetable (weekday, start_time, type, coach, capacity) values
    (5, '09:00', 'partner', 'Andun', 20), (5, '10:15', 'wod', 'Kanisha', 16), (6, '09:00', 'hyrox', 'Gavin', 16);
end $$;

do $$
declare d int;
begin
  if exists (select 1 from og_windows) then return; end if;
  for d in 0..4 loop
    insert into og_windows (weekday, start_time, end_time) values (d, '10:30', '12:00'), (d, '13:30', '17:00');
  end loop;
  insert into og_windows (weekday, start_time, end_time) values (5, '11:15', '13:30'), (6, '10:00', '13:00');
end $$;

-- Daily housekeeping at 02:00 (unfreezes, no-shows, credit expiry, data retention).
-- Needs the pg_cron extension: Supabase dashboard > Database > Extensions > pg_cron, then run:
-- select cron.schedule('how-daily', '0 2 * * *', 'select public.daily_housekeeping()');
