# Installing the GC shell on the pilot Android phone (M0 check)

**Goal:** prove that the Game Command app installs on the pilot phone and opens with **no signal at all**
(airplane mode). This is the M0 "definition of done" (Section 7).

**Why there are two options:** Android only installs an offline-capable web app from a **secure** address:
either `https://…` or `localhost`. Until the Vercel preview exists (DECISIONS.md D-002, D-003) there is no
`https` address, so Option A uses a USB cable to make the PC's app appear as `localhost` on the phone.

You need: the pilot phone with **Google Chrome** (updated from the Play Store).

---

## Option A — today, over a USB cable (no cloud accounts needed)

### On the PC (one time)

1. Open PowerShell in the project folder and run:

   ```powershell
   npm install
   ```

   ```powershell
   npm run build
   ```

   ```powershell
   npm run preview
   ```

   Leave this window open. It serves the app at `http://localhost:4173`.

### On the phone (one time): turn on USB debugging

1. **Settings → About phone →** tap **Build number** 7 times until it says "You are now a developer".
   (On Samsung: Settings → About phone → Software information → Build number.)
2. **Settings → System → Developer options →** turn on **USB debugging**.
3. Plug the phone into the PC with a data cable. On the phone, tap **Allow** on the "Allow USB debugging?" prompt.

### Link the phone to the PC

1. On the PC, open Google Chrome and go to `chrome://inspect/#devices`.
2. Your phone should appear in the list. Click **Port forwarding…**
3. Add a rule: Port **4173** → `localhost:4173`. Tick **Enable port forwarding** and click **Done**.

### Install the app

1. On the phone, open Chrome and go to `http://localhost:4173`.
   You should see **"Driver app — M0 shell"** and a green **Online** pill.
2. Wait about 10 seconds (the app is saving itself for offline use), then pull down to refresh once.
3. Tap Chrome's **⋮** menu → **Install app** (on some phones: **Add to Home screen → Install**).
4. A **GC** icon with a truck appears on the home screen.

### Airplane-mode check (the actual M0 test)

1. Open the app from the **home-screen icon** (not from Chrome). It opens full-screen, with no address bar.
2. Close it completely: open the recent-apps view and swipe it away.
3. **Unplug the USB cable.**
4. Turn on **Airplane mode**. Also make sure **Wi-Fi is off** and **Mobile data is off**.
5. Open the app from the home-screen icon again.

**Pass if:** the screen shows **"Driver app — M0 shell"**, the pill says **"Offline · 0 queued"**,
and there is no "No internet" / dinosaur page.
Write down the phone make, model and Android version (it goes into DECISIONS.md D-038).

6. Also try: restart the phone while still in airplane mode, then open the app. It should still open.
7. Turn airplane mode off when done.

> With Option A, the installed app belongs to the address `localhost:4173`. When we move to the Vercel
> address (Option B), uninstall this one and install the new one.

---

## Option B — after the staging/preview web address exists (Vercel)

1. On the phone, open Chrome and go to the `https://…vercel.app` address the agent gives you.
2. Follow **Install the app** and **Airplane-mode check** above (skip everything about USB).

---

## If something goes wrong

| What you see                                             | What to do                                                                                         |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| The phone does not appear in `chrome://inspect`          | Use a different cable (some only charge), re-tap **Allow** on the phone, check USB debugging is on |
| No **Install app** in the ⋮ menu                         | Make sure the address is exactly `http://localhost:4173` (not the PC's IP address); update Chrome  |
| Offline, it shows the dinosaur / "No internet" page      | Go online, open the app, wait 10 s, refresh once, close it, and repeat the airplane-mode check     |
| A yellow **Update available** bar appears                | Tap **Update**. (From M3 on, updates wait until all sales are synced.)                             |

Report the result (pass/fail, phone model, Android version, Chrome version) to the agent at the start of the next session.
