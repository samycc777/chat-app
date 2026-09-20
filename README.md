# Classroom

Classroom is a single-room live class app built with Vue 3, Express, Socket.IO, and SQLite. Participants enter the temporary class code `0000`, choose a display name the first time they visit, and join the shared chat. The display name and browser identity are saved locally; the class code is requested for each new browser session.

The room supports messages, image/PDF attachments, group voice during presentations, shared screen viewing, and a PDF whiteboard with synchronized annotation. For now, every attendee with the class code can start a presentation. The first attendee to start owns its controls until the presentation ends.

## Local development

Install the root and client dependencies, then run `npm run dev`. The server listens on port 3001 and Vite on port 5173. Local development uses a development-only JWT key and stores the SQLite database and uploads in the repository directory.

## Production deployment

Set `NODE_ENV=production`, `JWT_SECRET` to a random value of at least 32 characters, `DATA_DIR` to a mounted persistent directory, and `ALLOWED_ORIGINS` to a comma-separated list of exact browser origins. Configure a Railway Volume mounted at the `DATA_DIR` path. The server refuses to start without these settings.

Run `npm run build` to compile the server and create the client bundle, then `npm start` to serve both from the Node process. `/api/health` is the deployment health endpoint.

Uploads are limited to signature-checked images and PDFs, with a default maximum size of 10 MB (`MAX_UPLOAD_BYTES` can change the limit). SQLite and local uploads require one application instance. Presence and whiteboard sessions are held in memory and are lost on restart. WebRTC uses public STUN servers by default. For restrictive networks, configure an external TURN service with `TURN_URLS`, `TURN_USERNAME`, and `TURN_CREDENTIAL`.

The `0000` class code and shared attendee presentation controls are temporary. Replace class admission and presenter authorization with managed secrets before using the app for a private class.
