# Deploying Our FM

The owner does these steps once, in this order, in about 15 minutes. You need:
your Spotify Premium login, a Railway account on the Hobby plan (about $5/month),
and the speaker iPhone.

Pick the office passcode now: at least 8 characters. Colleagues type it once
per browser.

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

The play history lives in `/data/our-fm.db` on the Railway volume and survives redeploys.
