# Tiny on Oracle Cloud

This guide is for the existing Ubuntu 24.04 VM at `152.67.135.157` and does not change it automatically. For the separate reviewed change from private staging to worldwide HTTPS access, use [PUBLIC_DEPLOYMENT.md](PUBLIC_DEPLOYMENT.md). Neither guide exposes Node port 8787.

## Network shape

- Caddy is the only public web entry point on TCP 80/443 and proxies HTTPS/WSS to `127.0.0.1:8787`.
- Node remains bound to `127.0.0.1:8787`. Do **not** add an OCI or UFW rule for 8787.
- coturn listens publicly on UDP and TCP 3478. Its media allocations use the restricted UDP range 49160-49200.
- Tiny calls are a four-person maximum peer mesh. TURN carries media only when a direct route fails. Relayed screen video consumes bandwidth in both directions, so VM bandwidth and CPU—not an advertised “unlimited” number—set the practical limit.

## 1. Install and configure coturn

Find the VM's private IPv4 first:

```bash
hostname -I
```

In the configuration below, replace `<PRIVATE_IPV4>` with that address. Oracle maps the public IP to the private VNIC address, so coturn needs both sides of that mapping.

```bash
sudo apt update
sudo apt install -y coturn sqlite3
sudo install -d -m 0750 -o root -g turnserver /etc/tiny
openssl rand -hex 32 | sudo tee /etc/tiny/turn-secret >/dev/null
sudo chown root:turnserver /etc/tiny/turn-secret
sudo chmod 0640 /etc/tiny/turn-secret
TURN_SECRET="$(sudo cat /etc/tiny/turn-secret)"
sudo tee /etc/turnserver.conf >/dev/null <<EOF
listening-port=3478
listening-ip=<PRIVATE_IPV4>
relay-ip=<PRIVATE_IPV4>
external-ip=152.67.135.157/<PRIVATE_IPV4>
min-port=49160
max-port=49200
realm=tinybros.duckdns.org
server-name=tinybros.duckdns.org
fingerprint
use-auth-secret
static-auth-secret=${TURN_SECRET}
stale-nonce=600
no-multicast-peers
no-cli
no-tcp-relay
user-quota=12
total-quota=100
max-bps=3000000
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=224.0.0.0-255.255.255.255
EOF
unset TURN_SECRET
sudo chmod 0640 /etc/turnserver.conf
sudo chown root:turnserver /etc/turnserver.conf
sudo systemctl enable coturn
sudo systemctl restart coturn
sudo systemctl --no-pager --full status coturn
sudo ss -lntup | grep 3478
```

`no-tcp-relay` disables RFC 6062 peer TCP allocations; it does not disable WebRTC clients reaching the TURN listener over TCP 3478. Tiny advertises both UDP and TCP transports. TLS TURN on 5349 can be added later with a dedicated DNS name and certificate; do not point coturn at private Caddy certificate files unless its service account has deliberately reviewed read access.

coturn's official configuration documents `use-auth-secret`, `static-auth-secret`, the relay-port range, and public/private `external-ip` mapping: <https://github.com/coturn/coturn/blob/master/README.turnserver>.

## 2. Open only the TURN ports

In the OCI Console, edit the security list or NSG attached to this VM and add **stateful ingress** rules from `0.0.0.0/0` for:

| Protocol | Destination port | Purpose                           |
| -------- | ---------------: | --------------------------------- |
| UDP      |             3478 | STUN/TURN listener                |
| TCP      |             3478 | TURN-over-TCP fallback            |
| UDP      |      49160-49200 | Restricted TURN media allocations |

Keep existing TCP 80/443 rules for Caddy and the restricted SSH rule. Do not add 8787. OCI applies security lists at the subnet and instance VNIC; both OCI rules and the guest firewall must permit a flow: <https://docs.oracle.com/en-us/iaas/tools/oci-cli/latest/oci_cli_docs/cmdref/network/security-list.html>.

Review UFW before enabling it so SSH is not locked out:

```bash
sudo ufw status verbose
sudo ufw allow OpenSSH
sudo ufw allow 3478/udp
sudo ufw allow 3478/tcp
sudo ufw allow 49160:49200/udp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status numbered
```

UFW rules persist across reboot. Ubuntu's firewall guide is <https://ubuntu.com/server/docs/firewalls/>.

## 3. Give Tiny the matching secret

The same shared secret is read only by coturn and the Tiny backend. It is never returned to clients. The API converts it into an HMAC credential tied to the signed-in user and an expiry timestamp.

Create a protected systemd environment file:

