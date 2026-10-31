# Door access

Members open the app, tap **Door pass**, and show a QR code that changes every 30 seconds (so screenshots don't work).
A tablet by the door scans it and the system decides whether to let them in.

## Who gets in

Set in **Coach → Settings → Door access**:

| Mode | Who's let in |
|---|---|
| Members booked into a class or Open Gym now | From 30 min before a class to 15 min after it starts, or 15 min before an Open Gym slot until it ends. Scanning also checks them in. |
| Any active member | Anyone with an active membership (not frozen, not overdue) |
| Staff only | Coaches and the owner |

Coaches and the owner are always let in. Every attempt is logged for 90 days.

## The scanner

1. Any Android tablet or old phone with Chrome, mounted by the door, plugged in.
2. Open `https://gerardqueen.github.io/crossfit_house_of_wolves/door.html`.
3. In the app: **Coach → Settings → Door access → Scanner key**. Paste the key into the tablet once.
4. Optional: a USB or Bluetooth QR scanner also works. It types the code into the page automatically.

The screen goes green with the member's name, or red with the reason (no booking, membership frozen, pass expired).

## Opening the lock

Pick how the door actually unlocks:

| Option | What you need | How it works |
|---|---|---|
| **Nothing** | Nothing | The tablet shows green or red; staff open the door. Good for day one. |
| **Shelly relay** | A Shelly relay (e.g. Shelly Plus 1) wired to the maglock or strike by an electrician, connected to the Shelly Cloud | The system switches the relay on. Set the relay's **auto-off timer** to about 5 seconds in the Shelly app so the lock re-engages. Enter the cloud server, auth key (Shelly app → Settings → Authorization cloud key) and device ID. |
| **Webhook** | Anything that can receive a web request: Home Assistant, Node-RED, Zapier/Make, or an access system with webhooks | The system POSTs `{ "event": "unlock", "member": "...", "reason": "...", "at": "..." }` with an `X-HOW-Signature` header (HMAC-SHA256 of the body, using the secret shown when you save). |

Use **Test unlock** in Settings to check it.

Members can also tap **Open the door from here** on their pass, which follows the same rules. Staff have **Open door** on the dashboard.

## Adding another lock system

Kisi, Salto KS, Paxton Net2 and similar systems have their own APIs. Add a case to
`supabase/functions/door-access/unlock.ts` that calls the system's unlock endpoint, and add it to the provider list.
The rest (passes, rules, logging, scanner) stays the same.

## Safety

- The lock must fail safe (release on power loss or fire alarm) and have a manual exit. Use a qualified installer.
- Keep a physical key or code for staff in case the internet is down.
