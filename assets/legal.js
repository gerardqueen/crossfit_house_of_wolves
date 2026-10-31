// Fills the gym's details into the legal pages from the live settings, and flags unfilled placeholders.
(async function () {
  const cfg = window.HOW_CONFIG || {};
  let s = null;
  if (cfg.supabaseUrl && cfg.supabaseAnonKey) {
    try {
      const r = await fetch(cfg.supabaseUrl.replace(/\/$/, '') + '/rest/v1/settings?id=eq.1&select=*', { headers: { apikey: cfg.supabaseAnonKey } });
      s = (await r.json())[0] || null;
    } catch (e) { /* offline: keep placeholders */ }
  }
  document.querySelectorAll('[data-s]').forEach((el) => { const v = s && s[el.dataset.s]; if (v) el.textContent = v; });
  if (!s || /^\[/.test(s.legal_name || '[') || /^\[/.test(s.ico_number || '[')) {
    const d = document.querySelector('.draft'); if (d) d.hidden = false;
  }
})();
