# Tiny: install, host, and play

## Send this to friends

Send **Tiny-Setup.exe**. Your friends double-click it, install Tiny, and open Tiny. They do not need Node, npm, Rust, C++ tools, source files, or a command script. Windows may need the free Microsoft WebView2 runtime; the installer handles the standard runtime setup. This build is unsigned, so Windows may show an unknown-publisher warning.

The official Windows installer connects permanently to `https://tinybros.duckdns.org`. Ordinary users install, open, sign in, and send friend requests without entering networking details. There is no server selector in login or registration.

## Only the host runs the server

Unzip **Tiny-Host.zip**. Keep the files together and double-click **Tiny-Server.exe**. Leave its console window open while people use Tiny. Ctrl+C stops it. There is no separate Node installation and it does not install an always-on Windows service or start with Windows.

The default address is `http://127.0.0.1:8787`: that works only on the host PC. Account and message data are saved in `%LOCALAPPDATA%\Tiny Server\tiny.sqlite`, separate from the installed app. Back up that data with the server stopped. The earlier developer database in the project's `data` folder is separate; point `TINY_DB` at that file if you want to reuse it.

### Friends on the same trusted network

1. Copy `tiny-server.env.example` to a file named `tiny-server.env` beside the server EXE. Open it in Notepad.
2. Change `TINY_HOST=127.0.0.1` to `TINY_HOST=0.0.0.0`, save, and restart the server.
3. Permit **Tiny-Server.exe** through Windows Firewall on your **private** network when Windows asks. Tiny does not change firewall settings itself.
4. The server prints possible LAN addresses, such as `http://192.168.1.20:8787`. Give friends the address that belongs to your home network. They enter it under **Server connection** in their installed Tiny app.

The installed Windows client supports a trusted LAN HTTP server without requiring each friend to run a developer web server. HTTP does not encrypt account/message traffic; use it only on a trusted network. The client interface itself is embedded locally, and its microphone/screen APIs remain in a trusted localhost context. Remote HTTPS servers also work.

### Friends outside that network

Running a server EXE does not make your PC reachable over the internet. You still need a reachable host address, network/firewall configuration, and HTTPS for accounts/messages on untrusted networks. Calls need configured STUN and a reachable TURN fallback when routers/firewalls block direct WebRTC. `TINY_STUN_URLS`, `TINY_TURN_URLS`, and a server-only `TINY_TURN_SECRET` configure self-hosted coturn with expiring credentials.

This prototype uses local password accounts. Google/email/SMS verification, account recovery, and public-server abuse controls are not implemented. Do not expose the seeded test server publicly as if it were production authentication.

### Optional test accounts

Open PowerShell in the extracted host folder and run:

```powershell
.\Tiny-Server.exe --seed-demo
```

This creates alice, bob, and charlie with initial password `tiny-local-demo`, makes them friends, and starts the server. Existing passwords and messages are preserved. A normal double-click does not create known-password demo accounts. `--help` lists the other switches.

## Gaming and dark mode

Tiny opens in its black dark theme by default. The optional light-theme toggle appears at the bottom of the signed-in sidebar.

When Tiny is minimized or loses focus, it keeps the WebSocket and voice call but defers chat/sidebar repainting, stops animated avatar playback, detaches screen previews, and asks peers to stop sending it screen video. Returning to Tiny resumes the view. Your own explicitly shared screen continues being captured/sent to people who are watching; **Stop sharing** and **Leave call** release those devices.

There are no UI animation loops, idle stats collection, message polling, automatic startup service, or client-side server process. Closing Tiny exits the client. Only the host needs a separate server process. The system WebView2 runtime still uses memory, and active voice/screen encoding uses CPU/GPU/network resources. No app can guarantee zero FPS impact in every game. Use the release installer rather than development mode while playing.

`idle-measurement.json`, when included, records a measured release-client sample including its WebView2 child processes. It is an idle sample, not an active-call or game-FPS benchmark. Source-project owners can repeat it with `npm run measure:idle`.

The measured signed-in, minimized sample on this 16-thread PC lasted 20.55 seconds and used 219 ms of CPU time: about **0.067% of the machine's total CPU capacity** (1.064% of one core). The summed working sets were about 378 MiB, including shared pages; private commit was 191 MiB and is not a resident-RAM measurement. These figures include the WebView2 child processes and show that the client still has a memory footprint. Debugging was attached for the test. Hardware, active calls, screen sharing, and games will change the result.
