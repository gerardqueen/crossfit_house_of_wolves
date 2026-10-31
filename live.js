/* House of Wolves: live mode.
   Loaded after the app. Does nothing unless config.js has a Supabase URL and anon key.
   It loads real data into the same shape the screens already use (S, PLANS, TYPES, KIT),
   and routes every action through the database functions and edge functions. */
(function () {
  'use strict';
  if (!window.HOW_LIVE) return;
  const cfg = window.HOW_CONFIG;
  const base = cfg.supabaseUrl.replace(/\/$/, '');
  let sb = null, session = null, myProfile = null, lastSync = 0, syncing = null;
  const Live = (window.Live = {});

  /* ---------------- plumbing ---------------- */
  const loadScript = (src) => new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('Could not load ' + src)); document.head.appendChild(s); });
  async function fn(name, body) {
    const { data } = await sb.auth.getSession();
    const r = await fetch(`${base}/functions/v1/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: cfg.supabaseAnonKey, ...(data.session ? { Authorization: 'Bearer ' + data.session.access_token } : {}) },
      body: JSON.stringify(body || {}),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) throw new Error(j.error || `Request failed (${r.status})`);
    return j;
  }
  async function rpc(name, args) { const { data, error } = await sb.rpc(name, args); if (error) throw new Error(error.message); return data; }
  async function run(p) { const { data, error } = await p; if (error) throw new Error(error.message); return data; }
  async function all(build) { let out = [], from = 0; for (;;) { const { data, error } = await build().range(from, from + 999); if (error) throw new Error(error.message); out = out.concat(data); if (data.length < 1000) return out; from += 1000; } }
  const act = (f) => async (...a) => { try { await f(...a); } catch (e) { toast(e.message, 'bad'); } };
  const hhmm = (t) => (t || '').slice(0, 5);
  const isStaff = () => myProfile && myProfile.role !== 'member';
  const londonLocal = (iso) => { if (!iso) return null; const d = new Date(iso); const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(d); const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d); return date + ' ' + time; };
  const splitInst = (id) => [id.slice(0, 10), id.slice(11)];
  async function refresh() { await Live.sync(); if (SH) drawSheet(); render(); }
  Live.refresh = refresh;

  /* ---------------- mapping ---------------- */
  function mapProfile(p) {
    const first = p.first_name || (p.email || 'Member').split('@')[0];
    return {
      id: p.id, role: p.role, name: `${p.first_name} ${p.last_name}`.trim() || p.email, first,
      plan: p.plan_id || 'none', start: p.plan_started || (p.created_at || '').slice(0, 10) || TODAY(), status: p.status,
      email: p.email, phone: p.phone, dob: p.dob || '1990-01-01', address: p.address, postcode: p.postcode,
      ec: { name: p.ec_name, rel: p.ec_relationship, phone: p.ec_phone }, injuries: p.injuries, level: p.experience, goals: p.goals,
      credits: p.credits, creditsExp: p.credits_expire || TODAY(), waiver: !!p.waiver_signed_at, parq: p.parq_flag, notes: '',
      frozenUntil: p.frozen_until, src: p.heard_from, hasBilling: !!p.stripe_customer_id, hasSub: !!p.stripe_subscription_id,
    };
  }
  const pseudoCache = {};
  function pseudo(id, name) {
    if (!pseudoCache[id]) pseudoCache[id] = { id, name: name || 'Member', first: (name || 'Member').split(' ')[0], plan: 'none', status: 'active', ec: { name: '', rel: '', phone: '' }, injuries: '', credits: 0, start: TODAY(), pseudo: true };
    return pseudoCache[id];
  }

  async function loadPublic() {
    const [st, plans, types, tt, kit, ogw] = await Promise.all([
      run(sb.from('settings').select('*').eq('id', 1).single()),
      run(sb.from('plans').select('*').eq('active', true).order('sort')),
      run(sb.from('class_types').select('*')),
      run(sb.from('timetable').select('*').eq('active', true)),
      run(sb.from('kit').select('*').order('sort')),
      run(sb.from('og_windows').select('*')),
    ]);
    Live.settings = st;
    PLANS.splice(0, PLANS.length, ...plans.map((p) => ({
      id: p.id, name: p.name, price: (p.price_pence - (p.intro_discount_pence || 0)) / 100, unit: p.intro_discount_pence ? 'first month' : p.unit, tracks: p.tracks, og: p.open_gym, monthly: p.monthly,
      perWeek: p.per_week || undefined, pack: p.pack || undefined, valid: p.valid_days || undefined, desc: p.description, payable: !!p.stripe_price_id,
    })));
    for (const k of Object.keys(TYPES)) delete TYPES[k];
    types.forEach((t) => { TYPES[t.id] = { name: t.name, cap: t.default_capacity, c: t.colour, track: t.track }; });
    KIT.splice(0, KIT.length, ...kit.map((k) => ({ id: k.id, n: k.name, q: k.qty })));
    const ogWin = {}; ogw.sort((a, b) => a.start_time < b.start_time ? -1 : 1).forEach((w) => { (ogWin[w.weekday] = ogWin[w.weekday] || []).push([hhmm(w.start_time), hhmm(w.end_time)]); });
    S = {
      v: 1, live: true, meId: null, members: [], bookings: {}, bkIds: {}, overrides: {}, prog: {}, scores: {}, prs: {}, og: [], leads: [], notifs: [], hist: {}, log: [], payments: [],
      brand: { accent: st.accent, name: st.gym_name, logo: st.logo_url },
      cfg: { lateHrs: st.late_cancel_hours, ahead: st.book_ahead_days, ogCap: st.og_capacity, autoPromote: st.auto_promote, introRemind: st.intro_remind_days, release: hhmm(st.release_time) },
      template: tt.map((t) => ({ id: t.id, day: t.weekday, time: hhmm(t.start_time), type: t.type, coach: t.coach, cap: t.capacity })),
      ogWin,
    };
  }

  Live.sync = async function () {
    if (syncing) return syncing;
    syncing = (async () => {
      const T = TODAY();
      await loadPublic();
      myProfile = await run(sb.from('profiles').select('*').eq('id', session.user.id).single());
      const staff = isStaff();
      const from = ymd(add(mon(t0()), -7)), to = ymd(add(t0(), (S.cfg.ahead || 7) + 7)), histFrom = ymd(add(t0(), -84));
      const me = mapProfile(myProfile);
      S.meId = me.id;
      const ov = await run(sb.from('class_overrides').select('*').gte('class_date', from).lte('class_date', to));
      ov.forEach((o) => { S.overrides[o.class_date + '_' + o.timetable_id] = { cancelled: o.cancelled, reason: o.reason || '', coach: o.coach || undefined }; });

      if (staff) {
        const profs = await all(() => sb.from('profiles').select('*').order('first_name'));
        S.members = profs.map(mapProfile);
        const notes = await run(sb.from('staff_notes').select('*'));
        notes.forEach((n) => { const m = S.members.find((x) => x.id === n.member_id); if (m) m.notes = n.notes; });
        const rows = await all(() => sb.from('bookings').select('id,member_id,class_date,timetable_id,status,created_at').gte('class_date', from).lte('class_date', to).order('created_at'));
        rows.forEach((r) => {
          const key = r.class_date + '_' + r.timetable_id, b = bk(key);
          (S.bkIds[key] = S.bkIds[key] || {})[r.member_id] = r.id;
          if (r.status === 'booked' || r.status === 'no_show') b.in.push(r.member_id);
          else if (r.status === 'attended') { b.in.push(r.member_id); b.checked.push(r.member_id); }
          else if (r.status === 'waitlist') b.wait.push(r.member_id);
          else if (r.status === 'late_cancel') b.late.push(r.member_id);
        });
        const hist = await all(() => sb.from('bookings').select('member_id,class_date').eq('status', 'attended').gte('class_date', histFrom).lt('class_date', from));
        hist.forEach((h) => (S.hist[h.member_id] = S.hist[h.member_id] || []).push(h.class_date));
        const og = await all(() => sb.from('og_bookings').select('*').gte('og_date', ymd(add(t0(), -1))).lte('og_date', ymd(add(t0(), 8))).neq('status', 'cancelled'));
        S.og = og.map(mapOg);
        const prog = await run(sb.from('programming').select('*').gte('prog_date', ymd(add(mon(t0()), -7))).lte('prog_date', ymd(add(mon(t0()), 13))));
        prog.forEach((p) => { S.prog[p.prog_date + '|' + p.track] = { status: p.status, release: londonLocal(p.release_at) || (ymd(add(mon(pd(p.prog_date)), -1)) + ' ' + S.cfg.release), sections: p.sections, by: '' }; });
        const leads = await run(sb.from('leads').select('*').order('created_at', { ascending: false }).limit(300));
        S.leads = leads.map((l) => ({ id: l.id, name: l.name, email: l.email, phone: l.phone, interest: l.interest, status: l.status, inst: l.class_date && l.timetable_id ? l.class_date + '_' + l.timetable_id : null, created: l.created_at.slice(0, 10), exp: l.experience || '', src: l.source || '' }));
        const log = await run(sb.from('activity_log').select('*').order('created_at', { ascending: false }).limit(60));
        S.log = log.map((r) => ({ t: r.body, at: r.created_at }));
      } else {
        S.members = [me];
        const sum = await rpc('class_summary', { p_from: from, p_to: to });
        sum.forEach((r) => {
          const key = r.class_date + '_' + r.timetable_id, b = bk(key);
          const names = r.names && r.names.length ? r.names : Array(r.booked).fill('Member');
          b.in = names.map((n, i) => pseudo(`x${key}_${i}`, n).id);
          b.wait = Array.from({ length: r.waitlist }, (_, i) => pseudo(`w${key}_${i}`, 'Member').id);
          if (r.my_booking) {
            (S.bkIds[key] = {})[me.id] = r.my_booking;
            if (r.my_status === 'booked' || r.my_status === 'attended') { const mi = names.lastIndexOf(myProfile.first_name); b.in[mi >= 0 ? mi : b.in.length - 1] = me.id; if (r.my_status === 'attended') b.checked.push(me.id); }
            else if (r.my_status === 'waitlist') b.wait[Math.max(0, (r.my_position || 1) - 1)] = me.id;
            else if (r.my_status === 'late_cancel') b.late.push(me.id);
          }
        });
        const hist = await run(sb.from('bookings').select('class_date').eq('member_id', me.id).eq('status', 'attended').gte('class_date', histFrom));
        S.hist[me.id] = hist.map((h) => h.class_date);
        const mine = await run(sb.from('og_bookings').select('*').eq('member_id', me.id).gte('og_date', ymd(add(t0(), -1))).neq('status', 'cancelled'));
        const others = await rpc('og_anon', { p_from: T, p_to: ymd(add(t0(), 8)) });
        S.og = mine.map(mapOg).concat(others.filter((o) => !o.mine).map((o) => ({ id: o.id, mid: pseudo('xog', 'Member').id, date: o.og_date, start: hhmm(o.start_time), dur: o.minutes, kit: o.kit || {}, focus: 'Training', plan: '', injury: '', buddy: '', status: o.status })));
        const prog = await run(sb.from('programming_public').select('*').gte('prog_date', ymd(add(mon(t0()), -7))).lte('prog_date', ymd(add(mon(t0()), 13))));
        prog.forEach((p) => { S.prog[p.prog_date + '|' + p.track] = { status: 'published', release: londonLocal(p.release_at) || (ymd(add(mon(pd(p.prog_date)), -1)) + ' ' + S.cfg.release), sections: p.sections }; });
        S.payments = (await run(sb.from('payments').select('*').eq('member_id', me.id).order('created_at', { ascending: false }).limit(24)))
          .map((p) => ({ d: p.created_at.slice(0, 10), a: p.amount_pence / 100, desc: p.description, via: p.status === 'failed' ? 'Failed' : 'Stripe' }));
      }
      // leaderboards
      const lb = await all(() => sb.from('leaderboard').select('*').gte('prog_date', ymd(add(mon(t0()), -7))).lte('prog_date', T));
      lb.forEach((s) => {
        if (!member(s.member_id)) S.members.push(pseudo(s.member_id, s.display_name));
        const hf = Array.from({ length: Math.max(0, s.high_fives - (s.i_high_fived ? 1 : 0)) }, (_, k) => 'hf' + k);
        if (s.i_high_fived) hf.push(me.id);
        (S.scores[s.prog_date + '|' + s.track + '|' + s.section_id] = S.scores[s.prog_date + '|' + s.track + '|' + s.section_id] || []).push({ id: s.id, mid: s.member_id, raw: s.raw, div: s.division, note: s.note, hf });
      });
      const prs = await all(() => sb.from('prs').select('*'));
      prs.forEach((p) => (S.prs[p.member_id] = S.prs[p.member_id] || []).push({ id: p.id, k: p.name, v: Number(p.value), t: p.kind, d: p.pr_date }));
      const notifs = await run(sb.from('notifications').select('*').eq('member_id', me.id).order('created_at').limit(50));
      S.notifs = notifs.map((n) => ({ id: n.id, mid: n.member_id, text: n.body, at: n.created_at, read: n.read }));
      lastSync = Date.now();
    })();
    try { await syncing; } finally { syncing = null; }
  };
  function mapOg(o) {
    return { id: o.id, mid: o.member_id, date: o.og_date, start: hhmm(o.start_time), dur: o.minutes, focus: o.focus, plan: o.plan_text, kit: o.kit || {}, injury: o.injury, buddy: o.buddy, status: o.status, inAt: o.in_at, outAt: o.out_at };
  }

  /* ---------------- auth screens ---------------- */
  function authShell(inner) {
    $('#app').className = 'app member';
    $('#app').innerHTML = `<div class="auth"><div class="logo">${markHTML()}<div><b style="font-family:var(--hf);font-size:24px;text-transform:uppercase;letter-spacing:.04em">${esc(S.brand.name)}</b><div class="tiny muted" style="letter-spacing:.14em;text-transform:uppercase">CrossFit · Livingston</div></div></div>${inner}
      <div class="tiny muted mt2" style="text-align:center"><a href="privacy.html">Privacy</a> · <a href="terms.html">Terms</a></div></div>`;
  }
  function renderAuth(msg) {
    applyBrand();
    if (UI.recovery) {
      authShell(`<h1>New password</h1><form data-f="lvRecover" class="mt2"><label class="f"><span>New password</span><input type="password" name="pw" minlength="8" required autocomplete="new-password"></label><button class="btn p block mt">Save password</button></form>`);
      return;
    }
    const tab = UI.authTab || 'signin';
    authShell(`<h1>${tab === 'signin' ? 'Welcome back' : 'Join the pack'}</h1>
      <div class="seg mt" style="margin-left:0;display:inline-flex"><button class="${tab === 'signin' ? 'on' : ''}" data-a="lvAuthTab" data-v="signin">Sign in</button><button class="${tab === 'join' ? 'on' : ''}" data-a="lvAuthTab" data-v="join">New here</button></div>
      ${msg ? `<div class="notice mt">${msg}</div>` : ''}
      ${tab === 'signin'
        ? `<form data-f="lvSignIn" class="mt"><label class="f"><span>Email</span><input type="email" name="email" required autocomplete="email"></label><label class="f"><span>Password</span><input type="password" name="pw" required autocomplete="current-password"></label><button class="btn p block mt">Sign in</button></form><button class="btn g block mt" data-a="lvForgot">Forgot password?</button>`
        : `<div class="card mt"><div class="b">Become a member</div><div class="small muted" style="margin:6px 0 12px">Choose a membership, fill in your details and pay securely. Takes about 4 minutes.</div><button class="btn p block" data-a="join">Join now</button></div>
           <div class="card"><div class="b">Try a free taster</div><div class="small muted" style="margin:6px 0 12px">Never done CrossFit or Hyrox? Book a free session with a coach.</div><button class="btn block" data-a="taster">Book a free taster</button></div>`}`);
  }

  /* ---------------- boot ---------------- */
  async function boot() {
    document.querySelector('.pv')?.remove();
    $('#app').innerHTML = '<div style="min-height:100vh;display:grid;place-items:center"><div class="mark" style="width:56px;height:56px">HOW</div></div>';
    try {
      await loadScript('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js');
    } catch (e) { $('#app').innerHTML = `<div class="empty" style="margin:40px">${esc(e.message)}. Check your connection and reload.</div>`; return; }
    sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
    Live.client = sb;
    sb.auth.onAuthStateChange((ev) => { if (ev === 'PASSWORD_RECOVERY') { UI.recovery = true; renderAuth(); } });
    try { await loadPublic(); } catch (e) { $('#app').innerHTML = `<div class="empty" style="margin:40px">Can't reach the gym's database: ${esc(e.message)}</div>`; return; }
    const { data } = await sb.auth.getSession();
    session = data.session;
    const qp = new URLSearchParams(location.search);
    const checkout = qp.get('checkout'); const tab = qp.get('tab');
    if (checkout || tab) history.replaceState(null, '', location.pathname + location.hash);
    if (!session || UI.recovery) { window.HOW_SIGNED_IN = false; renderAuth(); return; }
    window.HOW_SIGNED_IN = true;
    await Live.sync();
    UI.role = isStaff() ? (UI.role === 'member' && localStorageGet('how-role') === 'member' ? 'member' : 'staff') : 'member';
    if (tab === 'me') UI.tab = 'me';
    render();
    if (checkout === 'success') { toast('Payment complete. Your membership will show in a few seconds.', 'good'); setTimeout(refresh, 4000); setTimeout(refresh, 12000); }
    if (checkout === 'cancelled') toast('Payment cancelled. Nothing was charged.');
    setInterval(() => { if (document.visibilityState === 'visible' && !SH && !document.activeElement.matches('input,textarea,select') && Date.now() - lastSync > 60000) refresh().catch(() => {}); }, 15000);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && Date.now() - lastSync > 20000 && !SH) refresh().catch(() => {}); });
  }
  const localStorageGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const localStorageSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };

  /* ---------------- core overrides ---------------- */
  window.book = act(async (id, mid, staff) => {
    const [date, tid] = splitInst(id);
    if (staff) { await rpc('staff_add_booking', { p_member: mid, p_date: date, p_tt: tid }); toast((member(mid)?.first || 'Member') + ' added', 'good'); }
    else {
      const r = await rpc('book_class', { p_date: date, p_tt: tid });
      const i = findInst(id);
      toast(r === 'waitlist' ? "You're on the waitlist. You'll be booked in automatically if a space opens." : r === 'already' ? 'Already booked' : `Booked: ${TYPES[i.type].name}, ${fmtD(date)} ${i.time}`, r === 'waitlist' ? '' : 'good');
    }
    await refresh();
  });
  window.cancelBk = act(async (id, mid, staff) => {
    const bid = S.bkIds[id]?.[mid];
    if (!bid) throw new Error('Booking not found. Pull to refresh.');
    const r = await rpc('cancel_booking', { p_booking: bid });
    if (!staff) toast(r === 'late_cancel' ? `Late cancel (under ${S.cfg.lateHrs}h). This still counts as a used class.` : r === 'left_waitlist' ? 'Removed from waitlist' : 'Cancelled. No charge.', r === 'late_cancel' ? 'bad' : '');
    else toast((member(mid)?.first || 'Member') + ' removed, no penalty');
    await refresh();
  });

  Object.assign(ACT, {
    role: (d) => { UI.role = d.v; localStorageSet('how-role', d.v); closeSheet(); render(); scrollTo(0, 0); },
    lvAuthTab: (d) => { UI.authTab = d.v; renderAuth(); },
    lvForgot: act(async () => {
      const email = $('form[data-f="lvSignIn"] [name=email]')?.value?.trim();
      if (!email) throw new Error('Type your email above first');
      const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
      if (error) throw new Error(error.message);
      renderAuth('Check your email for a link to reset your password.');
    }),
    checkin: act(async (d) => { await rpc('check_in', { p_booking: S.bkIds[d.v]?.[S.meId] }); toast("Checked in. Have a good session.", 'good'); await refresh(); }),
    readN: act(async (d) => { const n = S.notifs[+d.v]; if (n) await run(sb.from('notifications').update({ read: true }).eq('id', n.id)); await refresh(); }),
    changePlan: (d) => { if (isStaff() && d.v && d.v !== S.meId) sheet(shPlan, d.v); else sheet(shPlan, null); },
    unfreeze: act(async (d) => { await fn('stripe-portal', { action: 'unfreeze', member_id: d.v }); toast('Membership unfrozen', 'good'); await refresh(); }),
    topUp: act(async () => { const r = await fn('stripe-checkout', { plan_id: me().plan }); if (r.url) location.href = r.url; }),
    portal: act(async () => { const r = await fn('stripe-portal', { action: 'portal' }); location.href = r.url; }),
    delScore: act(async (d) => { const [date, track, sid] = d.k.split('|'); await run(sb.from('scores').delete().match({ member_id: S.meId, prog_date: date, track, section_id: sid })); closeSheet(); await refresh(); }),
    hf: act(async (d) => {
      const s = (S.scores[d.k] || []).find((x) => x.mid === d.m); if (!s) return;
      if (s.hf.includes(S.meId)) await run(sb.from('high_fives').delete().match({ score_id: s.id, member_id: S.meId }));
      else await run(sb.from('high_fives').insert({ score_id: s.id, member_id: S.meId }));
      await refresh();
    }),
    ogCancel: act(async (d) => { await rpc('og_set_status', { p_id: d.v, p_status: 'cancelled' }); toast('Open Gym booking cancelled'); await refresh(); }),
    ogIn: act(async (d) => { await rpc('og_set_status', { p_id: d.v, p_status: 'in' }); toast('Checked in. Have a good session.', 'good'); await refresh(); }),
    ogOut: act(async (d) => { await rpc('og_set_status', { p_id: d.v, p_status: 'done' }); toast('Checked out', 'good'); await refresh(); }),
    rCheck: act(async (d) => { const b = bk(d.v); await rpc('staff_set_attendance', { p_booking: S.bkIds[d.v][d.m], p_attended: !b.checked.includes(d.m) }); await refresh(); }),
    allIn: act(async (d) => { const b = bk(d.v); for (const mid of b.in) if (!b.checked.includes(mid)) await rpc('staff_set_attendance', { p_booking: S.bkIds[d.v][mid], p_attended: true }); await refresh(); }),
    rAdd: (d) => { const mid = $('#addMem').value; if (mid) window.book(d.v, mid, true); },
    rPromote: (d) => window.book(d.v, d.m, true),
    restore: act(async (d) => { const [date, tid] = splitInst(d.v); await run(sb.from('class_overrides').update({ cancelled: false, reason: null }).match({ class_date: date, timetable_id: tid })); await refresh(); }),
    credit: act(async (d) => { const m = member(d.v); await run(sb.from('profiles').update({ credits: (m.credits || 0) + 1 }).eq('id', d.v)); await refresh(); }),
    leadSt: act(async (d) => { await run(sb.from('leads').update({ status: d.s }).eq('id', d.v)); await refresh(); }),
    leadJoin: act(async (d) => {
      const l = S.leads.find((x) => x.id === d.v); if (!l?.email) throw new Error('This lead has no email address');
      const r = await fn('members-import', { rows: [{ name: l.name, email: l.email, phone: l.phone }] });
      if (!r.results[0]?.ok) throw new Error(r.results[0]?.detail || 'Invite failed');
      await run(sb.from('leads').update({ status: 'joined' }).eq('id', l.id));
      toast(`Invite sent to ${l.email}. They set a password, then choose and pay for a plan.`, 'good'); await refresh();
    }),
    join: () => {
      if (!window.HOW_SIGNED_IN) { UI.join = { step: 0, data: {} }; sheet(shJoin); return; }
      if (isStaff()) { sheet(shInvite); return; }
      sheet(shPlan, null);
    },
    joinDone: () => { closeSheet(); },
    reset: () => toast('Not available in the live app'),
    viewAs: () => toast('Not available in the live app'),
    pSave: act(async (d) => {
      const pe = UI.pe, doc = pe.doc;
      doc.sections = doc.sections.filter((s) => (s.title || '').trim() || (s.body || '').trim());
      const [rd, rt] = doc.release.split(' ');
      const status = d.v === 'draft' ? 'draft' : new Date() >= at(rd, rt) ? 'published' : 'scheduled';
      if (!doc.sections.length && d.v !== 'draft') throw new Error('Add at least one section first');
      const [date, track] = pe.key.split('|');
      await run(sb.from('programming').upsert({ prog_date: date, track, status, release_at: new Date(rd + 'T' + rt).toISOString(), sections: doc.sections, author: S.meId, updated_at: new Date().toISOString() }));
      pe.dirty = false; UI.pe = null;
      toast(status === 'published' ? 'Published. Members can see it now.' : status === 'scheduled' ? `Scheduled for ${fmtD(rd, { weekday: 'short' })} ${rt}` : 'Draft saved', 'good');
      await refresh();
    }),
    ttDel: act(async (d) => { await run(sb.from('timetable').update({ active: false }).eq('id', d.v)); closeSheet(); await refresh(); }),
    accent: act(async (d) => { await run(sb.from('settings').update({ accent: d.v }).eq('id', 1)); await refresh(); }),
    noLogo: act(async () => { await run(sb.from('settings').update({ logo_url: null }).eq('id', 1)); await refresh(); }),
    import: () => sheet(shImport),
    buzz: act(async () => {
      toast('Checking you\'re at the gym…');
      const loc = await getLocation();
      const r = await fn('door-access', { action: 'buzz', ...(loc || {}) });
      toast(r.allowed ? (r.reason === 'Already buzzing' ? 'Buzzing, push the door' : 'Door buzzing, push to open') : r.reason, r.allowed ? 'good' : 'bad');
      if (r.allowed) setTimeout(() => refresh().catch(() => {}), 1500);
    }),
    staffOpen: act(async () => { const r = await fn('door-access', { action: 'staff-buzz' }); toast(r.allowed ? 'Door buzzing' : 'Plug-in error: ' + (r.reason || ''), r.allowed ? 'good' : 'bad'); }),
    lvHere: act(async () => {
      const loc = await getLocation(); if (!loc) throw new Error('Allow location access, then try again while you\'re at the gym');
      UI.doorLoc = loc; const f = $('form[data-f=lvDoor]'); f.gym_lat.value = loc.lat.toFixed(6); f.gym_lng.value = loc.lng.toFixed(6);
      $('#lvLoc').textContent = `Set to here (±${Math.round(loc.accuracy)} m). Press Save.`;
    }),
    signOut: act(async () => { await sb.auth.signOut(); location.reload(); }),
    exportData: act(async () => {
      const data = await fn('account', { action: 'export' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      a.download = 'house-of-wolves-my-data.json'; a.click();
    }),
    deleteAccount: () => sheet(() => ({ title: 'Delete account', body: `<form data-f="lvDelete"><div class="ink2">This cancels any membership payments and permanently deletes your account, bookings, scores and health details. Payment records are kept for accounting, without your name.</div><label class="f"><span>Type DELETE to confirm</span><input name="confirm" autocomplete="off"></label><div class="foot"><button class="btn danger block">Delete my account</button></div></form>` })),
    install: async () => { if (window.HOW_INSTALL) { window.HOW_INSTALL.prompt(); window.HOW_INSTALL = null; render(); } },
    stripeSetup: act(async () => { toast('Setting up Stripe…'); const r = await fn('stripe-setup', {}); sheet(() => ({ title: `Stripe ready (${r.mode} mode)`, body: `<div class="list">${r.report.map((x) => `<div class="li small">✓ ${esc(x)}</div>`).join('')}</div><div class="foot"><button class="btn p block" data-a="close">Done</button></div>` })); await refresh(); }),
    doorTest: act(async () => { const r = await fn('door-access', { action: 'test' }); toast(`Test buzz: ${r.unlock.ok ? 'sent' : 'failed'} (${r.unlock.detail || r.unlock.provider})`, r.unlock.ok ? 'good' : 'bad'); }),
  });

  Object.assign(FORMS, {
    lvSignIn: act(async (f) => {
      const { error } = await sb.auth.signInWithPassword({ email: f.email.value.trim(), password: f.pw.value });
      if (error) throw new Error(error.message === 'Invalid login credentials' ? 'Email or password not recognised' : error.message);
      location.reload();
    }),
    lvRecover: act(async (f) => { const { error } = await sb.auth.updateUser({ password: f.pw.value }); if (error) throw new Error(error.message); UI.recovery = false; toast('Password saved', 'good'); location.hash = ''; location.reload(); }),
    lvDelete: act(async (f) => { await fn('account', { action: 'delete', confirm: f.confirm.value.trim() }); await sb.auth.signOut(); location.reload(); }),
    og: act(async (f) => {
      if (!f.c1.checked || !f.c2.checked || !f.c3.checked) throw new Error('Please confirm the three safety checks');
      const kit = {}; KIT.forEach((k) => { const n = +f['kit_' + k.id].value; if (n) kit[k.id] = n; });
      await rpc('book_open_gym', { p_date: f.date.value, p_start: f.start.value, p_minutes: +f.dur.value, p_focus: f.focus.value, p_plan: f.plan.value.trim(), p_kit: kit, p_injury: f.injury.value.trim(), p_buddy: f.buddy.value.trim(), p_safety: true, p_edit: f.edit.value || null });
      closeSheet(); toast(`Open Gym booked: ${fmtD(f.date.value)} ${f.start.value}`, 'good'); await refresh();
    }),
    score: act(async (f) => {
      const type = f.type.value, key = f.key.value; let raw;
      if (type === 'time') { const a = +f.a.value, b = +f.b.value; if (isNaN(a) || isNaN(b) || b > 59 || f.a.value === '') throw new Error('Enter minutes and seconds'); raw = a + ':' + pad(b); }
      else if (type === 'rounds') { const a = parseInt(f.a.value), b = parseInt(f.b.value || '0'); if (isNaN(a)) throw new Error('Enter rounds'); raw = a + '+' + (b || 0); }
      else { const a = parseFloat(f.a.value); if (isNaN(a)) throw new Error('Enter a number'); raw = String(a); }
      const div = f.querySelector('[name=div]:checked').value; const [date, track, sid] = key.split('|');
      await run(sb.from('scores').upsert({ member_id: S.meId, prog_date: date, track, section_id: sid, raw, division: div, note: f.note.value.trim() }, { onConflict: 'member_id,prog_date,track,section_id' }));
      UI.lbDiv = div; closeSheet(); toast('Score logged', 'good'); await refresh();
    }),
    pr: act(async (f) => {
      const k = f.k.value, t = f.k.selectedOptions[0].dataset.t; let v;
      if (t === 'time') { const m = f.v.value.match(/^(\d+):(\d{1,2})$/); if (!m) throw new Error('Use mm:ss for times'); v = +m[1] * 60 + +m[2]; } else { v = parseFloat(f.v.value); if (isNaN(v)) throw new Error('Enter a number'); }
      const prev = pr(S.meId, k);
      await run(sb.from('prs').insert({ member_id: S.meId, name: k, kind: t, value: v, pr_date: f.d.value || TODAY() }));
      closeSheet(); toast(!prev || (t === 'time' ? v < prev.v : v > prev.v) ? `New ${k} PR!` : `${k} logged`, 'good'); await refresh();
    }),
    editMe: act(async (f) => {
      const [first, ...rest] = f.name.value.trim().split(/\s+/);
      await run(sb.from('profiles').update({ first_name: first || '', last_name: rest.join(' '), dob: f.dob.value || null, email: f.email.value.trim(), phone: f.phone.value.trim(), address: f.address.value.trim(), postcode: f.postcode.value.trim(), injuries: f.injuries.value.trim(), goals: f.goals.value.trim(), ec_name: f.ecn.value.trim(), ec_relationship: f.ecr.value.trim(), ec_phone: f.ecp.value.trim() }).eq('id', f.id.value));
      toast('Details saved', 'good'); if (isStaff() && f.id.value !== S.meId) { await refresh(); sheet(shMember, f.id.value); } else { closeSheet(); await refresh(); }
    }),
    plan: act(async (f) => {
      const id = f.querySelector('[name=plan]:checked').value, target = f.id.value;
      if (isStaff() && target !== S.meId) {
        const p = plan(id);
        await run(sb.from('profiles').update({ plan_id: id, status: 'active', ...(p.pack ? { credits: p.pack, credits_expire: ymd(add(t0(), p.valid || 30)) } : {}) }).eq('id', target));
        toast('Plan changed in the app. Billing is unchanged: the member switches or pays in their app.', 'good'); await refresh(); sheet(shMember, target); return;
      }
      const r = await fn('stripe-checkout', { plan_id: id });
      if (r.url) { toast('Opening secure checkout…'); location.href = r.url; return; }
      closeSheet(); toast('Plan switched. The change shows on your next payment.', 'good'); await refresh();
    }),
    freeze: act(async (f) => { await fn('stripe-portal', { action: 'freeze', until: f.until.value, reason: f.why.value, member_id: f.id.value }); closeSheet(); toast('Frozen until ' + fmtD(f.until.value, { day: 'numeric', month: 'short' }) + '. Payments pause until then.', 'good'); await refresh(); }),
    taster: act(async (f) => {
      const inst = f.inst.value || null; const [date, tid] = inst ? splitInst(inst) : [null, null];
      if (UI.leadEdit) {
        await run(sb.from('leads').update({ name: f.name.value.trim(), phone: f.phone.value.trim(), email: f.email.value.trim(), interest: f.interest.value, experience: f.exp.value, class_date: date, timetable_id: tid, status: inst ? 'booked' : 'new' }).eq('id', UI.leadEdit));
        UI.leadEdit = null;
      } else {
        await rpc('submit_taster', { p_name: f.name.value.trim(), p_email: f.email.value.trim(), p_phone: f.phone.value.trim(), p_interest: f.interest.value, p_experience: f.exp.value, p_class_date: date, p_tt: tid, p_consent: f.consent.checked });
      }
      closeSheet(); toast(inst ? 'Taster booked. The gym will be in touch to confirm.' : 'Thanks! The gym will be in touch.', 'good');
      if (window.HOW_SIGNED_IN) await refresh();
    }),
    join: act(async (f) => {
      const J = UI.join, d = J.data, fd = new FormData(f);
      for (const k of new Set([...fd.keys()])) { const allv = fd.getAll(k); d[k] = k === 'goals' || k === 'times' ? allv : allv[0]; }
      if (J.step === 3) { d.goals = fd.getAll('goals'); d.times = fd.getAll('times'); }
      if (J.step === 4) { d.photo = f.photo.checked; d.mkt = f.mkt.checked; d.w1 = f.w1.checked; }
      if (J.step < 5) { J.step++; drawSheet(); $('#sheet .sheet').scrollTop = 0; return; }
      const parq = {}; PARQ.forEach((q, i) => (parq['q' + i] = d['q' + i]));
      const meta = {
        first_name: d.first, last_name: d.last, phone: d.phone, dob: d.dob, address: `${d.address}, ${d.town}`, postcode: d.postcode,
        ec_name: d.ecn, ec_relationship: d.ecr, ec_phone: d.ecp, injuries: d.injuries || '', goals: (d.goals || []).join(', '), experience: d.exp,
        preferred_times: d.times || [], heard_from: d.src, parq, parq_flag: PARQ.some((q, i) => d['q' + i] === 'y'),
        waiver_signed: true, waiver_signature: d.sig, waiver_version: '2026-11', photo_consent: !!d.photo, marketing_consent: !!d.mkt, chosen_plan: d.plan || 'intro',
      };
      const { data, error } = await sb.auth.signUp({ email: d.email.trim(), password: d.password, options: { data: meta, emailRedirectTo: location.origin + location.pathname } });
      if (error) throw new Error(error.message);
      if (!data.session) { closeSheet(); renderAuth(`Nearly there. We've emailed <b>${esc(d.email)}</b> a link to confirm your address. Open it, sign in, and you'll go straight to payment.`); return; }
      toast('Account created. Opening secure checkout…', 'good');
      const r = await fn('stripe-checkout', { plan_id: d.plan || 'intro' });
      location.href = r.url;
    }),
    cancelCls: act(async (f) => { const [date, tid] = splitInst(f.id.value); const n = await rpc('staff_cancel_class', { p_date: date, p_tt: tid, p_reason: f.why.value }); closeSheet(); toast(`Class cancelled. ${n} members notified.`, 'good'); await refresh(); }),
    tt: act(async (f) => {
      const data = { weekday: +f.day.value, start_time: f.time.value, type: f.type.value, coach: f.coach.value, capacity: Math.max(1, +f.cap.value || 16) };
      if (f.id.value) await run(sb.from('timetable').update(data).eq('id', f.id.value)); else await run(sb.from('timetable').insert(data));
      closeSheet(); toast('Timetable updated', 'good'); await refresh();
    }),
    nudge: act(async (f) => { await run(sb.from('notifications').insert({ member_id: f.id.value, body: f.msg.value })); closeSheet(); toast('Sent', 'good'); }),
    import: act(async (f) => {
      const rows = f.csv.value.trim().split(/\r?\n/).map((ln) => ln.split(',').map((x) => x.trim().replace(/^"|"$/g, ''))).filter((c, i) => c[0] && !(i === 0 && /name/i.test(c[0]))).map((c) => ({ name: c[0], email: c[1], phone: c[2], plan: c[3] }));
      const r = await fn('members-import', { rows });
      const okN = r.results.filter((x) => x.ok).length, bad = r.results.filter((x) => !x.ok);
      closeSheet(); toast(`${okN} invited${bad.length ? `, ${bad.length} skipped (${bad.slice(0, 2).map((b) => b.email + ': ' + b.detail).join('; ')})` : ''}`, bad.length ? '' : 'good'); await refresh();
    }),
    lvInvite: act(async (f) => {
      const r = await fn('members-import', { rows: [{ name: f.name.value, email: f.email.value, phone: f.phone.value, plan: f.plan.value }] });
      if (!r.results[0]?.ok) throw new Error(r.results[0]?.detail || 'Invite failed');
      closeSheet(); toast(`Invite sent to ${f.email.value}`, 'good'); await refresh();
    }),
    lvDoor: act(async (f) => {
      const v = (n) => f[n]?.value || '';
      const body = { action: 'configure', provider: v('provider'), door_mode: v('mode'), radius: v('radius'), gym_lat: v('gym_lat'), gym_lng: v('gym_lng'), door_webhook_url: v('url'), shelly_server: v('server'), shelly_auth_key: v('authkey'), shelly_device_id: v('device'), shelly_channel: v('channel'), switchbot_token: v('sbtoken'), switchbot_secret: v('sbsecret'), switchbot_device_id: v('sbdevice') };
      const r = await fn('door-access', body);
      UI.doorLoc = null; toast('Door settings saved', 'good');
      if (r.webhook_secret) sheet(() => ({ title: 'Webhook signing secret', body: `<div class="small ink2">Your receiver can check the X-HOW-Signature header (HMAC-SHA256 of the body) with this secret.</div><div class="card mt" style="word-break:break-all;font-family:monospace">${esc(r.webhook_secret)}</div>` }));
      await refresh();
    }),
    lvLegal: act(async (f) => { await run(sb.from('settings').update({ legal_name: f.legal.value, ico_number: f.ico.value, contact_email: f.email.value, address: f.address.value, show_attendee_names: f.names.checked }).eq('id', 1)); toast('Saved', 'good'); await refresh(); }),
  });

  Object.assign(CH, {
    switchMe: () => {},
    coach: act(async (el) => { const [date, tid] = splitInst(el.dataset.v); await run(sb.from('class_overrides').upsert({ class_date: date, timetable_id: tid, coach: el.value }, { onConflict: 'class_date,timetable_id' })); toast('Coach updated'); await refresh(); }),
    mNotes: act(async (el) => { await run(sb.from('staff_notes').upsert({ member_id: el.dataset.v, notes: el.value, updated_at: new Date().toISOString() })); toast('Note saved'); }),
    ogWin: act(async (el) => {
      const d = +el.dataset.v; const w = el.value.split(',').map((s) => s.trim()).filter(Boolean).map((s) => s.split('-').map((x) => x.trim()));
      if (w.some((x) => x.length !== 2 || !/^\d{1,2}:\d{2}$/.test(x[0]) || !/^\d{1,2}:\d{2}$/.test(x[1]) || tm(x[0]) >= tm(x[1]))) throw new Error('Use the format 10:30-12:00');
      await run(sb.from('og_windows').delete().eq('weekday', d));
      if (w.length) await run(sb.from('og_windows').insert(w.map((x) => ({ weekday: d, start_time: hm(tm(x[0])), end_time: hm(tm(x[1])) }))));
      toast('Open Gym hours saved', 'good'); await refresh();
    }),
    bName: act(async (el) => { await run(sb.from('settings').update({ gym_name: el.value || 'House of Wolves' }).eq('id', 1)); await refresh(); }),
    accent: act(async (el) => { await run(sb.from('settings').update({ accent: el.value }).eq('id', 1)); await refresh(); }),
    logo: (el) => { const file = el.files[0]; if (!file) return; const rd = new FileReader(); rd.onload = () => { const img = new Image(); img.onload = act(async () => { const c = document.createElement('canvas'); c.width = c.height = 128; const x = c.getContext('2d'); const s = Math.min(img.width, img.height); x.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, 128, 128); await run(sb.from('settings').update({ logo_url: c.toDataURL('image/png') }).eq('id', 1)); toast('Logo updated', 'good'); await refresh(); }); img.src = rd.result; }; rd.readAsDataURL(file); },
    cfg: act(async (el) => { const map = { lateHrs: 'late_cancel_hours', ahead: 'book_ahead_days', ogCap: 'og_capacity', introRemind: 'intro_remind_days', release: 'release_time' }; const k = map[el.dataset.v]; if (!k) return; await run(sb.from('settings').update({ [k]: el.dataset.v === 'release' ? el.value : Math.max(0, +el.value) }).eq('id', 1)); toast('Saved'); await refresh(); }),
    cfgB: act(async (el) => { if (el.dataset.v === 'autoPromote') await run(sb.from('settings').update({ auto_promote: el.checked }).eq('id', 1)); toast('Saved'); }),
    lvProvider: (el) => { UI.doorProvider = el.value; render(); },
  });

  /* ---------------- live-only screens ---------------- */

  Live.accountCard = function () {
    const m = me();
    return `<div class="card"><span class="lbl">Account</span><div class="list">
      ${m.hasBilling ? '<div class="li"><div class="grow small">Payment details, invoices and cancelling</div><button class="btn sm" data-a="portal">Manage billing</button></div>' : ''}
      ${window.HOW_INSTALL ? '<div class="li"><div class="grow small">Add the app to your home screen</div><button class="btn sm p" data-a="install">Install</button></div>' : (/iphone|ipad/i.test(navigator.userAgent) && !navigator.standalone ? '<div class="li small ink2">To install on iPhone: tap Share, then Add to Home Screen.</div>' : '')}
      <div class="li"><div class="grow small">Download everything we hold about you</div><button class="btn sm" data-a="exportData">Download</button></div>
      <div class="li"><div class="grow small"><a href="privacy.html">Privacy notice</a> · <a href="terms.html">Membership terms</a></div></div>
      <div class="li"><div class="grow small">Signed in as ${esc(m.email)}</div><button class="btn sm" data-a="signOut">Sign out</button></div>
      <div class="li"><div class="grow small muted">Close your account and delete your data</div><button class="btn sm danger" data-a="deleteAccount">Delete</button></div>
    </div></div>`;
  };

  Live.settingsCards = function () {
    const st = Live.settings || {};
    const prov = UI.doorProvider || st.door_provider || 'none';
    const owner = myProfile?.role === 'owner';
    if (!owner) return '<div class="card"><span class="lbl">Owner settings</span><div class="small muted">Payments, door access and legal details are managed by the owner.</div></div>';
    return `<div class="card"><span class="lbl">Payments (Stripe)</span>
      <div class="small ink2">Creates the products and prices for every plan, the intro discount, the billing portal and the webhook. Run it once after adding your Stripe secret key, and again after changing a price.</div>
      <div class="row wrap mt">${PLANS.map((p) => `<span class="chip ${p.payable ? 'good' : 'warn'}">${esc(p.name)}${p.payable ? ' ✓' : ''}</span>`).join('')}</div>
      <button class="btn p mt" data-a="stripeSetup">${PLANS.every((p) => p.payable) ? 'Re-run Stripe setup' : 'Set up Stripe'}</button></div>
    <div class="card"><span class="lbl">Door buzzer</span><form data-f="lvDoor">
      <div class="small ink2">Members tap <b>Buzz me in</b> in the app. The system checks they're allowed in and at the gym, then the plug-in buzzes the door.</div>
      <label class="f"><span>Who can buzz in</span><select name="mode">${[['booked_only', 'Members booked into a class or Open Gym now'], ['active_members', 'Any active member'], ['off', 'Staff only']].map(([v, l]) => `<option value="${v}" ${st.door_mode === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="f"><span>Door plug-in</span><select name="provider" data-c="lvProvider">${[['none', 'None yet (log only)'], ['shelly_cloud', 'Shelly relay (Shelly Cloud)'], ['switchbot', 'SwitchBot Bot'], ['webhook', 'Other: webhook (Home Assistant, Smart Life via HA, IFTTT…)']].map(([v, l]) => `<option value="${v}" ${prov === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      ${prov === 'shelly_cloud' ? '<div class="g-ed"><label class="f"><span>Cloud server</span><input name="server" placeholder="https://shelly-xx-eu.shelly.cloud"></label><label class="f"><span>Auth cloud key</span><input name="authkey" placeholder="Leave blank to keep the saved one"></label><label class="f"><span>Device ID</span><input name="device"></label><label class="f"><span>Channel</span><input name="channel" value="0"></label></div><div class="tiny muted">In the Shelly app, set the relay\'s auto-off timer to about 5 seconds.</div>' : ''}
      ${prov === 'switchbot' ? '<div class="g-ed"><label class="f"><span>Token</span><input name="sbtoken" placeholder="Leave blank to keep"></label><label class="f"><span>Secret</span><input name="sbsecret" placeholder="Leave blank to keep"></label><label class="f"><span>Bot device ID</span><input name="sbdevice"></label></div><div class="tiny muted">SwitchBot app: Profile > Preferences > tap App Version 10 times > Developer Options. Needs a SwitchBot Hub.</div>' : ''}
      ${prov === 'webhook' ? '<label class="f"><span>Webhook URL</span><input name="url" placeholder="https://… (leave blank to keep the saved one)"></label>' : ''}
      <div class="lbl mt2">Gym location</div>
      <div class="small ink2" id="lvLoc">${UI.doorLoc ? `Set to here (±${Math.round(UI.doorLoc.accuracy)} m). Press Save.` : st.gym_lat != null ? `Saved (${Number(st.gym_lat).toFixed(4)}, ${Number(st.gym_lng).toFixed(4)}). Members must be within ${st.door_radius_m} m to buzz.` : 'Not set: members can buzz from anywhere. Stand at the door and tap the button below.'}</div>
      <input type="hidden" name="gym_lat" value="${UI.doorLoc ? UI.doorLoc.lat.toFixed(6) : ''}"><input type="hidden" name="gym_lng" value="${UI.doorLoc ? UI.doorLoc.lng.toFixed(6) : ''}">
      <div class="row wrap mt"><button type="button" class="btn" data-a="lvHere">Use my current location</button><label class="f" style="margin:0;width:150px"><span>Distance (m)</span><input type="number" name="radius" min="30" max="2000" value="${st.door_radius_m || 150}"></label></div>
      <div class="row wrap mt"><button class="btn p">Save</button><button type="button" class="btn" data-a="doorTest">Test buzz</button></div>
      <div class="tiny muted mt">Every buzz is logged for 90 days. Staff can buzz from the dashboard at any time.</div></form></div>
    <div class="card"><span class="lbl">Legal details (shown on the privacy notice and terms)</span><form data-f="lvLegal">
      <label class="f"><span>Business legal name</span><input name="legal" value="${esc(st.legal_name || '')}"></label>
      <label class="f"><span>ICO registration number</span><input name="ico" value="${esc(st.ico_number || '')}"></label>
      <label class="f"><span>Contact email</span><input name="email" value="${esc(st.contact_email || '')}"></label>
      <label class="f"><span>Address</span><input name="address" value="${esc(st.address || '')}"></label>
      <label class="chk"><input type="checkbox" name="names" ${st.show_attendee_names ? 'checked' : ''}> Show members' first names on class lists</label>
      <button class="btn p">Save</button></form></div>`;
  };

  function shInvite() {
    return { title: 'Invite a member', body: `<form data-f="lvInvite"><div class="small ink2">They get an email to set a password, then choose and pay for their plan in the app.</div>
      <label class="f"><span>Full name</span><input name="name" required></label><label class="f"><span>Email</span><input type="email" name="email" required></label><label class="f"><span>Mobile</span><input name="phone"></label>
      <label class="f"><span>Plan (optional)</span><select name="plan"><option value="">Let them choose</option>${PLANS.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></label>
      <div class="foot"><button class="btn p block">Send invite</button></div></form>` };
  }
  window.shImport = function () {
    return { title: 'Import members', body: `<div class="small ink2">Moving from StreamFit or another system? Export members as CSV and paste below. Columns: <b>name, email, phone, plan</b>. Everyone gets an email invite to set a password, then picks and pays for their plan in the app. Existing Direct Debits can't be moved across.</div>
      <form data-f="import"><label class="f"><span>CSV</span><textarea name="csv" rows="7" placeholder="name,email,phone,plan&#10;Iain Murray,iain@example.com,07700 900123,CFHOW Unlimited"></textarea></label><div class="foot"><button class="btn p block">Send invites</button></div></form>` };
  };

  // The join flow's first step offers every plan; once signed in, packs/drop-ins are bought the same way.
  const baseShPlan = window.shPlan;
  window.shPlan = function (mid) {
    const r = baseShPlan(mid);
    if (!mid || mid === S.meId) r.body = r.body.replace('Monthly plan changes take effect immediately and are prorated on your next payment.', 'You\'ll pay securely with Stripe by card or Direct Debit. Switching between monthly plans is prorated on your next payment.');
    return r;
  };

  boot();
})();
