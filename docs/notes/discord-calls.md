# Discord's calls, and what to borrow

What Discord's call feature actually does, measured against Majlis, and the changes worth making
(2026-11-04).

## How this was gathered

- Discord's web client, fetched from `discord.com/app` on 2026-11-04: 346 JavaScript bundles, 19 MB.
  Quotes below name the bundle (`web.0bcf…js` is the 13 MB main one) and are from minified code, so
  the wording is Discord's, the reading of it is ours.
- Public documents for the parts the client does not contain: the
  [DAVE end-to-end encryption whitepaper](https://github.com/discord/dave-protocol) and
  [LiveKit's self-hosting docs](https://docs.livekit.io/transport/self-hosting/deployment/).
- Not done: no Discord desktop app on this machine, no signed-in session, no packet capture, so
  nothing here is about Discord's servers, capacity or regional layout. Everything below is the
  client's own code and defaults, plus what Majlis's code does today.

## What a Discord call is

1. **One session per channel, with ids that travel everywhere.** The client tracks a
   `media_session_id`, an `rtc_connection_id` and a `parent_media_session_id`; a screen share is a
   **second RTC connection** parented to the voice session, so streaming never disturbs the voice
   (`web.0bcf…js` @2528536, @719358, @1042816). Every stat and setting is reported against those ids.
2. **Their own transport, not plain WebRTC.** On desktop and mobile the client talks to a native
   media engine (`getMediaEngine()`); on web it wraps `RTCPeerConnection` and patches ICE restarts
   (@11348799). Signalling is a binary voice WebSocket whose opcodes are visible in the client:
   hello(8), ready(2), select-protocol-ack(4, carries SDP, codecs, encryption mode, media session id
   and keyframe interval), speaking(5, with an SSRC), heartbeat(3/6), video(12), client
   connect/disconnect(11/13), SFU update(33), resume(9) (@2426050, @2427059).
3. **A codec ladder, chosen per device.** Audio is always Opus. Video is H264, H265, VP8, VP9 and AV1
   with per-codec encode/decode timings and hardware decoders reported by name (VideoToolbox,
   dav1d, libvpx, Exynos, Qualcomm, WebRTC) (@2454245, @11253411). They know when a session is
   asymmetric (one codec encoding, another decoding).
4. **Audio defaults they ship with:** echo cancellation on, browser noise suppression **off**,
   Krisp noise cancellation on, automatic gain control on, side-chain compression on (other people's
   voices duck while someone talks), silence warning on (@9594543, @2527809). Input can be voice
   activity (with Krisp-backed VAD and auto threshold) or push-to-talk with a key and release delay.
5. **Bitrates.** Numbers in the client: 64, 128, 256 and 384 kbps audio tiers, and 800 kbps to
   2 M/3 M/3.5 M/5 M/9 M for streams; "Go Live" simulcast tiers are named in kilobytes, e.g.
   720p@500k and 720p@750k, with AV1 tuned between 2.5 and 3.5 Mbps (@2413385, @2535193). Inference:
   the audio tiers are per-channel settings, the stream numbers are caps per quality level.
6. **Resilience is measured, not hoped for.** Ping average, bad pings, ping timeouts, fast UDP
   reconnects, connect count, packet loss over short and long windows (a stream warns above 10%),
   keyframe interval negotiation, and A/B experiments on the bandwidth estimator and pacer
   (`trendline-window-duration-3750, robust-estimator`) (@2528536, @4852127, @2413385). Sessions
   resume (op 9) instead of re-joining.
7. **Encryption by default.** DAVE: secure-frame transitions, a refused downgrade event, MLS failure
   counting (@422576, @2417990); the protocol is published.

## Where Majlis already matches

Chat, hand raising, drawing on the shared screen, per-person volume, weak-connection signs, data
saving, rejoin, background calls and the small window are already there; most of what Discord does
in 4–7 above has a LiveKit equivalent that `client/src/call/` already uses (simulcast, dynacast,
adaptive stream, 15 fps camera at 300 kbps, screen-share layers, RNNoise plus levelling instead of
Krisp, DTX and RED from LiveKit's defaults).

## The plan, in the order it pays off

### 1. Put a TURN relay on the call server (reliability) — about 1 hour

Discord never asks two people to reach each other directly: everything goes through their SFU, and
they keep relay capacity for the networks that cannot do UDP. Majlis has **no TURN**
(`docs/notes/call-server.md`), so a school firewall, a symmetric carrier NAT or a hotel network can
stop a call from connecting at all, with a "Join call failed" the person cannot act on.

LiveKit has a built-in TURN listener (`turn:` in `livekit.yaml`); give it the sslip.io certificate,
a TLS port, and a relay range, open that port in the Hetzner firewall, restart outside lesson times,
then test from a phone hotspot with UDP blocked. This is the only fix here that changes behaviour for
people who cannot join at all.

### 2. Send voices at 32 kbps instead of 24 (clarity) — about 15 minutes

`publishDefaults.audioPreset` is `AudioPresets.speech`, which LiveKit defines as **24 kbps**
(`client/src/call/room.ts:130`); Discord's lowest voice tier is 64 kbps. The class's reason for
caring is concrete: the letters that carry meaning here are the hissing ones (س، ص، ث، ش), and they
are what a low bitrate damages first.

24 kbps costs about 11 MB per hour per listener, 32 kbps about 14 MB; with DTX on, silence is already
free. Set `audioPreset: { maxBitrate: 32_000 }` and keep the rest; if data use matters more, make it
32 while a screen is shared and 24 otherwise.

### 3. Self-deafen and per-person mute (two small buttons) — about 2 hours

Discord's calls are used with a deafen key more than almost anything else: one tap stops all sound
and your microphone, in a room where you need quiet for a minute. Majlis has neither, and its
per-person slider deliberately stops at 10% so it can never be silence
(`client/src/call/sound.ts:20`), which is right for a default but leaves no way to silence one person.

- Deafen: a toolbar button that turns the call's sound off and mutes the microphone, remembered for
  that device only; press again to come back exactly as before.
- Per-person mute: a small speaker button beside the slider in `CallPeopleSheet.vue`, local to the
  device, stored like the volumes already are.

Both are on the person's own device, so "everyone is equal" holds.

### 4. Count how calls actually go (product) — about half a day

Everything good in Discord's audio comes from numbers nobody outside sees. Majlis has none, so the
first paying customer's "the call was bad yesterday" cannot be answered. Add, per call, on the
server, with no names: how many joined, how many join attempts failed, how many reconnects, how long
the call lasted, how many minutes were spent with a poor connection, and the average bitrate the
server saw. One JSON line at call end in the server log is enough to start; a small owner-only
endpoint can come later. This is also the only way to know whether 2, 3 and 5 helped.

### 5. A third, sharper screen-share layer for writing (lessons) — about a day, needs the tablet

Discord's answer to "reading a shared screen" is a ladder of simulcast layers plus AV1, sized per
viewer. Majlis already has two layers (640×360@3 fps and 1280×720@15 fps) and a "sharp only when
zoomed" rule (`client/src/call/room.ts:138`, `client/src/call/tiles.ts`). The gap is the still page of
Arabic writing read at normal size on a phone: layering a 1080p, 2 fps, high-bitrate copy would cost
almost nothing for a still page and would let a phone show real detail without zooming.

This is worth only if the teacher's tablet encoder keeps up; test on his device before committing,
and keep the existing two layers as they are.

### 6. Decide on end-to-end encryption, once — a discussion, not a task

Discord encrypts calls end to end by default (DAVE). LiveKit can do the same with insertable streams,
and Majlis already stores nothing from a call, so nothing would be lost — but the cost is CPU on the
cheapest Android phones in the class, and a browser that cannot do it must be refused or downgraded.
Worth doing before selling rooms on privacy; not worth doing before items 1 and 2.

## What not to copy, and why

- **Push-to-talk, soundboard, spatial audio, stage channels, per-channel bitrate settings, a noise
  suppression switch.** Each is a setting for people who like settings; the rules here are defaults
  over settings. The voice is already cleaned automatically.
- **Go Live as a separate product.** Majlis's screen share already uses its own simulcast layers,
  which is the part that matters. The second *connection* only matters when many strangers watch one
  stream.
- **Roles and moderation powers.** Unchanged: nobody in a Majlis call can remove or silence anyone.

## How to check each one after the change

1. TURN: phone on a hotspot with UDP blocked still joins, and a call on the class tablet still works
   from home.
2. Bitrate: `lk load-test` or a short two-person call, watching the server's bitrate stat; ask two
   friends whether س/ص/ش got clearer.
3. Deafen and mute: one device, two browsers, check the deaf button also mutes, and that a second tap
   restores the exact earlier state.
4. Numbers: one real lesson, then read the call line in the log and confirm it matches.
5. Layers: teacher's tablet sharing a page of writing, seen on a phone at normal size, on a slow
   connection.
