# Call server (self-hosted LiveKit)

Calls run on our own LiveKit server, not LiveKit Cloud (its free plan ran out of minutes).

- AWS account 102397318300, profile `personal-mgmt-admin` (sign in: `aws sso login --profile personal-mgmt-admin`), region `eu-central-1` (Frankfurt, closest to Cairo).
- EC2 `i-0d9325c74ce9ededf` (`majlis-livekit`, t4g.small ARM, Ubuntu 24.04), Elastic IP `18.199.55.190`, security group `sg-0a3bb8194661f3779` (tcp 80, 443, 7881; udp 50000-60000; ssh 22 from one home IP, update it when the home IP changes).
- Address `wss://18-199-55-190.sslip.io`: Caddy on 443 (Let's Encrypt) proxies to LiveKit on 7880. No TURN yet.
- SSH: `ssh -i ~/.ssh/majlis-livekit.pem ubuntu@18.199.55.190`. Config `/etc/livekit/livekit.yaml` (holds the API key and secret), services `livekit` and `caddy` (systemd). Update LiveKit: `curl -sSL https://get.livekit.io | sudo bash && sudo systemctl restart livekit` (outside call times).
- Railway's `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` point here; changing them redeploys the site.
- Test without bothering the friends: `lk load-test --url wss://18-199-55-190.sslip.io --api-key … --api-secret … --room probe --video-publishers 2 --subscribers 2 --duration 20s`.
- The old LiveKit Cloud project is `classroom-0jbkm9ym`.
- AWS charges for data sent out beyond 100 GB a month (~$0.09/GB); Hetzner includes 20 TB if moving the server ever pays off.
