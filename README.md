# House of Wolves gym app

Member and coach app for CrossFit House of Wolves, Livingston. Installs on phones as an app (PWA), runs on GitHub Pages,
with Supabase for the database and sign-in, Stripe for payments, and an optional door-access system.

**Live site:** https://gerardqueen.github.io/crossfit_house_of_wolves/

## Two modes

- **Demo** (default): `config.js` is empty. Sample data, saved in the browser only. Good for showing the gym.
- **Live**: `config.js` has the Supabase URL and anon key. Real accounts, bookings and payments. See [docs/GO-LIVE.md](docs/GO-LIVE.md).

## What's in it

**Members (app-first):** join and pay (card or Direct Debit), class booking with plan rules, waitlists that book you in automatically,
late-cancel rules, check-in, Open Gym with kit booking, buzz the door from the app, whiteboard with scaling and 1RM percentages, scores, leaderboards,
PRs, freeze, billing portal, data download and account deletion.

**Coaches and owner:** dashboard, check-in lists with injury flags, programming with scheduled release, TV whiteboard, timetable,
Open Gym board, members, invites and CSV import, taster leads, settings (brand, rules, Stripe, door buzzer, legal details).

## Layout

| Path | What it is |
|---|---|
| `index.html` | The app (screens, demo data) |
| `live.js` | Live mode: connects the screens to Supabase and the functions |
| `config.js` | Supabase URL and anon key (empty = demo) |
| `privacy.html`, `terms.html` | Privacy notice and membership terms (fill in from Settings) |
| `manifest.webmanifest`, `sw.js`, `icons/` | Install as an app, offline shell |
| `supabase/migrations/` | Tables, access rules, booking and Open Gym logic |
| `supabase/seed.sql` | Plans, class types, kit, sample timetable |
| `supabase/functions/` | `stripe-setup`, `stripe-checkout`, `stripe-webhook`, `stripe-portal`, `door-access` (buzzer), `account`, `members-import` |
| `.github/workflows/supabase-deploy.yml` | Deploys the database and functions from GitHub |
| `docs/` | Go-live steps, door access, data processing agreement template |

## Notes

- Booking rules (weekly limits, credits, capacity, waitlist, late cancels, Open Gym capacity and kit) are enforced in the database, not just the app.
- Members only ever see their own data. Coach notes are stripped from programming before members can read it.
- No card or bank details touch this app: Stripe Checkout and the Stripe billing portal handle them.
