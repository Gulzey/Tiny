# Public Tiny deployment review

These are manual, reviewable changes for `tinybros.duckdns.org` on the existing Oracle Ubuntu VM. Nothing in this repository edits OCI, UFW, Caddy, systemd, coturn, or the live database automatically.

## What is already enforced in v0.2

- The production client always uses `https://tinybros.duckdns.org`; there is no user-editable server field.
- Node remains on `127.0.0.1:8787`, behind Caddy. SQLite is a local file and has no network listener.
- Passwords are salted scrypt hashes. Existing version-1 hashes remain valid; new accounts use the stronger version-2 parameters.
- Sessions expire, logout revokes the current session, browser tokens use session storage, and desktop tokens are scoped to the one production origin.
- HTTP and WebSocket origins, sessions, conversation membership, call membership, friendship operations, message access, payload sizes, and avatar formats are checked server-side.
- Login, registration, authenticated HTTP, and WebSocket frames are rate-limited. The limiter is in-memory and single-instance; it is a basic control, not full public anti-abuse infrastructure.
- Authenticated `/api/rtc/config` responses contain expiring coturn REST credentials. The TURN shared secret remains server-side.

There are no application administrative endpoints today. Caddy should still deny reserved administrative paths. Account recovery, blocking/reporting, moderation, distributed abuse controls, and operational alerting remain release risks for an unrestricted public service.

## 1. Read-only audit before approval

Run these over your existing SSH session. They do not change state:

```bash
sudo systemctl --no-pager --full status tiny.service caddy coturn
sudo ss -lntup
sudo ufw status verbose
sudo caddy validate --config /etc/caddy/Caddyfile
sudo sed -n '1,240p' /etc/caddy/Caddyfile
sudo systemctl cat tiny.service
sudo grep -Ev 'SECRET|PASSWORD|TOKEN|KEY' /etc/tiny/tiny.env
curl --fail --silent http://127.0.0.1:8787/api/health
curl --fail --silent https://tinybros.duckdns.org/api/health
```

Expected listeners:

- public Caddy: TCP 80/443;
- public coturn: UDP/TCP 3478 and UDP 49160-49200;
- private Node: `127.0.0.1:8787` only;
- Caddy admin API: loopback only (normally `localhost:2019`);
- SSH: TCP 22, restricted at OCI to your trusted source or Oracle Bastion;
- no public SQLite/database listener.

Back up the database before deploying any new server code:

```bash
cd /home/ubuntu/Tiny
BACKUP_DIR="$HOME/tiny-backups/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_DIR"
sqlite3 data/tiny.sqlite ".backup '$BACKUP_DIR/tiny.sqlite'"
sqlite3 "$BACKUP_DIR/tiny.sqlite" 'PRAGMA integrity_check;'
```

The migration is additive and preserves users, friendships, conversations, messages, avatars, and sessions.

## 2. Caddy: remove only the IP restriction

First preserve the live file:

```bash
sudo cp -a /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.backup.$(date -u +%Y%m%dT%H%M%SZ)"
sudoedit /etc/caddy/Caddyfile
```

Replace the allowlisted site block with this reviewed public block. Do not add a public reverse proxy for port 8787 and do not expose Caddy's admin API:

```caddyfile
{
	admin localhost:2019
}

tinybros.duckdns.org {
	encode zstd gzip

	@protected path /admin* /internal* /.env* /.git* /data/*
	respond @protected 404

	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		X-Content-Type-Options "nosniff"
		Referrer-Policy "no-referrer"
		-Server
	}

	reverse_proxy 127.0.0.1:8787 {
		header_up X-Forwarded-For {remote_host}
		header_up X-Forwarded-Proto {scheme}
		header_up X-Forwarded-Host {host}
	}
}
```

Caddy handles WebSocket upgrades automatically. Validate before reload; a reload preserves existing connections better than a restart:

```bash
sudo caddy fmt --overwrite /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
sudo journalctl -u caddy -n 100 --no-pager
```

If validation or HTTPS fails, restore the timestamped backup, validate it, and reload Caddy.

## 3. OCI ingress rules

In the OCI Console, review the NSG/security list attached to this instance. Use **stateful ingress** rules:

