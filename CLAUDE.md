# Majlis (Hangout)

A Zoom-like call app with many rooms, one per customer; the first step to selling it as a call app for anyone (plan: rooms, then neutral name and English-first look, then Stripe payment, then a website). The friends' room is the **home room**, free forever; other customers will pay. In each room anyone can talk, show their camera, share their screen and chat. Three screens: your name (remembered), the lobby (who is in the call, microphone and camera switches), the call.
- The app shows only the call: no channels, text chat, search, pins, settings or recording. The server code for them is gone too, and the database migration (v2) deletes the old messages and their files.
- It replaced the Arabic class app at the class's own address (the teacher shares his Android tablet's screen in lessons).
- People see it as **Majlis** (Android package `com.samycc777.majlis`); code and docs still say Hangout.
- The README describes every feature from the friends' point of view; read it before changing behaviour.

## Rules

- What customers see (name, wording, look, website) must stay neutral: nothing tied to Islam or Arabic learning. Arabic stays one language among others.
- Keep every flow simple (friends and the class's teacher are not tech-savvy): people join by opening an invite link and typing their name, nothing else; no unneeded settings, plain wording. Prefer short codes, fewest steps, defaults over settings. Security fixes must not add work for them; if a safeguard makes joining harder, keep it simple or ask first.
- Everyone is equal: no teacher/admin powers (muting or removing others, deleting others' messages); don't add roles back.
- One app, one address: Majlis replaces the class app on the class's existing Railway service and address; never propose a second service or address, even for trying. The teacher shares his screen from an Android tablet; students use Android, iPhone (website until TestFlight) or web, so screen sharing must work for everyone.
- Only the user's own markaz (study centre) uses it free forever besides the home room; no public "free for Islamic teachers" plan; don't pitch it for religious or Arabic classes.
- Never touch `chat.db*` or `uploads/` (local development data).

## Layout

- `server/` — Node.js (Express 5, Socket.IO, better-sqlite3), TypeScript compiled to `dist/`. `index.ts`, `config.ts` (env vars), `database.ts`, `auth.ts` (invite-key join, month-long session tokens that name a `roomId`), `rooms.ts` (home room `'home'` with key `INVITE_KEY`; customer rooms in the `rooms` table; `POST /api/rooms` needs `ROOM_CREATION_KEY` in production; each Socket.IO connection stays in `room:<roomId>`), `avatars.ts` (profile pictures, stored in the `avatars` table), `voice.ts` (calls, one LiveKit room `voice-<channelId>`; call chat is never stored), `socket.ts`, `routes.ts`, `push.ts` (notification wording in en and ar lives there), `account.ts` (sign-out and delete-my-data), `roomAdmin.ts` (new key or delete for a customer room), `channels.ts`, `livekit.ts`. Migrations and backups are in `database.ts`.
- `client/` — Vue 3 + Vite + TypeScript, `<script setup>`. `App.vue` shell: `CreateRoom.vue` at `/new`, else `Auth.vue` then `CallLobby.vue` then `CallView.vue` (lazy-loaded with LiveKit). Styles are scoped per component; `styles.css` holds only shared theme variables (`[data-theme]`, `--call-*` colours: use them instead of fixed colours except over video) and common classes. Scoped rules are more specific than global ones: put overrides next to the rule they override.
- `mobile/` — Capacitor wrapper loading the live site (web changes reach the apps without a rebuild; native changes need a new app version). Release Android: `cd mobile && npm run release:android` (builds and sends to Google Play internal testing; see mobile/README.md). Test APK: `HANGOUT_URL=... npm run build:android` (Gradle 9.3, Android Studio's Java).
- The app never animates (one global rule at the end of `styles.css`); don't add animations or transitions.
- `tests/security.test.mjs` — end-to-end server tests (real server, temporary database, fake LiveKit and push services).
- For the detailed file-by-file layout, read docs/notes/layout.md.
- Calls run on our own LiveKit server on Hetzner, not LiveKit Cloud: docs/notes/call-server.md.

## Commands

```sh
npm run check   # server typecheck, client vue-tsc + build, oxlint, tests (~8 s) — run before every commit
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
- Pushing main redeploys the live site on Railway immediately (`railway.json` watchPatterns): check nobody is in a call first. A server restart disconnects every call.
- Android updates go through Google Play internal testing, never APK files. A change touching `mobile/` needs `versionCode` and `versionName` raised in `mobile/android/app/build.gradle` and a release (`npm run release:android`); website-only changes need no app update. Always say which of the two it was. Release notes go in both Arabic (`<ar>`) and English (`<en-US>`) blocks in Play Console format, ready to paste.
- Railway stops reading `railway.json` on 2026-12-01. Don't apply `railway config migrate` as generated: it names the service `app-majlis` (the real one is `nurturing-dedication`), leaves out the `/data` volume (undeclared resources get deleted), and its format has no watchPatterns or restart policy.

## Mistakes to avoid

- Lessons are live on the production site: before publishing, check nobody is in a call. A restart cuts the teacher's voice and screen mid-lesson.
- After each change, tell the user plainly whether the Android app needs an update or only the website changed.
- Test call behaviour for background, minimised and rotated phones (sound stops, half-cut or landscape shared screens, black play button on return) and not only the desktop browser.
