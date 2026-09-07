# SiamShop desktop till (Electron) — SIAMSHOP-ELECTRON-001

Staff-only desktop app for a shop counter: opens on **Till**, nav is **Till · Prep · Admin**.
Customers never see this app — the website stays on the web. Cloud-only ("Path A"): the app
loads the built React client from disk and talks to the shop's SiamShop cloud (Railway). No
local database, no embedded server. Internet down = till down (a 4G failover router is the
recommended mitigation for the trial).

## What it adds on top of the web till
- **Staff PIN sign-in** (`staff` table, `POST /api/staff/login`). Roles: manager (everything),
  cashier (Till, Prep, stock scanner), prep (Prep only). Manager PIN or the owner password
  opens Admin. Every sale records who rang it. Create the first PIN: owner password →
  Admin → Staff.
- **Receipt printing + cash-drawer kick** from the Electron main process (`printService.js`,
  ported from the restaurant till): RAW 9100 → LPR 515 → IP-matched CUPS for network printers;
  CUPS / Windows spooler RAW for USB printers by name. Configure in **Admin → This device**
  (test page + drawer buttons there). Auto-print after each sale and drawer-on-cash are on by
  default.
- **First-run wizard**: shop name, cloud URL, shop ID, optional printer — with 📋 Paste
  buttons and **Load from config.json** for remote installs.
- **Auto-update** from the public repo `kongponsrisiri-coder/siamshop-releases`.

## Dev
```bash
npm install && (cd client && npm install) && (cd electron && npm install)
npm run electron          # builds client/dist-electron then launches Electron
# or against the Vite dev server:  cd client && npm run dev   +   cd electron && npm run start:dev
```
`electron/config.json` (git-ignored) is the dev install's config; in packaged builds it lives
in the OS userData folder `siamshop-electron` (folder name = package.json `name`, on purpose).

Example `config.json`:
```json
{ "shop_name": "Cha & Pinto Box", "cloud_api_url": "https://your-shop.up.railway.app",
  "shop_slug": "chapinto", "printer": { "ip": "192.168.1.50", "port": 9100, "autoPrint": true, "kickDrawerOnCash": true } }
```

## Release (Korakot / Krit)
1. Bump `electron/package.json` `version`. Tag `v<version>`, push the tag. Actions → Release.
2. Runner is **macos-14** on purpose (macos-latest broke electron-builder 25).
3. After it lands, the releases repo must show **8 assets**: dmg, zip, exe, 3 blockmaps,
   `latest-mac.yml`, `latest.yml`. Fewer = auto-update broken.
4. Secrets on this repo (uploaded by `scripts/siamshop-electron-bootstrap.py`, never pasted):
   `MAC_CERT_P12_BASE64 MAC_CERT_PASSWORD MAC_APPLE_ID MAC_APPLE_APP_PASSWORD MAC_TEAM_ID RELEASES_REPO_TOKEN`.
5. First install on any machine is manual; auto-update works from then on.
6. Canary on Korakot's Mac first, never in service hours.

## Install notes for the shop
- **Mac**: open the DMG, drag SiamShop to Applications, open it. Signed + notarised.
- **Windows**: the installer is **unsigned**. SmartScreen warns — click **More info → Run
  anyway**. New Windows 11 machines with *Smart App Control* ON will block it outright; turn
  SAC off (Settings → Privacy & security → Windows Security → App & browser control) before
  installing, or trial on Mac. A code-signing certificate fixes this properly (SEPOS-CODESIGN-001).
- Barcode scanning at the till is a USB scanner (keyboard wedge) into the search box. Camera
  scanning and AI invoice capture stay on the phone PWA (`/scan`).
- The app runs in the tray when the window is closed; **Quit** from the tray or **Exit** on
  the sign-in screen.

## Things Electron does differently (gotchas)
- `window.prompt()` is disabled — the app uses forms/modals instead.
- Client is built with base `./` and the hash router (`npm run build:electron-client` →
  `client/dist-electron`). The web build is untouched.
- API base + shop slug come from config.json (preload → `window.electron.config`), never from
  the build; every request carries `?shop=<slug>`.
