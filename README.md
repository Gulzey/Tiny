# Tiny

A small place to talk with friends. Tauri 2 provides the desktop window using the PC's system webview. A plain TypeScript interface keeps the client small. A Node.js server stores accounts, friends, and messages in a local SQLite file and sends live updates over WebSockets. Voice and screen video travel between participants through real WebRTC connections.

No paid hosting, Google account, SMS service, or external database is needed to try it on one PC.

## Install and share on Windows

The ready-to-send files are in **release**:

Download the installer and host package from [GitHub Releases](https://github.com/Gulzey/Tiny/releases/latest). Generated executables stay out of the source history.

- **Tiny-Setup.exe** goes to friends. Install and open Tiny; no development tools or command scripts are needed.
- **Tiny-Host.zip** goes only to the host. Extract it and double-click **Tiny-Server.exe**. No Node installation is needed on the host PC.
- [Sharing and hosting guide](docs/SHARING.md) explains server addresses, LAN/firewall setup, and connections outside your network.

Use **Dark mode** on the sign-in screen or at the bottom of the friends panel for the saved grey-blue theme. Background windows defer UI updates and pause incoming screen video while keeping voice connected. Active calls and screen capture still consume resources; use a release build for gaming.

## Run from source (developers)

Install **Node.js 24 LTS or newer** from [nodejs.org](https://nodejs.org/). Open PowerShell in this folder:

```powershell
git clone https://github.com/Gulzey/Tiny.git
cd Tiny
npm.cmd install
npm.cmd run seed
npm.cmd run build
npm.cmd run server
```

Keep that window open. In a **second PowerShell window**, in the same folder:

```powershell
npm.cmd start
```

This developer command opens the compiled Tauri app when `tiny.exe` is present. Otherwise it opens the built interface in an installed Microsoft Edge app window. If Edge cannot be found, open **http://127.0.0.1:8787** in current Chrome or Edge. Friends use the installer described above.

For the **Rust/Tauri desktop window**, install these one-time build tools:

- [Rust using rustup](https://www.rust-lang.org/tools/install), default Windows MSVC toolchain.
- [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/): select **Desktop development with C++**, with the Windows SDK.
- [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/), normally already on Windows 10/11.

Reopen PowerShell after installing tools so PATH refreshes. Keep the server running, then:

```powershell
npm.cmd run desktop
```

Tauri starts its own frontend development server automatically. To build a standalone executable and Windows installer:

```powershell
npm.cmd run build:desktop
```

The executable is `src-tauri\target\release\tiny.exe`; the installer goes in `src-tauri\target\release\bundle\nsis\`. These prerequisites follow the [official Tauri Windows guide](https://v2.tauri.app/start/prerequisites/). `npm.cmd run release` builds the client installer and standalone host EXE and puts the handoff files in `release`. `npm.cmd run test:server-exe` verifies that the server runs without Node/npm files. `npm.cmd run measure:idle` measures the signed-in minimized release client and its WebView2 children; the JSON report includes the limits of that measurement.

## Try the main features

`npm.cmd run seed` creates **alice**, **bob**, and **charlie**, already friends with a group chat. Their initial password is **tiny-local-demo**. Seeding again preserves existing passwords and messages. These are test accounts; use different passwords for accounts you care about.

1. Sign in as Alice using **Local test sign-in**. The default server address is `http://127.0.0.1:8787`.
2. Open a separate private/incognito browser window at that address and sign in as Bob. Separate browser profiles keep their sign-ins independent; ordinary tabs share stored login credentials.
3. Open the seeded group, or start a direct chat from a friend. Send messages in both windows, reload, and confirm the history remains.
4. Use **Create a test account** for a new handle and password. Add that handle as a friend from Alice, then start a chat. For this local prototype, adding a friend immediately connects both accounts; there is no approval workflow.
5. Create a group by selecting two or three friends. Chats and calls support up to **four people total**.
6. Join a call in both windows, allow the microphone, and use headphones to avoid feedback. Mute and leave controls operate the real tracks and connections.
7. During the call, share a screen or window through the system picker. **Stop sharing** stops the capture tracks immediately; the system picker's stop control also works. Screen sharing sends video, without system audio or camera video.
8. Open your profile to change your display name or choose a PNG, JPEG, or GIF up to **2 MiB**. Images are stored in the server's SQLite database and shared with your friends and chat participants. Animated GIFs may animate depending on the webview.

There are no fake Google/mobile buttons. Local passwords are salted and hashed, and sessions expire after seven days. This is a development sign-in system without account recovery, abuse moderation, or verified identities.

## Development and data

For automatic frontend reloads, keep `npm.cmd run server` in one terminal and run `npm.cmd run dev` in another, then open `http://127.0.0.1:1420`. The Tauri command also uses this frontend.

SQLite creates `data\tiny.sqlite` on first use. It contains chat history, profile pictures, password hashes, and session hashes. The database is not encrypted at rest. Stop the server before backing up the whole `data` folder. To start over, stop it and rename `data` to `data-backup`, then seed again. The app has no cloud sync or telemetry.

Copy `.env.example` to `.env` to change server settings. Node loads it when starting the server or seed command. You can change the server URL at the sign-in screen without rebuilding the client. A different server has separate accounts and data. For the launcher, set `$env:TINY_APP_URL='http://127.0.0.1:8787'` before `npm.cmd start` to change its address; the launcher reads this environment variable directly, not from `.env`.

## Other computers and call networks

A server running on your PC is **not automatically reachable over the internet**. By default it listens only on `127.0.0.1`, so only this PC can connect.

For trusted local network testing, set `TINY_HOST=0.0.0.0` in `.env`, restart the server, and allow its TCP port (default 8787) through Windows Firewall on your private network. Other PCs use the server PC's LAN address, for example `http://192.168.1.20:8787`, as their server address. Add the actual browser origin to `TINY_ALLOWED_ORIGINS` when serving the frontend at that address. Setting this list replaces the defaults, so keep every frontend origin you use. This allowlist controls browser origins; it is not a firewall or account permission system. HTTP LAN testing sends accounts and messages without transport encryption; use HTTPS for untrusted networks.

**Microphone and screen capture require a secure frontend context.** Localhost works, but an ordinary HTTP LAN browser page generally does not. The installed Windows app embeds its interface at Tauri's trusted localhost origin and supports a reachable HTTP API on a trusted LAN, so friends need no developer server. This uses [Tauri's default Windows protocol scheme](https://v2.tauri.app/reference/config/), with native media availability covered by the packaged-app test. For an untrusted/remote network, use an HTTPS API. A hosted HTTPS browser frontend also needs HTTPS/WSS APIs. The Node server is HTTP; put it behind a TLS reverse proxy for remote hosting.

WebRTC tries direct peer connections; the server exchanges connection information and does not carry media. No STUN/TURN is configured by default, so same-PC tests need no external service. Between PCs, router NAT, firewalls, VPNs, or blocked UDP can prevent connections. A reachable **STUN** server helps discover routes; **TURN** relays media when direct routes fail. Configure `TINY_ICE_SERVERS` with your own service addresses and credentials. You can self-host [coturn](https://github.com/coturn/coturn); it requires a reachable machine and firewall/relay-port configuration. TURN is not needed merely to try Tiny on one PC. See [WebRTC's peer-connection guide](https://webrtc.org/getting-started/peer-connections).

Public hosting later also needs a reachable domain/server, HTTPS/WSS, production authentication, backups, account controls, and usually TURN. Do not expose the seeded test server on the public internet. No port forwarding or firewall changes are made by Tiny.

Calls use a small peer mesh, suitable for up to four people. Each participant sends media to every other participant. Screen video targets 720p at 10 fps to limit upload use. Call quality depends on upload bandwidth, latency, packet loss, CPU, capture size, and relay routing. Tiny does not promise lag-free calls. There is no recording or media persistence. If a webview lacks capture APIs, Tiny explains the limitation; use a current Chrome/Edge browser for comparison.

## Optional authentication later

The local account endpoint issues the same internal session that a future verified provider adapter can issue. Put provider verification on the server and map its stable provider subject to an internal user ID. Display names and handles must never prove identity.

| Option | External setup needed before implementing                                                                                                                                                                                                                  |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Google | Google Cloud project, OAuth consent screen and client ID, permitted origins/redirect URLs, server verification of issuer/audience/expiry and account-linking rules; desktop login should use system-browser OAuth with PKCE, not an embedded Google login. |
| Email  | An email delivery service or SMTP server, verified sender/domain, expiring one-use verification/reset tokens, rate limiting, recovery and delivery handling. No mail is sent today.                                                                        |
| Mobile | SMS verification provider account/credentials, usable phone numbers and regional coverage, potential per-SMS charges, code expiry/retry limits, fraud controls, consent and recovery. No SMS is sent today.                                                |

For Google's desktop flow, follow the [official installed-app OAuth instructions](https://developers.google.com/identity/protocols/oauth2/native-app).

Do not put OAuth secrets, email passwords, or SMS API keys in frontend code. `TINY_LOCAL_AUTH=false` disables new local test sign-ins; existing sessions remain valid until logout or expiry. No production provider is implemented, so new sign-ins stay unavailable until one is added.

## Checks

```powershell
npm.cmd test
npm.cmd run format:check
npm.cmd run build
npx.cmd playwright install chromium
npm.cmd run test:e2e
```

Tests use isolated databases. Browser tests use synthetic microphone input and Chromium's test screen picker while exercising real WebRTC connections; they cannot prove how a physical microphone sounds or how a remote network behaves. Manually test those on the intended devices. `npm.cmd run format` applies formatting. If Rust is installed, also run `cargo fmt --manifest-path src-tauri/Cargo.toml --check` and `npm.cmd run build:desktop`. On Windows, `npm.cmd run test:desktop` then launches the real release executable with an isolated database and WebView2 profile to check rendering, media API availability, and native-origin access to the server. It enables a temporary debugging port only for that test process, following [Playwright's WebView2 testing approach](https://playwright.dev/docs/webview2).

This first version has no push notifications, attachments, message edit/delete, read receipts, friend requests/blocking, group membership editing, account deletion, camera video, system-audio sharing, or call recovery after a disconnected socket. Reconnecting restores saved chat state; rejoin a dropped call explicitly.