| Source                                | Protocol | Destination | Purpose                         |
| ------------------------------------- | -------- | ----------: | ------------------------------- |
| `0.0.0.0/0`                           | TCP      |         443 | public HTTPS/WSS                |
| `0.0.0.0/0`                           | TCP      |          80 | HTTPS redirect and ACME renewal |
| `0.0.0.0/0`                           | UDP      |        3478 | STUN/TURN                       |
| `0.0.0.0/0`                           | TCP      |        3478 | TURN-over-TCP fallback          |
| `0.0.0.0/0`                           | UDP      | 49160-49200 | restricted TURN relay range     |
| your fixed admin CIDR or Bastion only | TCP      |          22 | SSH                             |

Delete or narrow any public rule for 8787, 2019, database ports (for example 3306/5432), or broad unrestricted port ranges. Keep normal egress so Caddy can renew certificates and the VM can install reviewed updates.

## 4. Existing iptables-nft firewall

This Oracle image already uses `iptables-nft`; do not install UFW or replace the ruleset. Before changing anything, save exact IPv4 and IPv6 rollback files and identify how the current rules persist across reboot:

```bash
sudo iptables-save | sudo tee /root/tiny-firewall-before.v4 >/dev/null
sudo ip6tables-save | sudo tee /root/tiny-firewall-before.v6 >/dev/null
sudo iptables -L INPUT --line-numbers -n -v
sudo ip6tables -L INPUT --line-numbers -n -v
sudo systemctl status netfilter-persistent --no-pager || true
sudo ls -la /etc/iptables 2>/dev/null || true
```

Preserve every Oracle `InstanceServices` rule. Extend the existing IPv4 INPUT chain immediately before its final reject with only:

- TCP/UDP 3478 for STUN/TURN clients;
- UDP 49160-49200 for TURN relay allocations;
- an SSH rule restricted to `<TRUSTED_ADMIN_IPV4_CIDR>`, tested in a second session before removing the broad TCP 22 rule.

Existing TCP 80/443 rules remain. Do not add 8787, 2019, RPC 111, database ports, or a broad port range. Apply the same intent in the OCI NSG/security list; both layers must allow TURN.

The audited IPv6 INPUT policy is ACCEPT. Before public launch, create a dedicated IPv6 guard chain without deleting existing rules: permit loopback, established/related traffic, and required ICMPv6, optionally permit SSH only from a trusted IPv6 CIDR, then reject other new inbound traffic. Since `tinybros.duckdns.org` currently has only an A record, public IPv6 application ingress is not required. Save and test the IPv6 rollback command before applying it. If public IPv6 is added later, explicitly permit TCP 80/443 and the TURN ports and add a reviewed AAAA record.

The final audit confirmed these IPv4 positions: established/related, ICMP, loopback, broad SSH, HTTPS, HTTP, then reject. Use this approval-gated sequence exactly, replacing the CIDR first:

```bash
ADMIN_CIDR='<TRUSTED_ADMIN_IPV4>/32'
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FW_BACKUP="/root/tiny-firewall-$STAMP"
sudo mkdir -m 0700 "$FW_BACKUP"
sudo iptables-save | sudo tee "$FW_BACKUP/rules.v4" >/dev/null
sudo ip6tables-save | sudo tee "$FW_BACKUP/rules.v6" >/dev/null
sudo cp -a /etc/iptables/rules.v4 "$FW_BACKUP/persistent.v4"
sudo cp -a /etc/iptables/rules.v6 "$FW_BACKUP/persistent.v6"

# Add the restricted rule while broad SSH still protects this session.
sudo iptables -I INPUT 4 -p tcp -s "$ADMIN_CIDR" --dport 22 \
  -m conntrack --ctstate NEW -j ACCEPT
sudo iptables -L INPUT --line-numbers -n -v
```

Keep this session open. From a second terminal, connect over SSH from the trusted address. Only after that succeeds, delete the now-number-5 broad SSH rule and add TURN before the final reject:

```bash
sudo iptables -D INPUT 5
sudo iptables -I INPUT 7 -p tcp --dport 3478 \
  -m conntrack --ctstate NEW -j ACCEPT
sudo iptables -I INPUT 8 -p udp --dport 3478 \
  -m conntrack --ctstate NEW -j ACCEPT
sudo iptables -I INPUT 9 -p udp --dport 49160:49200 \
  -m conntrack --ctstate NEW -j ACCEPT
sudo iptables -L INPUT --line-numbers -n -v
```

