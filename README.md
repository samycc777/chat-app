# ChatApp

ChatApp is a React/Vite chat client with an Express, Socket.IO, and SQLite server. It supports direct and group chats, image/PDF attachments, WebRTC calls, and shared PDF whiteboards.

## Local development

Install the root and client dependencies, then run `npm run dev`. The server listens on port 3001 and Vite on port 5173. Local development uses a development-only JWT key and stores the SQLite database and uploads in the repository directory.

For local development, copy `.env.example` to `.env`, then export its values before starting the app (for example, `set -a && source .env && set +a && npm run dev` in zsh). Do not use the local JWT key outside development.

## Production deployment

Set `NODE_ENV=production`, `JWT_SECRET` to a random value of at least 32 characters, `DATA_DIR` to a mounted persistent directory, and `ALLOWED_ORIGINS` to a comma-separated list of exact browser origins. Configure a Railway Volume mounted at the `DATA_DIR` path. The server refuses to start without these settings.

Run `npm run build` to compile the server and create the client bundle, then `npm start` to serve both from the Node process. `/api/health` is the deployment health endpoint.

Uploads are limited to signature-checked images and PDFs, with a default maximum size of 10 MB (`MAX_UPLOAD_BYTES` can change the limit). They are served only to authenticated members of the conversation. Existing local chat uploads with safe filenames and recognized image/PDF contents are adopted during database startup. Old whiteboard PDFs that were referenced only by in-memory sessions must be uploaded again.

SQLite and local uploads require one application instance. Presence and whiteboard sessions are held in memory and are lost on restart. WebRTC currently uses public STUN servers only, so restrictive networks may need a TURN service before calls can connect.

## Environment variables

See `.env.example` for the required production variables and development defaults.
