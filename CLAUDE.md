# Majlis (Hangout)

A Discord-style server for a group of friends: text channels, and voice channels that work like a Zoom call (anyone can talk, show their camera and share their screen). It replaced the Arabic class app at the class's own address: one app, used both for lessons (the teacher shares his Android tablet's screen) and for hanging out, and the class chat became #general. People see it as **Majlis** (the app name, the Android package `com.samycc777.majlis`); the code and docs still call the project Hangout. The README describes every feature from the friends' point of view; read it before changing behaviour.

The friends are not all tech-savvy. Keep every flow simple: people join by opening an invite link and typing their name, and nothing else; no admin roles, no settings that aren't needed, plain-language wording.

## Layout

- `server/` — one Node.js process (Express 5, Socket.IO, better-sqlite3), TypeScript compiled to `dist/`.
  - `index.ts` wires everything up; `config.ts` reads env vars (`INVITE_KEY`, `SERVER_NAME`, ...); `database.ts` holds the schema and migrations, including the `channels` table.
  - `auth.ts` is joining with the invite key (`/api/auth/join`, rate-limited) and month-long session tokens.
  - `channels.ts` creates, renames and deletes channels. A text channel is also a `conversations` row, so messages and attachments keep their tables.
  - `voice.ts` keeps who is in each voice channel's call, in memory. Each voice channel is one LiveKit room, `voice-<channelId>`.
  - `routes.ts` is the REST API (`/api/...`: LiveKit tokens, message history, uploads, attachments).
  - `push.ts` sends notifications (new messages, mentions, call starts) to people whose app is not in front of them (`app_active`), through Web Push, Firebase (Android app) and Apple (iPhone app), and holds `/api/push/...`. Its notification wording, in English and Arabic, lives there because the phone shows it without the app.
  - `socket.ts` handles realtime events: messages, typing, `create_channel`/`rename_channel`/`delete_channel`, `voice_join`/`voice_leave`, `raise_hand`, `app_active`; it broadcasts `channels`, `voice_state` and presence.
  - `livekit.ts` is the LiveKit server client.
- `client/` — Vue 3 + Vite + TypeScript web app, `<script setup>` components.
  - `App.vue` is the shell: `components/ServerSidebar.vue` (channels, who is in calls, voice panel, settings), then `ChatView.vue` for a text channel or `CallView.vue` for a voice channel, then `MemberList.vue`. `CallView` (and LiveKit) is lazy-loaded and stays mounted while a text channel is open, so the call keeps going. `CallTile.vue` is one camera or screen tile.
  - `api.ts` (REST), `socket.ts` (Socket.IO), `types.ts` (shared types), `cleanVoice.ts` (every microphone's noise filter, tone and loudness), `nativeScreenShare.ts` (the bridge to the Android app's screen sharing), `notifications.ts` (asking for and registering notifications, reporting whether the app is in front, opening a tapped notification's channel; `public/sw.js` is its service worker, which caches nothing).
  - `i18n.ts` holds every user-facing string, in English and Arabic.
  - Each component's styles are in its own `<style scoped>` block. `styles.css` holds only what several components share: theme colours (`[data-theme]` variables, Discord's dark and light palettes), base elements, and common classes such as `.display-popover` and `.message-content`. Scoped rules are one attribute more specific than global ones; put overrides next to the rule they override.
- `mobile/` — Capacitor wrapper that turns the deployed website into the iPhone and Android apps. It has its own `package.json` and README; the apps load the live site, so web changes reach them without a rebuild. Notifications use `@capacitor/push-notifications`; `PushSetupPlugin.kt` tells the page whether the Android app was built with `google-services.json`. The Android app's other native code is screen sharing (`ScreenSharePlugin.kt`, `ScreenShareService.kt`): it joins the call as `<userId>:screen` with a pass from `/api/livekit/screen-token`, and the call screen shows that participant as its owner's screen. Changes there need a new APK; build with `cd mobile && HANGOUT_URL=... npm run build:android` (Gradle 9.3, run on Android Studio's Java).
- `tests/security.test.mjs` — end-to-end server tests: a real server on a temporary database, with a fake LiveKit and fake push services (a browser's, Google's and Apple's).

Never touch `chat.db*` or `uploads/`: they are the local development data.

## Commands

```sh
npm run check   # server typecheck, client vue-tsc, oxlint, and tests (~8 s) — run before every commit
npm test        # tests only
npm run dev     # server on :3001, client on https://localhost:5173/?invite=0000
```

`npm run dev:phone` runs everything (LiveKit included) for an Android phone on wireless debugging; see the README's Development section.

For real calls locally: `livekit-server --dev` (from `brew install livekit`), then `LIVEKIT_URL=ws://127.0.0.1:7880 LIVEKIT_API_KEY=devkey LIVEKIT_API_SECRET=secret npm run dev`.

## Conventions

- Every new user-facing string goes in `client/src/i18n.ts` in both `en` and `ar`.
- When behaviour visible to the friends changes, update the README, and the message for friends in it when they need to know.
- New server behaviour gets a test in `tests/security.test.mjs`.
- Comments explain why, not what, in full sentences.
- Commit messages: a short plain-English title describing the change from the friends' point of view ("Let anyone share their screen in a call"), then prose paragraphs explaining why and how.
- A server restart disconnects every call; avoid redeploying while friends are talking.