The resulting IPv4 order must be: established, ICMP, loopback, restricted SSH, HTTPS, HTTP, TURN TCP, TURN UDP, TURN relay UDP, reject. If it differs, restore immediately:

```bash
sudo sh -c "iptables-restore < '$FW_BACKUP/rules.v4'"
```

The audited IPv6 chain has no rules and policy ACCEPT. Add a dedicated guard without replacing the ruleset:

```bash
sudo ip6tables -N TINY_INPUT
sudo ip6tables -A TINY_INPUT -i lo -j ACCEPT
sudo ip6tables -A TINY_INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
sudo ip6tables -A TINY_INPUT -p ipv6-icmp -j ACCEPT
sudo ip6tables -A TINY_INPUT -j REJECT --reject-with icmp6-adm-prohibited
sudo ip6tables -I INPUT 1 -j TINY_INPUT
sudo ip6tables -L INPUT --line-numbers -n -v
```

This intentionally blocks new inbound IPv6 because the production domain has no AAAA record. It preserves loopback, return traffic, and required ICMPv6. Restore with `sudo sh -c "ip6tables-restore < '$FW_BACKUP/rules.v6'"` if validation fails.

After both active rulesets and a fresh SSH connection are verified, persist the **complete** active rulesets. `iptables-save` includes existing Oracle chains and `InstanceServices` rules; do not hand-create replacement files:

```bash
sudo iptables-save | sudo tee /etc/iptables/rules.v4.new >/dev/null
sudo ip6tables-save | sudo tee /etc/iptables/rules.v6.new >/dev/null
sudo sh -c 'iptables-restore --test < /etc/iptables/rules.v4.new'
sudo sh -c 'ip6tables-restore --test < /etc/iptables/rules.v6.new'
sudo install -o root -g root -m 0600 /etc/iptables/rules.v4.new /etc/iptables/rules.v4
sudo install -o root -g root -m 0600 /etc/iptables/rules.v6.new /etc/iptables/rules.v6
sudo rm /etc/iptables/rules.v4.new /etc/iptables/rules.v6.new
sudo systemctl reload netfilter-persistent
```

Recheck SSH from a third fresh connection after persistence. The OCI NSG/security-list change is separate: add TURN rules, preserve Oracle service rules, and restrict SSH to the same admin CIDR before considering the firewall complete. Do not install UFW.

## 5. Backend environment

Keep the protected systemd environment file at mode `0640` or stricter. It should contain the following names, with a real random TURN secret matching coturn; never paste the secret into Git, chat, logs, or the frontend:

```dotenv
TINY_HOST=127.0.0.1
TINY_PORT=8787
TINY_DB=/home/ubuntu/Tiny/data/tiny.sqlite
TINY_LOCAL_AUTH=true
TINY_REGISTRATION_ENABLED=true
TINY_TRUST_PROXY=loopback
TINY_ALLOWED_ORIGINS=https://tinybros.duckdns.org,http://tauri.localhost,https://tauri.localhost
TINY_STUN_URLS=stun:tinybros.duckdns.org:3478
TINY_TURN_URLS=turn:tinybros.duckdns.org:3478?transport=udp,turn:tinybros.duckdns.org:3478?transport=tcp
TINY_TURN_SECRET=<MATCHING_RANDOM_COTURN_SECRET>
TINY_TURN_CREDENTIAL_TTL=3600
```

`TINY_TRUST_PROXY=loopback` is safe only while Node remains loopback-only. Caddy replaces forwarding headers with its observed client address, allowing per-IP HTTP authentication limits to work.

### SQLite ownership, backup, and migration

The audited database is owned by `ubuntu` but mode `0644`, which allows every local account to read password hashes, messages, and avatars. Confirm `tiny.service` runs as `ubuntu`, then make the data private as part of the approved maintenance window:

```bash
sudo systemctl show tiny.service -p User -p Group
sudo namei -l /home/ubuntu/Tiny/data/tiny.sqlite
sudo chown -R ubuntu:ubuntu /home/ubuntu/Tiny/data
sudo chmod 0700 /home/ubuntu/Tiny/data
sudo chmod 0600 /home/ubuntu/Tiny/data/tiny.sqlite*
sudo systemctl edit tiny.service
```

