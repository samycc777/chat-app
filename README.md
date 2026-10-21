# Majlis (Hangout)

Majlis (called Hangout in the code) is one call room for a group of friends and for the Arabic class: anyone can talk, turn on their camera and share their screen, like a Zoom call. There are no channels or admins. The interface is in English and Arabic.

It runs as one Node.js process (Express, Socket.IO, SQLite) serving a Vue 3 web app, with calls carried by [LiveKit](https://livekit.io). The same web app is wrapped as an iPhone app and an Android app in `mobile/`, so all three look and work the same.

Since September 2026 one server can hold many rooms, one per customer, as the first step to Majlis being a call app anyone can pay for. Each room has its own name, invite link and call, and nobody in one room can see or hear anyone in another. The friends' and the class's room is the **home room**: its link and everything in it is unchanged, and it is never billed. See [Rooms](#rooms).

Until September 2026 Majlis was a Discord-style server with text channels, voice messages, search, pins, notifications of messages and call recording. The app no longer shows any of that; since October 2026 the server no longer has them either: the first start after that update deleted the old messages, files and recordings (the database copy it made just before, ending in `-before-v2.db`, still has them).

## What everyone can do

- **Type your name.** Every time the app opens, it asks for your name, already filled in with the one you used last time on that device, so it is one tap to go on. Change it there if you like. The first time, you open the invite link a friend sent; nobody types a code, because the key is inside the link. When the server has `OPEN_JOIN` on, the site's plain address works the same way.
- **Add your photo.** On the screen before the call, tap your circle (or **Add your photo** at the bottom) and pick a picture. It shows instead of your initials to everyone in the room: in the list of who is in the call, on your tile when your camera is off, and in the call's list of people, and it changes for them straight away. A picture of any shape is cut to a square from its middle. **Change your photo** picks another; **Remove photo** brings your initials back. During the call, the same choices are under **⋯**.
- **Invite someone.** Before joining, **Copy invite link** copies the link to the room you are in, ready to send.
- **See who is in the call, then join.** The next screen shows who is in the call right now, and two big switches for your microphone and camera, so you choose before anyone hears or sees you. With the camera on you see yourself first. Your choice is remembered for next time. Then tap **Join call**.
- **In the call**, anyone can:
  - mute and unmute, and turn their camera on and off. If the microphone will not turn on, the call says why and what to change: the browser's permission, the computer's privacy settings (Windows or Mac), another app using it, or no microphone plugged in,
  - share their screen from a computer or the Android app (Android first asks "Share your screen with Majlis?"; a notification with a Stop sharing button stays while it lasts). A shared browser tab on a computer can bring its sound along. iPhones and phone browsers cannot share their screen yet,
  - **chat**, with the speech-bubble button at the top: to everyone in the call, or privately to one person, chosen in the **To** list or with the message button next to their name in the people list. A private message is seen only by its two people. New messages pop up for a moment and are counted on the button. Someone who joins later sees the messages sent to everyone so far. **The chat is never saved: when the last person leaves the call, it is gone for good,**
  - raise a hand (there are no other reactions),
  - **point at and draw on a shared screen**, like a blackboard: on a shared screen made big or full screen, **Draw** turns on a pen. A tap shows a ring with your name at that spot for a few seconds; dragging draws a line in your colour. Drawings stay until someone taps the eraser, and someone who joins later sees what is already drawn. In the Android app, the person sharing their tablet's screen sees the drawings over what they are showing, along with a small label at the top naming whoever is talking (clear speech only, not the sounds of someone's house) and short notices when someone joins or leaves; the first time they share, the app explains and opens Android's "Display over other apps" switch (it can be turned on later under **⋯**),
  - **save a picture of a shared screen**, with what is drawn on it, with the download button: into the gallery in the Android app, through the share sheet in a phone's browser, as a download on a computer,
  - in full screen, see who is talking: their name shows small and faint in a corner,
  - see whose internet is weak: a small faint sign next to their name on their tile, after a few seconds of weak internet,
  - be reminded when they talk while muted. The muted microphone is only listened to on their own device, never sent,
  - see when their own internet is weak, which explains a voice or video that cuts out,
  - join from slow internet. Voices use little data, cameras are sent small, and a shared screen goes out at a few frames a second, which keeps writing sharp. Each person gets the biggest copy of each video their own internet can carry, so one slow connection slows nobody else down. When someone's internet can't keep up, the call stops downloading other people's cameras for them and says so, so the voices and the shared screen keep going. When a shared screen has to start again on weak internet (after a drop, or coming back to the app), the last picture of it stays on screen, marked "Weak internet: the screen will update soon", instead of a dark rectangle until the new picture arrives,
  - tap any tile to make it big, and tap it again to see everyone. A new shared screen stays in the grid until you choose it, so nobody's screen suddenly fills yours,
  - show a screen or camera full screen, and pinch or double-tap to zoom in on small writing. Pinching a shared screen outside full screen opens it full screen; the rest of the app never zooms, so it cannot get stuck zoomed in. Leaving full screen zooms back out; the small window over other apps on Android always shows the whole picture, and coming back finds the zoom as it was,
  - show someone's shared screen in dark colours (the moon button on the screen, or "Dark screen" in full screen); it changes only what you see, and your phone or computer remembers it,
  - turn the whole call down, or one person down with the slider under their name in the people list. This changes the sound only on their own device.
- **A cyberpunk look.** At night, near-black blue with neon cyan buttons and a magenta glow in the corners; by day, steel-white with deep magenta buttons. Squared letters (Chakra Petch; Arabic keeps Noto Naskh), sharp corners, buttons with cut corners and a faint still grid behind the screens before the call. The glows never flicker, and there are no pictures to download.
- **Light or dark.** The app starts light or dark, the same as your phone or computer, and changes along with it (for example when a phone turns dark in the evening). The sun or moon button switches to the other look: at the top of the name screen and of the screen before the call, and in the call under **⋯** (**Light mode** or **Dark mode**). Your phone or computer remembers that choice; choosing your device's own look again makes the app follow the device once more.
- **Nothing moves or flashes.** There are no animations, twinkling backgrounds, button glints or speaking glows, for everyone and with nothing to switch on or off. Full-screen buttons always stay visible.
- **Clear voices.** Every microphone is cleaned before it reaches the others: a noise filter on the device (RNNoise) takes out fans, traffic and keyboards, and the voice is made a little warmer and louder. Every voice is brought to the same level, whether someone speaks close to their phone or far from it, without turning up the sounds of a silent person's house. The teacher's voice (Ayman2) plays about 1.5 times as loud as the others. There is nothing to set.
- **Leaving** the call goes back to the screen with the switches, where **Change name** goes back to your name. That also signs this device out on the server, so the old sign-in stops working at once.
- **Delete my data.** A small link at the bottom of the screen before the call. After a question, it deletes your name, picture, notification devices and sign-ins from the server, on every device, and brings you back to the name screen as a new person. The invite link is still remembered, so joining again is just typing a name.
- **Phones.** Screens stay awake during a call, and the app reconnects by itself after a network drop. A tablet sharing its screen keeps sharing through a drop, however long the app takes to come back, as long as it is still in the call. On Android, the phone vibrates twice when someone else joins your call (there is no sound). In the Android app, a call keeps going while you use another app, with a "You are in a voice call" notification and a Leave call button, and a camera or shared screen shrinks into a small window on top of your other apps. The phone apps can still show a notification when someone starts the call. On Android, the phone's own echo cancelling is always on in a call, so nobody hears their voice come back from someone on speaker; for that the microphone is opened as the call starts even when you join muted, and stays muted until you unmute (Android shows its microphone dot). In the Android app, the sound moves to earphones whenever they are plugged in, also after taking them out during the call.

## A message you can send to your friends

> Majlis has changed a little: everyone was signed out once, so you may be asked to type your name again. Just type it and tap Join call as before. There is also a new small link at the bottom of the screen before the call, "Delete my data": if you ever want us to forget your name and picture, tap it. Nothing else changes; the chat inside the call is still deleted when everyone has left.

## Setting up the server

### Configuration

| Variable | Required | Meaning |
| --- | --- | --- |
| `NODE_ENV` | production | Set to `production` on the deployed server. |
| `JWT_SECRET` | production | Random secret of at least 32 characters that signs sessions. |
| `DATA_DIR` | production | Persistent directory for the SQLite database and its backups (`/var/lib/majlis/data` on our server). |
| `ALLOWED_ORIGINS` | production | Comma-separated exact origins allowed to use the site, such as `https://majlis.167-233-162-224.sslip.io`. |
| `INVITE_KEY` | production | The secret inside the invite link, at least 12 characters. Nobody types it, so make it long and random. The invite link is `https://<your site>/?invite=<INVITE_KEY>`. |
| `OPEN_JOIN` | no | Set to `1` to let the site's plain address work like the invite link, so anyone who opens it can join. Leave it unset to keep the invite link needed. To close the server again afterwards, unset it and change `INVITE_KEY`. |
| `SERVER_NAME` | no | The home room's name, shown on the join screen, in the browser tab and under the home-screen icon. |
| `MOVED_TO` | no | Only on an old host after the site moves: its new address, such as `https://majlis.167-233-162-224.sslip.io`. Every page and link, invite key included, is sent there. |
| `ROOM_CREATION_KEY` | to make rooms | The secret that lets you make new rooms on the live site at `https://<your site>/new?key=<ROOM_CREATION_KEY>`. Without it, making rooms is closed on the live site. |
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | for calls | Credentials of a LiveKit server (ours runs on Hetzner, not LiveKit Cloud: see docs/notes/call-server.md). Without them the app opens but calls cannot start. |
| `FCM_SERVICE_ACCOUNT` | for Android app notifications | The Firebase service account JSON file, pasted whole or in base64 (see below). |
| `APNS_KEY`, `APNS_KEY_ID`, `APNS_TEAM_ID` | for iPhone app notifications | Apple's push key: the `.p8` file's contents (or base64), its Key ID, and your Team ID (see below). |
| `APNS_BUNDLE_ID` | no | The iPhone app's bundle ID; `com.samycc777.majlis` by default. |
| `APNS_PRODUCTION` | no | Set to `false` only for an iPhone app run straight from Xcode; TestFlight and App Store apps use Apple's normal service. |

Browser notifications need no configuration: the server makes its own Web Push keys the first time and keeps them in the database. They are signed with the first `https://` address in `ALLOWED_ORIGINS`.

In production the server refuses to start if a required variable is missing or too short. After ten wrong invite keys in a minute, a network address must wait a minute before trying again.

**Changing the invite key** signs out everyone, and only people with the new link can come back. Do this if the link reaches someone it shouldn't: there are no admins who could remove a person.

### Deploying

The site runs on our own Hetzner machine, next to the call server; how it is set up is in [docs/notes/hosting.md](docs/notes/hosting.md), and the call server in [docs/notes/call-server.md](docs/notes/call-server.md).

**Pushing `main` to GitHub redeploys the live site within about two minutes** whenever `server/`, `client/` or the build files change, and the restart **disconnects every call**. Deploy outside call times; changes only to `mobile/` or the docs leave the site running. Changing a setting in `/etc/majlis/env` needs a restart too.

The app keeps its database in one folder, so it must run as a single instance. Who is online and who is in each call are held in memory, so a restart disconnects every call; everyone rejoins by tapping Join call again.

The server copies its database into `backups/` inside `DATA_DIR` every time it starts and once a day, keeping the newest seven. Before it changes the database's layout (after an update), it makes one more copy ending in `-before-v<number>.db`, which it never deletes. To go back: stop the service, copy the backup you want over `chat.db` in `DATA_DIR` (and delete `chat.db-wal` and `chat.db-shm` next to it if they exist), then start the service again. Anything people did after that backup is lost, so do this outside call times.

### Setting up notifications for the phone apps

Browsers get notifications straight away. The phone apps need two one-time setups, because Google and Apple only deliver notifications to apps whose owner has a key. Until then, the apps work normally and Settings says notifications aren't set up yet.

**Android (Firebase, free):**

1. Go to <https://console.firebase.google.com>, **Create a project** (any name, e.g. "Majlis"; Google Analytics can be off).
2. In the project, click the Android icon to **add an Android app** with the package name `com.samycc777.majlis`. Download `google-services.json` and put it in `mobile/android/app/`. Skip the other steps Firebase suggests; they are already done.
3. **Project settings → Service accounts → Generate new private key**. This downloads a JSON file. Keep it secret: it lets anyone send notifications as your app.
4. On the server, add `FCM_SERVICE_ACCOUNT` to `/etc/majlis/env` and paste the whole content of that file (or its base64, from `base64 -i file.json`).
5. Build a new Android app (`google-services.json` is read at build time) and send it out through Google Play as usual.

**iPhone (needs the paid Apple developer account):**

1. At <https://developer.apple.com/account/resources/authkeys/list>, click **+**, name the key "Majlis push", tick **Apple Push Notifications service (APNs)**, continue and **Download** the `.p8` file. Apple lets you download it only once, so keep it safe.
2. Note the **Key ID** shown for the key, and your **Team ID** (top right of the developer site, or under Membership).
3. On the server, set `APNS_KEY` to the content of the `.p8` file (or its base64), `APNS_KEY_ID` to the Key ID and `APNS_TEAM_ID` to the Team ID.
4. In Xcode, the App target's **Signing & Capabilities** already lists Push Notifications; archive and upload a new TestFlight build as usual.

The server turns each route on by itself once its variables are set; redeploy (outside call times) after adding them.

### Privacy

Call audio and video pass through our LiveKit server, encrypted in transit; LiveKit's end-to-end encryption is turned off. Nothing from a call is stored: there is no recording, and the call chat is held in memory only until the last person leaves. The server keeps each person's name, profile picture, the rooms they joined and their sessions (one per device, for a month). Going back to the name screen ends that device's session on the server too. `DELETE /api/me` deletes everything the server keeps about the person asking, on every device; the lobby's **Delete my data** link calls it. Backups hold the data a little longer: the routine copies are replaced within about a week, and a copy made before a database update stays until someone deletes it. For notifications, the server keeps each device's notification address (from the browser, Google or Apple) until the person signs out or the service says it is no longer valid; a notification's text passes through the browser's push service (encrypted), or through Google's or Apple's service for the phone apps.

## Rooms

The home room is the one the server started with. Its invite key is `INVITE_KEY` and its name is `SERVER_NAME`. Sessions from before rooms existed belong to it, so nobody was signed out when rooms arrived.

Any other room is made at `/new`: type a name and the page gives the room's invite link, `https://<your site>/?invite=<key>`, with a key of 30 random letters and digits. Until paying for a room exists, the live site makes rooms only with `ROOM_CREATION_KEY` (open `/new?key=<ROOM_CREATION_KEY>` once; the device remembers it). On a developer's computer anyone can make one.

Each room has one call, and everything stays inside it: who is online, who is in the call, raised hands, the call chat and call notifications. A device is in one room at a time: opening another room's link moves it there. The same person keeps their name across rooms.

The owner looks after customers' rooms with the same `ROOM_CREATION_KEY` (there is no page for it yet; the room's ID is in the answer that made it, and in the database). Both are rate-limited and refuse a wrong key:

