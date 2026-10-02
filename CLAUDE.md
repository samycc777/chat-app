# Majlis (Hangout)

A Zoom-like call app with many rooms, one per customer; the first step to selling it as a call app for anyone (plan: rooms, then neutral name and English-first look, then Stripe payment, then a website). The friends' room is the **home room**, free forever; other customers will pay. In each room anyone can talk, show their camera, share their screen and chat. Three screens: your name (remembered), the lobby (who is in the call, microphone and camera switches), the call.
- The app shows only the call: no channels, text chat, search, pins, settings or recording. The server still holds that old code and messages, unused.
- It replaced the Arabic class app at the class's own address (the teacher shares his Android tablet's screen in lessons).
- People see it as **Majlis** (Android package `com.samycc777.majlis`); code and docs still say Hangout.
- The README describes every feature from the friends' point of view; read it before changing behaviour.

## Rules

- What customers see (name, wording, look, website) must stay neutral: nothing tied to Islam or Arabic learning. Arabic stays one language among others.
- Keep every flow simple (friends are not tech-savvy): people join by opening an invite link and typing their name, nothing else; no admin roles, no unneeded settings, plain wording.
- Never touch `chat.db*` or `uploads/` (local development data).

## Layout

- `server/` — Node.js (Express 5, Socket.IO, better-sqlite3), TypeScript compiled to `dist/`. `index.ts`, `config.ts` (env vars), `database.ts`, `auth.ts` (invite-key join, month-long session tokens that name a `roomId`), `rooms.ts` (home room `'home'` with key `INVITE_KEY`; customer rooms in the `rooms` table; `POST /api/rooms` needs `ROOM_CREATION_KEY` in production; each Socket.IO connection stays in `room:<roomId>`), `voice.ts` (calls, one LiveKit room `voice-<channelId>`; call chat is never stored), `socket.ts`, `routes.ts`, `push.ts` (notification wording in en and ar lives there), `livekit.ts`, plus unused text-channel code.
- `client/` — Vue 3 + Vite + TypeScript, `<script setup>`. `App.vue` shell: `CreateRoom.vue` at `/new`, else `Auth.vue` then `CallLobby.vue` then `CallView.vue` (lazy-loaded with LiveKit). Styles are scoped per component; `styles.css` holds only shared theme variables (`[data-theme]`, `--call-*` colours: use them instead of fixed colours except over video) and common classes. Scoped rules are more specific than global ones: put overrides next to the rule they override.
- `mobile/` — Capacitor wrapper loading the live site (web changes reach the apps without a rebuild; native changes need a new app version). Release Android: `cd mobile && npm run release:android` (builds and sends to Google Play internal testing; see mobile/README.md). Test APK: `HANGOUT_URL=... npm run build:android` (Gradle 9.3, Android Studio's Java).
- `tests/security.test.mjs` — end-to-end server tests (real server, temporary database, fake LiveKit and push services).
- For the detailed file-by-file layout, read docs/notes/layout.md.

## Commands

```sh
npm run check   # server typecheck, client vue-tsc, oxlint, tests (~8 s) — run before every commit
npm test        # tests only
npm run dev     # server on :3001, client on https://localhost:5173/?invite=0000
```

- `npm run dev:phone` runs everything (LiveKit included) for an Android phone on wireless debugging; see the README's Development section.
- Real calls locally: `livekit-server --dev` (`brew install livekit`), then `LIVEKIT_URL=ws://127.0.0.1:7880 LIVEKIT_API_KEY=devkey LIVEKIT_API_SECRET=secret npm run dev`.

## Conventions

- Every new user-facing string goes in `client/src/i18n.ts` in both `en` and `ar`.
- When behaviour visible to the friends changes, update the README (and its message for friends if they need to know).
- New server behaviour gets a test in `tests/security.test.mjs`.
- Comments explain why, not what, in full sentences.
- Commit messages: short plain-English title from the friends' point of view ("Let anyone share their screen in a call"), then prose paragraphs on why and how.
- A server restart disconnects every call; avoid redeploying while friends are talking.