Add `UMask=0077` under `[Service]` so new SQLite WAL/SHM files stay private. Do not restart yet.

Before migration, take an online SQLite backup, validate it, record counts, and copy it outside the project tree:

```bash
cd /home/ubuntu/Tiny
BACKUP_DIR="$HOME/tiny-backups/$(date -u +%Y%m%dT%H%M%SZ)"
install -d -m 0700 "$BACKUP_DIR"
sqlite3 data/tiny.sqlite "PRAGMA quick_check;"
sqlite3 data/tiny.sqlite ".backup '$BACKUP_DIR/tiny.sqlite'"
chmod 0600 "$BACKUP_DIR/tiny.sqlite"
sqlite3 "$BACKUP_DIR/tiny.sqlite" "PRAGMA integrity_check;"
sqlite3 data/tiny.sqlite "SELECT 'users',count(*) FROM users; SELECT 'messages',count(*) FROM messages; SELECT 'conversations',count(*) FROM conversations;" | tee "$BACKUP_DIR/counts-before.txt"
sha256sum "$BACKUP_DIR/tiny.sqlite" | tee "$BACKUP_DIR/SHA256SUMS"
```

Test the additive migration against a second copy first. Version 0.2 only adds `users.password_version INTEGER NOT NULL DEFAULT 1`, the `friend_requests` table, and its recipient index. It does not rewrite or delete existing users, password hashes, friendships, conversations, members, messages, avatars, or sessions. Verify the copied database and counts before allowing `tiny.service` to open production data.

```bash
cp "$BACKUP_DIR/tiny.sqlite" "$BACKUP_DIR/migration-test.sqlite"
chmod 0600 "$BACKUP_DIR/migration-test.sqlite"
node --input-type=module -e \
  "import { openDatabase } from './server/database.mjs'; const db = openDatabase(process.argv[1]); db.close();" \
  "$BACKUP_DIR/migration-test.sqlite"
sqlite3 "$BACKUP_DIR/migration-test.sqlite" "PRAGMA integrity_check; PRAGMA table_info(users); SELECT name FROM sqlite_master WHERE type='table' AND name='friend_requests';"
sqlite3 "$BACKUP_DIR/migration-test.sqlite" "SELECT 'users',count(*) FROM users; SELECT 'messages',count(*) FROM messages; SELECT 'conversations',count(*) FROM conversations;"
```

Compare the three counts with `counts-before.txt`. Do not proceed if integrity is not `ok`, the counts differ, `password_version` is absent, or `friend_requests` is absent.

For rollback, first stop Tiny and roll back application code while keeping the additive schema: v0.1 ignores the extra column/table. Restore the database backup only if integrity or record-count verification shows actual database damage, because restoring it would discard any messages created after the backup.

## 6. coturn

Use the NAT-aware configuration, restricted relay range, quotas, HMAC secret, denied private peer ranges, and rotation process in [ORACLE_DEPLOYMENT.md](ORACLE_DEPLOYMENT.md). Media remains DTLS-SRTP encrypted end-to-end even when TURN relays it. The public rules must match coturn's listener and relay range exactly.

After deployment, force relay during a two-network test with:

`https://tinybros.duckdns.org/?tiny-force-relay=1`

Both users should see **TURN relay** under call **Connection details**, hear two-way microphone audio, start screen sharing after joining, view remote screen video, stop sharing, and continue voice. Same-machine automated tests cannot verify Oracle NAT or public TURN routing.

## 7. Deploy code without replacing data

After this branch is reviewed and merged, use the safe backup/pull/build/restart/rollback workflow in [ORACLE_DEPLOYMENT.md](ORACLE_DEPLOYMENT.md). Do not delete `data/`, copy a development database over production, or run the demo seed command.

After restarting:

```bash
curl --fail --silent http://127.0.0.1:8787/api/health
curl --fail --silent https://tinybros.duckdns.org/api/health
sudo journalctl -u tiny.service -u caddy -u coturn -n 200 --no-pager
```

Test from a phone on mobile data or another non-allowlisted network. Confirm registration, login, friend request acceptance, messaging, WSS updates, voice, screen sharing, logout, incorrect-login throttling, and that ports 8787/2019/database ports are unreachable externally.
