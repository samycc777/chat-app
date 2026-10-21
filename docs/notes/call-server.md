# Call server (self-hosted LiveKit)

Calls run on our own LiveKit server on Hetzner, not LiveKit Cloud (its free plan ran out of minutes).

- Hetzner Cloud project `Majlis`, CLI context `majlis` (`hcloud server list`). Server `majlis-livekit` (cax11 ARM, 2 CPU, 4 GB, Ubuntu 24.04) in Nuremberg (`nbg1`), primary IP `majlis-livekit-ip` = `167.233.162.224`, firewall `majlis-livekit` (tcp 80, 443, 7881; udp 50000-60000; ssh 22 from one home IP, update it when the home IP changes). About €4-5/month, 20 TB traffic included.
- Address `wss://167-233-162-224.sslip.io`: Caddy on 443 (Let's Encrypt) proxies to LiveKit on 7880. No TURN yet.
- SSH: `ssh -i ~/.ssh/majlis-hetzner root@167.233.162.224`. Config `/etc/livekit/livekit.yaml` (holds the API key and secret), services `livekit` and `caddy` (systemd). Update LiveKit: `curl -sSL https://get.livekit.io | bash && systemctl restart livekit` (outside call times).
- The site's `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` (in `/etc/majlis/env`, see hosting.md) point here; changing them needs `systemctl restart majlis`, which cuts calls.
- Test without bothering the friends: `lk load-test --url wss://167-233-162-224.sslip.io --api-key … --api-secret … --room probe --video-publishers 2 --subscribers 2 --duration 20s`, or join the private "Server test" room (a customer room made for this).
- The old LiveKit Cloud project is `classroom-0jbkm9ym`.
