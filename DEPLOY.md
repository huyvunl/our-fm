# Deploying Our FM

The owner does these steps once, in this order, in about 15 minutes. You need:
your Spotify Premium login, a Railway account on the Hobby plan (about $5/month),
and the speaker iPhone.

Pick the office passcode now: at least 8 characters. Colleagues type it once
per browser.

## Test on your own PC first (no Railway, about 10 minutes)

Use this to try Our FM yourself before it goes to the office. Only your PC can open it.

1. **Spotify app.** Do step 2 below, but use this Redirect URI instead:
   `http://127.0.0.1:3000/auth/callback`
2. **Settings.** Open the `.env` file in the project folder (copy `.env.example` to `.env` if it
   is missing). Paste your **Client ID** and **Client secret**, and set `OFFICE_PASSCODE` to
   at least 8 characters. Leave `SPOTIFY_REDIRECT_URI` as it is. Never commit `.env`.
3. **Start.** In the project folder run `npm install` once, then `npm run dev`.
   Leave that window open; closing it stops Our FM.
4. **Play device.** Open the Spotify desktop app on the PC (or on the iPhone) and play any
   song for a second so Spotify sees the device.
5. **Connect.** Open `http://127.0.0.1:3000` and type the passcode. Then open
   `http://127.0.0.1:3000/auth/login` and approve Spotify. Then search, queue songs, and try skip votes with two names in two browsers.

When you move to Railway later, follow the steps below and add the Railway redirect URI
to the same Spotify app.

## 1. Railway: create the project and get its URL

1. On [railway.com](https://railway.com), click **New Project → Deploy from GitHub repo** and pick `our-fm`.
   The first deploy fails because the variables aren't set yet. That's expected.
2. Open the service, then **Settings → Networking → Generate Domain**.
   Copy the URL. It looks like `https://our-fm-production.up.railway.app`.

## 2. Spotify: create the developer app

1. On [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard), click **Create app**.
   - App name and description: anything, e.g. `Our FM`.
   - Redirect URI: your Railway URL followed by `/auth/callback`, for example
     `https://our-fm-production.up.railway.app/auth/callback`. Click **Add**.
   - APIs used: tick **Web API**.
   - Accept the terms and click **Save**.
2. Open **Settings**. Copy the **Client ID**, then click **View client secret** and copy that too.

## 3. Railway: add storage and settings

1. In the project canvas, right-click (or press ⌘K / Ctrl+K), choose **Add Volume**,
   attach it to the `our-fm` service, and set the mount path to `/data`.
2. Open the service's **Variables → Raw Editor**, paste the block below with your
   own values, and click **Update Variables**:

   ```
   OFFICE_PASSCODE=choose-a-passcode
   SPOTIFY_CLIENT_ID=paste-client-id
   SPOTIFY_CLIENT_SECRET=paste-client-secret
   SPOTIFY_REDIRECT_URI=https://our-fm-production.up.railway.app/auth/callback
   DB_PATH=/data/our-fm.db
   SPOTIFY_DEVICE_NAME=
   ```

   `SPOTIFY_REDIRECT_URI` must match the Spotify dashboard value character for character.
   You can leave `SPOTIFY_DEVICE_NAME` empty (see step 5).
3. Click **Deploy** to apply the changes. When the deployment shows **Active**, the server is running.

## 4. iPhone: prepare the speaker phone

1. Pair the iPhone with the Bluetooth speaker.
2. Open Spotify and sign in with the **same Spotify account** you use in step 5.
3. In Spotify, open **Settings → Playback** and turn **Autoplay** off. Otherwise Spotify
   adds its own songs when the queue runs out.
4. In iOS, open **Settings → Display & Brightness → Auto-Lock** and choose **Never**.
   Keep the phone charging.
5. Leave Spotify open in the foreground. Play any song once, then pause it,
   so Spotify registers the phone as a device.

## 5. Connect Spotify (one time)

1. Open your Railway URL, enter the passcode, then enter your name.
2. Go to `https://<your-railway-url>/auth/login`, sign in to Spotify as the owner,
   and click **Agree**. You land back on Our FM. The "Spotify isn't connected" banner disappears.
   - This page only works while Spotify isn't connected, so a colleague can't swap accounts later.
3. Optional: if more than one Spotify device can appear (e.g. your laptop), set
   `SPOTIFY_DEVICE_NAME` in Railway to the iPhone's name exactly as Spotify shows it
   in its **Devices** list. That is usually the name under iOS **Settings → General → About → Name**.
   Without it, Our FM uses the first available device.

Share the URL and passcode with colleagues. Done.

## If something is off

| Banner on the page | What to do |
|---|---|
| Open Spotify on the speaker iPhone | Unlock the iPhone and bring Spotify to the foreground. Our FM retries every 3 seconds. |
| Spotify isn't connected yet — owner: open /auth/login | Do step 5.2 again. This happens if access was revoked. |
| An error message | It comes from Spotify. A 403 usually means the account lost Premium, or the Spotify app isn't the owner's. |

To switch Spotify accounts: remove **Our FM** at [spotify.com/account/apps](https://www.spotify.com/account/apps).
The next time it plays, Our FM shows the "not connected" banner, and you can repeat step 5.

To change the passcode, edit `OFFICE_PASSCODE` in Railway. This logs everyone out.

Ten wrong passcodes within 15 minutes from the office network block new logins
from that network for 15 minutes, because the office shares one public IP.
Browsers that are already logged in keep working.

If `SPOTIFY_DEVICE_NAME` is set but that device isn't available, Our FM falls back
to the first device it sees, which could be another device on your account.
Keep Spotify closed on your other devices during office hours if that matters.

The play history lives in `/data/our-fm.db` on the Railway volume and survives redeploys.
