# Door buzzer

Members tap **Buzz me in** in the app. The system checks they're allowed in right now and standing at the gym,
then tells the door plug-in to buzz the door open. There's no scanner or pass to show.

## Who can buzz in

Set in **Coach → Settings → Door buzzer**:

| Setting | Who it lets in |
|---|---|
| Members booked into a class or Open Gym now | From 30 min before a class to 15 min after it starts, or 15 min before an Open Gym slot until it ends. Buzzing in also checks them in. |
| Any active member | Anyone with an active membership (not frozen, not overdue) |
| Staff only | Coaches and the owner |

Coaches and the owner can always buzz, and have **Buzz door** on the dashboard for letting people in from the desk.
Repeated taps within 8 seconds don't buzz again. Every buzz, allowed or not, is logged for 90 days.

## Location check

Stand at the door, open **Settings → Door buzzer → Use my current location**, and **Save**. From then on, members must be
within the set distance (150 m by default, plus a little extra for poor GPS indoors) to buzz. The phone shares its location
once per tap; only the result is stored. Until a location is saved, members can buzz from anywhere.

## Plug-ins

| Plug-in | What it needs | Notes |
|---|---|---|
| **Shelly relay** (e.g. Shelly Plus 1) | Wired across the door release or buzzer button by an electrician, connected to Shelly Cloud | Enter the cloud server and auth cloud key (Shelly app → Settings → Authorization cloud key) and the device ID. Set the relay's **auto-off timer** to about 5 seconds so the door locks again by itself. |
| **SwitchBot Bot** | A SwitchBot Bot stuck on the existing door-release button, plus a SwitchBot Hub | Enter the token and secret (SwitchBot app → Profile → Preferences → tap App Version 10 times → Developer Options) and the Bot's device ID. No wiring needed. |
| **Webhook** | Anything that accepts a web request: Home Assistant, Node-RED, IFTTT, Zapier/Make | The system POSTs `{"event":"buzz","member":"…","reason":"…","at":"…"}` with an `X-HOW-Signature` header (HMAC-SHA256 of the body, with the secret shown when you save). Use this for Tuya / Smart Life plugs through Home Assistant, or for an access-control system with webhooks. |
| **None yet** | Nothing | Rules and logging work; nothing physically buzzes. Good for testing. |

Use **Test buzz** in Settings to check the wiring.

## Adding a different device

Add a case to `supabase/functions/door-access/unlock.ts` that calls the device's API, and add it to the list in Settings.
Everything else (rules, location check, logging) stays the same.

## Safety

- The release must fail safe (unlock on power loss or fire alarm) and the door must open from inside without the app. Use a qualified installer.
- Keep a key or keypad code for staff in case the internet or the plug-in is down.
