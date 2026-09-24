# Majlis (Hangout)

Majlis (called Hangout in the code) is a small Discord-style server for a group of friends: text channels to chat and share pictures and PDFs, and voice channels that work like a Zoom call, where anyone can talk, turn on their camera and share their screen. There are no admins: everyone can do everything. The interface is in English and Arabic, Arabic is set in Noto Naskh Arabic with room for the vowel marks, and the ع button opens an on-screen Arabic keyboard.

It runs as one Node.js process (Express, Socket.IO, SQLite) serving a Vue 3 web app, with calls carried by [LiveKit](https://livekit.io). The same web app is wrapped as an iPhone app and an Android app in `mobile/`, so all three look and work the same.

## What everyone can do

- **Join with the invite link.** Open the link a friend sent and type your name once. Nobody types a code: the key is inside the link. The app remembers you, so next time it opens straight into the server. The invite button (the person with a +) next to the server's name copies the link, or opens the share sheet on a phone.
- **Text channels.** Messages, replies, edits, links, images and PDFs, in channels such as #general. Everyone can delete their own messages. Earlier history loads a page at a time.
- **Voice channels.** Tap a voice channel to join its call; your microphone starts on, and one tap mutes it. Everyone in the server sees who is in each voice channel, under its name in the channel list. In a call, anyone can:
  - turn their camera on,
  - share their screen from a computer or the Android app (Android first asks "Share your screen with Hangout?"; a notification with a Stop sharing button stays while it lasts, and the voice keeps going while another app is shown). A shared browser tab on a computer can bring its sound along. iPhones and phone browsers cannot share their screen yet,
  - raise a hand and send reactions,
  - tap any tile to make it big, and tap it again to see everyone. A screen someone starts sharing is made big for everyone automatically,
  - turn the whole call down under More, or turn one person down with the slider under their name in Participants. This changes the sound only on their own device and is remembered.
- **Keep talking while you read.** Like Discord, the call keeps going when you open a text channel. The "Voice connected" panel at the bottom of the channel list mutes you or hangs up.
- **Make channels.** The + next to Text channels or Voice channels creates one. The gear next to a channel renames or deletes it. Deleting a text channel deletes its messages and files for everyone; the last text channel cannot be deleted.
- **Settings.** The gear next to your name at the bottom changes the text size, dark or light theme and language, and signs you out.
- **Phones.** On a phone the channel list slides in from the ☰ button. Screens stay awake during a call, and the app reconnects by itself after a network drop. If a phone switches to another app during a call, the sound comes back by itself when you return; if it ever stays silent, tap the speaker button at the top of the call.

## A message you can send to your friends

> Here is our server: `<invite link>`. Open it and type your name. On iPhone, install the TestFlight invite I send you, or open the link in Safari and choose Share → Add to Home Screen. On Android, install the APK I send you. Tap a 🔊 voice channel to join the call.

## Setting up the server

### Configuration

| Variable | Required | Meaning |
| --- | --- | --- |
| `NODE_ENV` | production | Set to `production` on the deployed server. |
| `JWT_SECRET` | production | Random secret of at least 32 characters that signs sessions. |
| `DATA_DIR` | production | Persistent directory for the SQLite database and uploads (a Railway Volume). |
| `ALLOWED_ORIGINS` | production | Comma-separated exact origins allowed to use the site, such as `https://your-app.up.railway.app`. |
| `INVITE_KEY` | production | The secret inside the invite link, at least 12 characters. Nobody types it, so make it long and random. The invite link is `https://<your site>/?invite=<INVITE_KEY>`. |
| `SERVER_NAME` | no | Name shown at the top of the channel list, on the join screen, in the browser tab and under the home-screen icon. |
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | for calls | Credentials of a LiveKit Cloud project. Without them the text channels work but calls cannot start. |
| `MAX_UPLOAD_BYTES` | no | Largest upload in bytes; 100 MB by default. |

In production the server refuses to start if a required variable is missing or too short. After ten wrong invite keys in a minute, a network address must wait a minute before trying again.

**Changing the invite key** signs out everyone, and only people with the new link can come back. Do this if the link reaches someone it shouldn't: there are no admins who could remove a person.

### Deploying on Railway

1. Create a Railway service from this repository. `railway.json` already sets the build (`npm run build`), the start command, and the `/api/health` health check.
2. Add a Volume and set `DATA_DIR` to its mount path.
3. Set the variables above as service variables, including a public domain in `ALLOWED_ORIGINS`.
4. For calls, create a LiveKit Cloud project and copy its URL, API key and API secret into the `LIVEKIT_*` variables. Leave recording and egress off.

The app keeps its database and uploads on the one volume, so it must run as a single instance. Who is online and who is in each call are held in memory, so a restart disconnects every call; everyone rejoins by tapping the voice channel again. Back up the volume if the chat history matters to you.

### Privacy

Uploaded files are only served to signed-in members, and their contents are checked to be real images or PDFs. Call audio and video pass through LiveKit Cloud, encrypted in transit; LiveKit's end-to-end encryption is turned off. Nothing is recorded. Deleting a message removes its text and file from the server.

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
