# Hosting (Hetzner)

The website and server run on the same Hetzner machine as the call server (docs/notes/call-server.md), since 21 October 2026. They used to run on Railway (service `nurturing-dedication`), which went down that day and paused deploys; having everything on one machine we control means one place that can fail instead of two.

- Address: `https://majlis.167-233-162-224.sslip.io` (sslip.io turns the name into the machine's IP, so no domain is needed; Caddy gets the certificate). The invite link is that address with `?invite=<INVITE_KEY>`. Android 1.9 and later open it.
- Code: `/opt/majlis`, a clone of `samycc777/chat-app` owned by the `majlis` user, which pulls with a read-only GitHub deploy key ("Hetzner server (read-only)").
- Settings: `/etc/majlis/env` (the variables in the README's Configuration table, single-quoted, read by `node --env-file`). Edit it, then `systemctl restart majlis` (this cuts calls).
- Database and its daily backups: `/var/lib/majlis/data` (`DATA_DIR`). The backups sit on the same disk; Hetzner's own server backups would add an off-machine copy for about €1/month.
- Service `majlis` (systemd, restarts on crash and at boot); logs with `journalctl -u majlis`. Caddy's `majlis.…` block in `/etc/caddy/Caddyfile` passes requests to port 3001.
- Deploys: `majlis-deploy.timer` runs `/usr/local/bin/majlis-deploy` every minute. It pulls `main` and, only when `server/`, `client/` or the build files changed (the paths Railway used to watch), rebuilds and restarts the app. It records the deployed commit in `/var/lib/majlis/deployed-commit` only after a successful build, so a failed build leaves the running app alone and is retried next minute. A push therefore reaches the live site within about two minutes; `journalctl -u majlis-deploy` shows what it did.
- SSH is open only to the home IP (see call-server.md); when the home IP changes, update the `majlis-livekit` firewall's port 22 rule with `hcloud`.
