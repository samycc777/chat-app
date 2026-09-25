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
  - be reminded when they talk while muted: "You're muted. Tap the microphone to talk." The muted microphone is only listened to on their own device, never sent,
  - see when their own internet is weak, which explains a voice or video that cuts out,
  - tap any tile to make it big, and tap it again to see everyone. A screen someone starts sharing is made big for everyone automatically,
  - show a screen or camera full screen, with the square button on it, Full screen under More, or by turning a phone sideways while it is big. It then fills the whole screen with nothing else on it, and a wide screen turns a phone sideways. Pinch or double-tap to zoom in on small writing (the mouse wheel or a double click on a computer), and drag to move around. A tap brings back the buttons: Exit full screen, Zoom out, and the microphone, so you can answer without leaving. Full screen closes by itself when the screen stops being shared. In the Android app (version 1.2 and newer) it also hides the phone's own bars, and Back leaves it,
  - turn the whole call down under More, or turn one person down with the slider under their name in Participants. This changes the sound only on their own device and is remembered.
- **Clear voices.** Every microphone is cleaned before it reaches the others: a noise filter on the device (RNNoise) takes out fans, traffic and keyboards, the voice is made a little warmer without muffling letters such as س, ص, ث and ش, and a little louder. There is nothing to set.
- **Keep talking while you read.** Like Discord, the call keeps going when you open a text channel. The "Voice connected" panel at the bottom of the channel list mutes you or hangs up.
- **Make channels.** The + next to Text channels or Voice channels creates one. The gear next to a channel renames or deletes it. Deleting a text channel deletes its messages and files for everyone; the last text channel cannot be deleted.
- **Notifications.** When the app is not in front of you, your phone or computer tells you about new messages ("Salma in #general"), about messages that mention you or @everyone ("Salma mentioned you in #general"), and when someone starts a call in an empty voice channel ("Salma started a call in 🔊 Lesson", at most once every 5 minutes per channel). Photos, voice messages, videos and files are described in words. Notifications of the same channel replace each other instead of piling up, and tapping one opens that channel. Nobody is notified about their own messages, and nothing arrives while you are looking at the app. The first time, a small card asks "Get a notification when friends write or start a call?"; **Turn on** asks the device for permission, and **Not now** is remembered on that device. The app has no sound of its own: the phone's usual notification behaviour applies. It works in browsers on computers and Android, on iPhone once the site is added to the Home Screen (iOS 16.4 and newer), and in the phone apps once they are set up (see below). Signing out stops notifications on that device.
- **Settings.** The gear next to your name at the bottom changes the text size, dark or light theme and language, chooses your notifications (**Everything**, **Only mentions and calls**, or **Off**, for all your devices), turns notifications on for this device or explains why it can't, and signs you out.
- **Phones.** On a phone the channel list slides in from the ☰ button. Screens stay awake during a call, and the app reconnects by itself after a network drop. In the Android app, a call keeps going while you use another app: a "You are in a voice call" notification stays while you're in a call, with a Leave call button. If someone's camera or shared screen is showing when you leave the app, the call shrinks into a small window on top of your other apps, as in a WhatsApp video call: it shows the shared screen, or else whoever spoke last with their camera on. Tap it to go back to the call, or close it with its ✕ to keep only the sound. There is no small window while you share your own screen, because it would show up in what you share. In a phone browser, the sound may stop while you're in another app and comes back by itself when you return; if it ever stays silent, tap the speaker button at the top of the call.

## A message you can send to your friends

> Here is our server: `<invite link>`. Open it and type your name. On iPhone, install the TestFlight invite I send you, or open the link in Safari and choose Share → Add to Home Screen. On Android, install the APK I send you. Tap a 🔊 voice channel to join the call. When the app asks about notifications, tap Turn on to hear when we write or start a call.

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
| `FCM_SERVICE_ACCOUNT` | for Android app notifications | The Firebase service account JSON file, pasted whole or in base64 (see below). |
| `APNS_KEY`, `APNS_KEY_ID`, `APNS_TEAM_ID` | for iPhone app notifications | Apple's push key: the `.p8` file's contents (or base64), its Key ID, and your Team ID (see below). |
| `APNS_BUNDLE_ID` | no | The iPhone app's bundle ID; `com.samycc777.majlis` by default. |
| `APNS_PRODUCTION` | no | Set to `false` only for an iPhone app run straight from Xcode; TestFlight and App Store apps use Apple's normal service. |

Browser notifications need no configuration: the server makes its own Web Push keys the first time and keeps them in the database. They are signed with the first `https://` address in `ALLOWED_ORIGINS`.

In production the server refuses to start if a required variable is missing or too short. After ten wrong invite keys in a minute, a network address must wait a minute before trying again.

**Changing the invite key** signs out everyone, and only people with the new link can come back. Do this if the link reaches someone it shouldn't: there are no admins who could remove a person.

### Deploying on Railway

1. Create a Railway service from this repository. `railway.json` already sets the build (`npm run build`), the start command, and the `/api/health` health check.
2. Add a Volume and set `DATA_DIR` to its mount path.
3. Set the variables above as service variables, including a public domain in `ALLOWED_ORIGINS`.
4. For calls, create a LiveKit Cloud project and copy its URL, API key and API secret into the `LIVEKIT_*` variables. Leave recording and egress off.

The app keeps its database and uploads on the one volume, so it must run as a single instance. Who is online and who is in each call are held in memory, so a restart disconnects every call; everyone rejoins by tapping the voice channel again. Back up the volume if the chat history matters to you.

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

Uploaded files are only served to signed-in members, and their contents are checked to be real images or PDFs. Call audio and video pass through LiveKit Cloud, encrypted in transit; LiveKit's end-to-end encryption is turned off. Nothing is recorded. Deleting a message removes its text and file from the server. For notifications, the server keeps each device's notification address (from the browser, Google or Apple) until the person signs out or the service says it is no longer valid; a notification's text passes through the browser's push service (encrypted), or through Google's or Apple's service for the phone apps.

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