```bash
TURN_SECRET="$(sudo cat /etc/tiny/turn-secret)"
sudo tee /etc/tiny/tiny.env >/dev/null <<EOF
TINY_HOST=127.0.0.1
TINY_PORT=8787
TINY_DB=/home/ubuntu/Tiny/data/tiny.sqlite
TINY_LOCAL_AUTH=true
TINY_REGISTRATION_ENABLED=true
TINY_TRUST_PROXY=loopback
TINY_ALLOWED_ORIGINS=https://tinybros.duckdns.org,http://tauri.localhost,https://tauri.localhost
TINY_STUN_URLS=stun:tinybros.duckdns.org:3478
TINY_TURN_URLS=turn:tinybros.duckdns.org:3478?transport=udp,turn:tinybros.duckdns.org:3478?transport=tcp
TINY_TURN_SECRET=${TURN_SECRET}
TINY_TURN_CREDENTIAL_TTL=3600
EOF
unset TURN_SECRET
sudo chown root:ubuntu /etc/tiny/tiny.env
sudo chmod 0640 /etc/tiny/tiny.env
sudo systemctl edit tiny.service
```

Add this reviewed override in the editor:

```ini
[Service]
EnvironmentFile=/etc/tiny/tiny.env
```

Then reload and verify without printing the secret:

```bash
sudo systemctl daemon-reload
sudo systemctl restart tiny.service
sudo systemctl --no-pager --full status tiny.service
curl --fail --silent https://tinybros.duckdns.org/api/health
sudo journalctl -u tiny.service -n 100 --no-pager
```

`TINY_TRUST_PROXY=loopback` trusts forwarding headers only because port 8787 remains loopback-only. During private staging, keep the Caddy allowlist; for the approved public cutover, use the exact replacement block in [PUBLIC_DEPLOYMENT.md](PUBLIC_DEPLOYMENT.md).

To rotate the TURN secret without immediately breaking active one-hour credentials: generate a new secret, add a second `static-auth-secret=<new>` line to coturn, change `TINY_TURN_SECRET` to the new value, restart coturn and Tiny, wait longer than `TINY_TURN_CREDENTIAL_TTL`, then remove the old coturn secret and restart coturn again. Keep both secret files protected during the overlap and securely delete the retired value after backups no longer require it.

## 4. Prove relay operation

First test coturn authentication locally. This creates a ten-minute credential in the same format used by Tiny:

```bash
TURN_USER="$(($(date +%s) + 600)):turn-check"
TURN_PASSWORD="$(printf %s "$TURN_USER" | openssl dgst -sha1 -hmac "$(sudo cat /etc/tiny/turn-secret)" -binary | openssl base64 -A)"
turnutils_uclient -p 3478 -u "$TURN_USER" -w "$TURN_PASSWORD" -y tinybros.duckdns.org
unset TURN_USER TURN_PASSWORD
```

Then use two permitted computers on different networks:

1. Sign in at `https://tinybros.duckdns.org/?tiny-force-relay=1` in current Chrome/Edge on both computers.
2. Join the same call. This diagnostic query parameter sets WebRTC `iceTransportPolicy` to `relay`; it does not reveal credentials.
3. Open **Connection details** in the call panel. Every connected peer should say `TURN relay`.
4. Confirm two-way speech, start screen sharing after the call is connected, confirm remote video moves, stop sharing, and confirm voice continues.
5. Check `sudo journalctl -u coturn -n 100 --no-pager` and VM network use.

Automated same-machine WebRTC tests cannot prove NAT traversal. Do not mark cross-network calls verified until this two-network relay-only test passes.

## 5. Safe application update and rollback

The server opens additive SQLite tables automatically. Back up first and keep the previous Git commit. These commands do not edit Caddy or the allowlist:

```bash
cd /home/ubuntu/Tiny
PREVIOUS_COMMIT="$(git rev-parse HEAD)"
BACKUP_DIR="$HOME/tiny-backups/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_DIR"
sqlite3 data/tiny.sqlite ".backup '$BACKUP_DIR/tiny.sqlite'"
git fetch --prune origin
git checkout main
git pull --ff-only origin main
npm ci
npm test
npm run build
sudo systemctl restart tiny.service
curl --fail --silent https://tinybros.duckdns.org/api/health
sudo journalctl -u tiny.service -n 100 --no-pager
printf 'Previous commit: %s\nBackup: %s\n' "$PREVIOUS_COMMIT" "$BACKUP_DIR"
```

If health checks fail, stop before changing the database further and roll the code and database back together:

```bash
cd /home/ubuntu/Tiny
sudo systemctl stop tiny.service
cp data/tiny.sqlite "$HOME/tiny-failed-$(date -u +%Y%m%dT%H%M%SZ).sqlite"
cp "$BACKUP_DIR/tiny.sqlite" data/tiny.sqlite
git checkout "$PREVIOUS_COMMIT"
npm ci
npm run build
sudo systemctl start tiny.service
curl --fail --silent https://tinybros.duckdns.org/api/health
```

Registration can be closed without disabling existing password sign-in by setting `TINY_REGISTRATION_ENABLED=false` and restarting Tiny. The public Caddy cutover is documented separately in [PUBLIC_DEPLOYMENT.md](PUBLIC_DEPLOYMENT.md).
