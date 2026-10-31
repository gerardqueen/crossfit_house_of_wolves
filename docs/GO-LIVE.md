# Going live

The app runs as a demo until `config.js` has Supabase details. These steps switch it to the real system.
Allow about an hour the first time. Everything except step 1 can be done on a phone browser (use "Request desktop site").

## 0. GitHub Pages (once)

Repo **Settings → Pages → Deploy from a branch → `main` / `(root)` → Save**.
The app appears at `https://gerardqueen.github.io/crossfit_house_of_wolves/`.

## 1. Create the Supabase project

1. supabase.com → New project. Name it `house-of-wolves`, pick the **London (eu-west-2)** region, and save the database password somewhere safe.
2. Free plan is fine for building and the pilot. Move to Pro before real members join (the free plan pauses quiet projects).
3. **Project Settings → API**: copy the **Project URL** and the **anon public** key.

## 2. Connect GitHub to Supabase (deploys everything for you)

In this repo: **Settings → Secrets and variables → Actions**.

| Type | Name | Value |
|---|---|---|
| Variable | `SUPABASE_PROJECT_REF` | the letters in your Project URL, e.g. `abcdefghijklmnop` |
| Secret | `SUPABASE_ACCESS_TOKEN` | Supabase → your avatar → Account → Access tokens → Generate |
| Secret | `SUPABASE_DB_PASSWORD` | the database password from step 1 |
| Secret | `STRIPE_SECRET_KEY` | Stripe → Developers → API keys. Start with `sk_test_…` |

Then **Actions → Deploy Supabase → Run workflow**. This creates the tables and rules, loads the plans, class types,
kit and sample timetable, saves the Stripe key and deploys the six functions. After this, any change in `supabase/` deploys itself.

No GitHub Actions? Paste `supabase/migrations/20261101000000_init.sql` then `supabase/seed.sql` into **SQL Editor → Run**,
add `STRIPE_SECRET_KEY` under **Edge Functions → Secrets**, and deploy the functions with the Supabase CLI
(`npx supabase functions deploy --project-ref <ref>`).

## 3. Point the app at Supabase

Edit `config.js` in this repo and paste the Project URL and anon key. Commit. The site switches to live mode within a minute.

## 4. Sign-in settings

Supabase → **Authentication → URL Configuration**:

- **Site URL**: `https://gerardqueen.github.io/crossfit_house_of_wolves/`
- **Redirect URLs**: add the same address (and the gym's own domain later).

**Authentication → Providers → Email**: leave "Confirm email" on. New members confirm their email, sign in, and go straight to payment.
Supabase's built-in email is rate-limited, so before launch add your own sender under **Authentication → Emails → SMTP** (Resend works well).

## 5. Make the owner account

1. Open the app, tap **New here → Join now**, and sign up with the owner's email (pick any plan, then close the payment page).
2. Supabase → **SQL Editor**, run:

```sql
update profiles set role = 'owner', status = 'active' where email = 'owner@example.com';
-- coaches:
update profiles set role = 'coach', status = 'active' where email in ('coach1@example.com', 'coach2@example.com');
```

3. Sign out and back in. The **Coach** switch appears in the header.

## 6. Payments

1. Stripe → **Settings → Payment methods**: switch on **Cards** and **Bacs Direct Debit**.
2. In the app: **Coach → Settings → Set up Stripe**. This creates every plan's price, the intro discount, the billing portal and the webhook. The plan chips turn green.
3. Test a sign-up with Stripe's test card `4242 4242 4242 4242`, any future date, any CVC.
4. When ready for real money: replace the `STRIPE_SECRET_KEY` secret with `sk_live_…`, re-run the workflow, then press **Set up Stripe** again.

## 7. Legal details

**Coach → Settings → Legal details**: add the business's legal name and ICO registration number. The privacy notice and
terms fill these in automatically and the draft warning disappears. Have both pages reviewed, and decide the items marked
"[gym to confirm]" in the terms (minimum term, notice period).

## 8. Daily housekeeping

Supabase → **Database → Extensions → pg_cron → Enable**, then in SQL Editor:

```sql
select cron.schedule('how-daily', '0 2 * * *', 'select public.daily_housekeeping()');
```

This unfreezes members, marks no-shows, expires old credits, moves intro members to Unlimited, and deletes data on schedule.

## 9. Door buzzer (optional)

See [door-access.md](door-access.md).

## 10. Moving members from StreamFit

Export members from StreamFit as CSV with columns `name, email, phone, plan`. **Coach → Members → Import CSV**.
Each person gets an email invite, sets a password, then picks and pays for their plan. Existing Direct Debits can't be
transferred, so give members a date to switch by and keep StreamFit running for a month alongside.

## Costs

| Item | Cost |
|---|---|
| Supabase | Free while building; Pro $25/month for the live gym |
| Stripe | Per payment, no monthly fee (see Stripe's UK pricing) |
| GitHub Pages | Free |
| Email sending (Resend) | Free up to 3,000 emails/month |
| Domain (optional) | about £10/year |
