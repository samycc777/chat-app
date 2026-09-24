# Classroom

Online room for one Arabic class: chat, shared worksheets, and live lessons. The README describes every feature from the class's point of view; read it before changing behaviour.

The teacher and students are not tech-savvy. Keep every flow simple for them: short numeric codes, as few steps and prompts as possible, sensible defaults instead of settings, plain-language wording.

## Layout

- `server/` — one Node.js process (Express 5, Socket.IO, better-sqlite3), TypeScript compiled to `dist/`.
  - `index.ts` wires everything up; `config.ts` reads env vars; `database.ts` holds the schema and migrations.
  - `auth.ts` is joining with a code (`/api/auth`, rate-limited) and session tokens.
  - `routes.ts` is the REST API (`/api/...`: LiveKit tokens, muting, message history, uploads, attachments).
  - `socket.ts` handles realtime events (messages, typing, lesson start/end as `wb_start`/`wb_end`, hands, removing members).
  - `lesson.ts` keeps the running lesson in memory; `livekit.ts` is the LiveKit server client.
- `client/` — Vue 3 + Vite + TypeScript web app, `<script setup>` components.
  - `App.vue` is the shell; `components/ChatView.vue` and `components/LessonView.vue` are the two big screens. `LessonView` (and LiveKit) is lazy-loaded.
  - `api.ts` (REST), `socket.ts` (Socket.IO), `types.ts` (shared types), `warmVoice.ts` (microphone shaping).
  - `i18n.ts` holds every user-facing string, in English and Arabic.
  - All styles are in `styles.css`; components have no `<style>` blocks.
- `android-teacher/` — Kotlin teacher app, Arabic only, plus C voice processing in `app/src/main/cpp/`. It cannot be built from here; it needs Android Studio with the NDK.
- `tests/security.test.mjs` — end-to-end server tests: a real server on a temporary database, with a fake LiveKit.

**Ignore `android-teacher/app/src/main/cpp/rnnoise/`.** It is vendored third-party code (one file is 141k lines) and is never edited. Exclude it from searches.

Never touch `chat.db*` or `uploads/`: they are the local development data.

## Commands

```sh
npm run check   # server typecheck, client vue-tsc, oxlint, and tests (~8 s) — run before every commit
npm test        # tests only
npm run dev     # server on :3001, client on https://localhost:5173 (class code 0000, teacher code "teacher")
```

## Conventions

- Every new user-facing string goes in `client/src/i18n.ts` in both `en` and `ar`. Android strings are in Arabic only.
- When behaviour visible to the class changes, update the README, and the message for the class in it when students need to know.
- New server behaviour gets a test in `tests/security.test.mjs`.
- Comments explain why, not what, in full sentences.
- Commit messages: a short plain-English title describing the change from the class's point of view ("Let students turn the lesson volume down"), then prose paragraphs explaining why and how.
- Don't redeploy during a lesson: a server restart ends the running lesson.
