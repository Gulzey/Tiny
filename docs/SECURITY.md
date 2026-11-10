# Security status

Tiny now uses salted scrypt password hashes, generic login failures, 12-character minimum new passwords, per-IP/per-handle authentication limits, seven-day random sessions stored as SHA-256 hashes, bounded sessions per account, explicit origin checks, authenticated WebSockets, conversation membership checks, request-size limits, and server-side authorization for messages, calls, friendships, and friend requests.

Browser sessions use `sessionStorage` so closing the tab clears the bearer token. The Tauri app uses per-server WebView storage so users remain signed in; it never sends one server's token to another server. That desktop storage is not an OS credential vault or encrypted database, so local malware or another process with the user's privileges remains a risk. A future release should move desktop sessions to an OS-backed secret-store plugin.

Bearer tokens are supplied explicitly rather than in cookies, so browsers do not attach them cross-site and cookie CSRF does not apply. CORS and WebSocket origins are still enforced. Caddy must terminate HTTPS and keep port 8787 private.

Public deployment instructions are in [PUBLIC_DEPLOYMENT.md](PUBLIC_DEPLOYMENT.md). Account recovery and verified email or another identity provider, moderation/blocking/reporting, administrative audit tools, stronger distributed rate limiting, monitoring/alerting, dependency and vulnerability scanning, an incident/session-revocation workflow, and a privacy/data-retention policy remain important release risks. The in-memory rate limiter resets on process restart and is not sufficient for a large hostile public service.

Never commit `.env`, `/etc/tiny/tiny.env`, updater private signing keys, TURN shared secrets, SQLite files, SSH keys, cloud credentials, or GitHub tokens. Templates contain names and examples only.
