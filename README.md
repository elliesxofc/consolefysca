# FYSC Console

A private admin app for the FYSC board that you install on your phone. It's a PWA (plain HTML, CSS and JS, with no build step), hosted on its own and talking to the fysca server over its token-protected `/admin/api` routes.

## What's in here

| File | What it is |
|---|---|
| `index.html`, `styles.css`, `app.js` | The app |
| `config.js` | Optional default server address |
| `manifest.json`, `sw.js`, `icons/` | What makes it installable, and lets it open offline |

## 1. Server setup (fysca)

The API lives in `fysca/adminApi.js` and is mounted from `server.js`. It won't let anyone sign in until you set a password. Do either one:

- Set the env var `FYSC_ADMIN_PASSWORD`, **or**
- create `fysca/admin_panel_secret.json`:

  ```json
  { "password": "something long", "jwtSecret": "any long random string" }
  ```

`jwtSecret` (or the env var `FYSC_ADMIN_JWT_SECRET`) keeps you signed in across server restarts. Without it, every restart signs the phone out.

Restart the server once so it loads `adminApi.js`. After that, you can change the password without another restart.

Keep `admin_panel_secret.json` private. Don't upload it anywhere public.

## 2. Host the app

Put everything in this folder on any static host with **HTTPS**, such as Cloudflare Pages, a subdomain on your tunnel, or Netlify. The app uses relative paths, so it works at the root or in a subfolder.

The fysca server also has to be reachable over **HTTPS**, because a page on https can't call an http:// server. CORS is already open on the server (`app.use(cors())`), so the cross-origin calls work.

To skip typing the server address on first sign-in, set `apiBase` in `config.js`.

## 3. Install on your phone

Open the app's URL, sign in, then:
- **Android (Chrome):** Settings tab, then **Install app**, or use the browser menu's **Install app**.
- **iPhone (Safari):** Share, then **Add to Home Screen**.

After that it opens full-screen with its own icon.

## What it does

- **Home:** the live announcement status, channel count, fastest-growing channel, the top 10, and a button to refresh every overlay.
- **Channels:** a searchable list of every channel. Tap one to rename it, set its sub count (with an undo), set its growth, or remove it. The **+** button adds a channel from a UC… ID or a channel link.
- **Announce:** post now, schedule for later, take down the live one, and see or cancel what's scheduled.
- **Settings:** the server, how long you stay signed in, install, and sign out.

Everything refreshes every 5 seconds while the app is open.

## Security notes

- Sign-in locks out after 5 wrong passwords from one IP, or 30 across all IPs, for 15 minutes. A session lasts 30 days.
- The password never reaches the phone. The phone only keeps the session token.
- **The legacy routes are still open.** `/rename/:cid`, `/removeChannel/:cid`, `/refresh` and `/api/public/fakecounts/postSubGain` accept anyone, and the other admin routes only check the `secretCode` that's visible in `admin.html`'s source. This app doesn't use them, but anyone who finds them still can. Locking them down is a separate change.

## Updating

`sw.js` is network-first, so a phone that's online always loads the newest files. Bump `CACHE_VERSION` in `sw.js` only if you add or rename shell files.
