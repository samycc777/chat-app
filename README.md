# Majlis (Hangout)

Majlis (called Hangout in the code) is one call room for a group of friends and for the Arabic class: anyone can talk, turn on their camera and share their screen, like a Zoom call. There are no channels, no admins and no settings. The interface is in English and Arabic.

It runs as one Node.js process (Express, Socket.IO, SQLite) serving a Vue 3 web app, with calls carried by [LiveKit](https://livekit.io). The same web app is wrapped as an iPhone app and an Android app in `mobile/`, so all three look and work the same.

Since September 2026 one server can hold many rooms, one per customer, as the first step to Majlis being a call app anyone can pay for. Each room has its own name, invite link and call, and nobody in one room can see or hear anyone in another. The friends' and the class's room is the **home room**: its link and everything in it is unchanged, and it is never billed. See [Rooms](#rooms).

Until September 2026 Majlis was a Discord-style server with text channels, voice messages, search, pins, notifications of messages and call recording. The app no longer shows any of that; the server still has the code and keeps the old messages, but nothing in the app reaches them.

## What everyone can do

- **Type your name.** Every time the app opens, it asks for your name, already filled in with the one you used last time on that device, so it is one tap to go on. Change it there if you like. The first time, you open the invite link a friend sent; nobody types a code, because the key is inside the link. When the server has `OPEN_JOIN` on, the site's plain address works the same way.
- **Invite someone.** Before joining, **Copy invite link** copies the link to the room you are in, ready to send.
- **See who is in the call, then join.** The next screen shows who is in the call right now, and two big switches for your microphone and camera, so you choose before anyone hears or sees you. With the camera on you see yourself first. Your choice is remembered for next time. Then tap **Join call**.
- **In the call**, anyone can:
  - mute and unmute, and turn their camera on and off. If the microphone will not turn on, the call says why and what to change: the browser's permission, the computer's privacy settings (Windows or Mac), another app using it, or no microphone plugged in,
  - share their screen from a computer or the Android app (Android first asks "Share your screen with Hangout?"; a notification with a Stop sharing button stays while it lasts). A shared browser tab on a computer can bring its sound along. iPhones and phone browsers cannot share their screen yet,
  - **chat**, with the speech-bubble button at the top: to everyone in the call, or privately to one person, chosen in the **To** list or with the message button next to their name in the people list. A private message is seen only by its two people. New messages pop up for a moment and are counted on the button. Someone who joins later sees the messages sent to everyone so far. **The chat is never saved: when the last person leaves the call, it is gone for good,**
  - raise a hand and send reactions,
  - be reminded when they talk while muted. The muted microphone is only listened to on their own device, never sent,
  - see when their own internet is weak, which explains a voice or video that cuts out,
  - join from slow internet. Voices use little data, cameras are sent small, and a shared screen goes out at a few frames a second, which keeps writing sharp. Each person gets the biggest copy of each video their own internet can carry, so one slow connection slows nobody else down. When someone's internet can't keep up, the call stops downloading other people's cameras for them and says so, so the voices and the shared screen keep going,
  - tap any tile to make it big, and tap it again to see everyone. A screen someone starts sharing is made big for everyone automatically,
  - show a screen or camera full screen, and pinch or double-tap to zoom in on small writing,
  - show someone's shared screen in dark colours (the moon button on the screen, or "Dark screen" in full screen); it changes only what you see, and your phone or computer remembers it,
  - turn the whole call down, or one person down with the slider under their name in the people list. This changes the sound only on their own device.
- **Clear voices.** Every microphone is cleaned before it reaches the others: a noise filter on the device (RNNoise) takes out fans, traffic and keyboards, and the voice is made a little warmer and louder. There is nothing to set.
- **Leaving** the call goes back to the screen with the switches, where **Change name** goes back to your name.
- **Phones.** Screens stay awake during a call, and the app reconnects by itself after a network drop. On Android, the phone vibrates twice when someone else joins your call (there is no sound). In the Android app, a call keeps going while you use another app, with a "You are in a voice call" notification and a Leave call button, and a camera or shared screen shrinks into a small window on top of your other apps. The phone apps can still show a notification when someone starts the call. On Android, the phone's own echo cancelling is always on in a call, so nobody hears their voice come back from someone on speaker; for that the microphone is opened as the call starts even when you join muted, and stays muted until you unmute (Android shows its microphone dot). In the Android app, the sound moves to earphones whenever they are plugged in, also after taking them out during the call.

## A message you can send to your friends

> Majlis has changed: it is now just one call room. Open the app, check your name, choose whether your microphone and camera start on, and tap Join call. There is a chat inside the call, including private messages, and it is deleted when everyone has left.

## Setting up the server

### Configuration

| Variable | Required | Meaning |
| --- | --- | --- |
| `NODE_ENV` | production | Set to `production` on the deployed server. |
| `JWT_SECRET` | production | Random secret of at least 32 characters that signs sessions. |
| `DATA_DIR` | production | Persistent directory for the SQLite database and uploads (a Railway Volume). |
| `ALLOWED_ORIGINS` | production | Comma-separated exact origins allowed to use the site, such as `https://your-app.up.railway.app`. |
| `INVITE_KEY` | production | The secret inside the invite link, at least 12 characters. Nobody types it, so make it long and random. The invite link is `https://<your site>/?invite=<INVITE_KEY>`. |
| `OPEN_JOIN` | no | Set to `1` to let the site's plain address work like the invite link, so anyone who opens it can join. Leave it unset to keep the invite link needed. To close the server again afterwards, unset it and change `INVITE_KEY`. |
| `SERVER_NAME` | no | The home room's name, shown on the join screen, in the browser tab and under the home-screen icon. |
| `ROOM_CREATION_KEY` | to make rooms | The secret that lets you make new rooms on the live site at `https://<your site>/new?key=<ROOM_CREATION_KEY>`. Without it, making rooms is closed on the live site. |
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | for calls | Credentials of a LiveKit Cloud project. Without them the text channels work but calls cannot start. |
| `MAX_UPLOAD_BYTES` | no | Largest upload in bytes; 100 MB by default. |
| `MAX_RECORDING_BYTES` | no | Largest call recording in bytes; 2 GB by default (about eight hours). A recording that reaches it stops, and what was recorded is kept. |
| `FCM_SERVICE_ACCOUNT` | for Android app notifications | The Firebase service account JSON file, pasted whole or in base64 (see below). |
| `APNS_KEY`, `APNS_KEY_ID`, `APNS_TEAM_ID` | for iPhone app notifications | Apple's push key: the `.p8` file's contents (or base64), its Key ID, and your Team ID (see below). |
| `APNS_BUNDLE_ID` | no | The iPhone app's bundle ID; `com.samycc777.majlis` by default. |
| `APNS_PRODUCTION` | no | Set to `false` only for an iPhone app run straight from Xcode; TestFlight and App Store apps use Apple's normal service. |

Browser notifications need no configuration: the server makes its own Web Push keys the first time and keeps them in the database. They are signed with the first `https://` address in `ALLOWED_ORIGINS`.

In production the server refuses to start if a required variable is missing or too short. After ten wrong invite keys in a minute, a network address must wait a minute before trying again.

**Changing the invite key** signs out everyone, and only people with the new link can come back. Do this if the link reaches someone it shouldn't: there are no admins who could remove a person.

### Deploying on Railway

1. Create a Railway service from this repository. `railway.json` already sets the build (`npm run build`), the start command, and the `/api/health` health check. It also redeploys only when the website or server changes (`watchPatterns`), because a redeploy disconnects every call; changes in `mobile/` alone leave the site running.
2. Add a Volume and set `DATA_DIR` to its mount path.
3. Set the variables above as service variables, including a public domain in `ALLOWED_ORIGINS`.
4. For calls, create a LiveKit Cloud project and copy its URL, API key and API secret into the `LIVEKIT_*` variables. Leave LiveKit's own recording (egress) off: calls are recorded in the browser of whoever presses Record.

The app keeps its database and uploads on the one volume, so it must run as a single instance. Who is online and who is in each call are held in memory, so a restart disconnects every call; everyone rejoins by tapping the voice channel again. Back up the volume if the chat history matters to you.

Recordings are kept on the same volume as the other files, and they are the largest: an hour of lesson is roughly 150 to 250 MB, so a 5 GB volume holds about 20 hours. Give the volume room for the recordings you want to keep, and delete old recording messages when it fills up; deleting the message frees its space.

### Setting up notifications for the phone apps

Browsers get notifications straight away. The phone apps need two one-time setups, because Google and Apple only deliver notifications to apps whose owner has a key. Until then, the apps work normally and Settings says notifications aren't set up yet.

**Android (Firebase, free):**

1. Go to <https://console.firebase.google.com>, **Create a project** (any name, e.g. "Majlis"; Google Analytics can be off).
2. In the project, click the Android icon to **add an Android app** with the package name `com.samycc777.majlis`. Download `google-services.json` and put it in `mobile/android/app/`. Skip the other steps Firebase suggests; they are already done.
3. **Project settings → Service accounts → Generate new private key**. This downloads a JSON file. Keep it secret: it lets anyone send notifications as your app.
4. On Railway, add the variable `FCM_SERVICE_ACCOUNT` and paste the whole content of that file (or its base64, from `base64 -i file.json`).
5. Build a new Android app (`google-services.json` is read at build time) and send it out through Google Play as usual.

**iPhone (needs the paid Apple developer account):**

1. At <https://developer.apple.com/account/resources/authkeys/list>, click **+**, name the key "Majlis push", tick **Apple Push Notifications service (APNs)**, continue and **Download** the `.p8` file. Apple lets you download it only once, so keep it safe.
2. Note the **Key ID** shown for the key, and your **Team ID** (top right of the developer site, or under Membership).
3. On Railway, set `APNS_KEY` to the content of the `.p8` file (or its base64), `APNS_KEY_ID` to the Key ID and `APNS_TEAM_ID` to the Team ID.
4. In Xcode, the App target's **Signing & Capabilities** already lists Push Notifications; archive and upload a new TestFlight build as usual.

The server turns each route on by itself once its variables are set; redeploy (outside call times) after adding them.

### Privacy

Uploaded files are only served to signed-in members, and their contents are checked to be real images, PDFs, sound or video. Call audio and video pass through LiveKit Cloud, encrypted in transit; LiveKit's end-to-end encryption is turned off. A call is recorded only when someone in it presses Record, and everyone in the call then sees a red "Recording" sign with that person's name. The recording is made in that person's browser, not by LiveKit, and is posted in a text channel for all members like any other file. Otherwise nothing from a call is stored. A video is played from a link with a pass for that one file that lasts six hours. Deleting a message removes its text and file from the server. For notifications, the server keeps each device's notification address (from the browser, Google or Apple) until the person signs out or the service says it is no longer valid; a notification's text passes through the browser's push service (encrypted), or through Google's or Apple's service for the phone apps.

## Rooms

The home room is the one the server started with. Its invite key is `INVITE_KEY` and its name is `SERVER_NAME`; it alone keeps the old text channels, files and recordings. Sessions from before rooms existed belong to it, so nobody was signed out when rooms arrived.

Any other room is made at `/new`: type a name and the page gives the room's invite link, `https://<your site>/?invite=<key>`, with a key of 30 random letters and digits. Until paying for a room exists, the live site makes rooms only with `ROOM_CREATION_KEY` (open `/new?key=<ROOM_CREATION_KEY>` once; the device remembers it). On a developer's computer anyone can make one.

Each room has one call, and everything stays inside it: who is online, who is in the call, raised hands, the call chat and call notifications. A device is in one room at a time: opening another room's link moves it there. The same person keeps their name across rooms.

## Development

```sh
npm install
npm --prefix client install
npm run dev        # server on port 3001, web app on https://localhost:5173/?invite=0000
npm test           # server tests
```

Development uses built-in defaults: invite key `0000` and a development-only signing key, with the database and uploads stored in the repository directory. For calls on your own computer, install LiveKit (`brew install livekit`), run `livekit-server --dev`, and start the app with `LIVEKIT_URL=ws://127.0.0.1:7880 LIVEKIT_API_KEY=devkey LIVEKIT_API_SECRET=secret npm run dev`. The tests start a real server on a temporary database and stand in for LiveKit with a small local fake, so they need no LiveKit at all.

**Trying it on an Android phone.** Connect the phone with wireless debugging (Developer options → Wireless debugging; pair it once with `adb pair`, then `adb connect <address shown on the phone>`), and keep it on the same Wi-Fi as this computer. `npm run dev:phone` then starts LiveKit, the server and the web app over plain http, and points the phone's `localhost` at this computer. Build the test app with `cd mobile && HANGOUT_URL="http://localhost:5173/?invite=0000" npm run build:android`, install it with `adb install -r android/app/build/outputs/apk/debug/app-debug.apk`, and open `http://localhost:5173/?invite=0000` in this computer's browser to call the phone.

`npm run build` compiles the server and builds the web app; `npm start` then serves both from one process.

## Phone apps

The iPhone and Android apps are in `mobile/`; see [its README](mobile/README.md) for building the APK and sending the iPhone app through TestFlight.