```sh
# A new invite key, for a link that went where it should not. Everyone with the old link is out at once.
curl -X POST https://<your site>/api/rooms/<room id>/new-key -H 'Content-Type: application/json' -d '{"creationKey":"<ROOM_CREATION_KEY>"}'
# Delete the room: its call, its sessions, and the people who were in no other room.
curl -X DELETE https://<your site>/api/rooms/<room id> -H 'Content-Type: application/json' -d '{"creationKey":"<ROOM_CREATION_KEY>"}'
```

The home room has neither: change `INVITE_KEY` instead, which signs out everyone without the new link.

## Development

```sh
npm ci
npm --prefix client ci
npm run dev        # server on port 3001, web app on https://localhost:5173/?invite=0000
npm test           # server tests
npm run check      # everything CI runs: typecheck, lint, tests (Node 24, see .nvmrc)
```

Development uses built-in defaults: invite key `0000` and a development-only signing key, with the database stored in the repository directory. For calls on your own computer, install LiveKit (`brew install livekit`), run `livekit-server --dev`, and start the app with `LIVEKIT_URL=ws://127.0.0.1:7880 LIVEKIT_API_KEY=devkey LIVEKIT_API_SECRET=secret npm run dev`. The tests start a real server on a temporary database and stand in for LiveKit with a small local fake, so they need no LiveKit at all.

**Trying it on an Android phone.** Connect the phone with wireless debugging (Developer options → Wireless debugging; pair it once with `adb pair`, then `adb connect <address shown on the phone>`), and keep it on the same Wi-Fi as this computer. `npm run dev:phone` then starts LiveKit, the server and the web app over plain http, and points the phone's `localhost` at this computer. Build the test app with `cd mobile && HANGOUT_URL="http://localhost:5173/?invite=0000" npm run build:android`, install it with `adb install -r android/app/build/outputs/apk/debug/app-debug.apk`, and open `http://localhost:5173/?invite=0000` in this computer's browser to call the phone.

`npm run build` compiles the server and builds the web app; `npm start` then serves both from one process.

## Phone apps

The iPhone and Android apps are in `mobile/`; see [its README](mobile/README.md) for building the APK and sending the iPhone app through TestFlight.
