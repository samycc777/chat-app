# Classroom

Classroom is a single-room live class app built with Vue 3, Express, Socket.IO, and SQLite. Participants enter the temporary class code `0000`, choose a display name the first time they visit, and join the shared chat. The display name and browser identity are saved locally; the class code is requested for each new browser session.

The room supports messages, image/PDF attachments, and encrypted live lessons. A teacher can present from the Android companion while using JNotes: the original PDF remains on the teacher's device and students receive only the live screen and microphone stream. The first attendee to start a lesson owns its controls until the lesson ends; if they disconnect without ending it, the next attendee to start a lesson replaces it.

## Local development

Install the root and client dependencies, then run `npm run dev`. The server listens on port 3001 and Vite on port 5173. Local development uses a development-only JWT key and stores the SQLite database and uploads in the repository directory.

## Production deployment

Set `NODE_ENV=production`, `JWT_SECRET` to a random value of at least 32 characters, `DATA_DIR` to a mounted persistent directory, and `ALLOWED_ORIGINS` to a comma-separated list of exact browser origins. Configure a Railway Volume mounted at the `DATA_DIR` path. The server refuses to start without these settings.

Run `npm run build` to compile the server and create the client bundle, then `npm start` to serve both from the Node process. `/api/health` is the deployment health endpoint.

Uploads are limited to signature-checked images and PDFs, with a default maximum size of 100 MB (`MAX_UPLOAD_BYTES` can change the limit). Do not upload lesson PDFs from JNotes: they are not needed for Android screen sharing. SQLite and local uploads require one application instance. Presence and lesson sessions are held in memory and are lost on restart.

Live lessons require a LiveKit Cloud project. Set `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET` as deployment secrets. The server creates a random LiveKit room and E2EE key for each active lesson, keeps them only in memory, and returns them only to authenticated classroom members. Do not configure LiveKit recording or egress for this project. The LiveKit server receives normal connection metadata, but E2EE protects the screen and microphone media.

## Android teacher companion

The native project is in `android-teacher/`. Open that directory in Android Studio, set the website URL, class code, and teacher name, then build a private signed APK. Use a release signing key kept outside this repository (for example via `keystore.properties`, which must remain untracked). The app targets Android 14+ screen sharing, where the teacher should select JNotes in the Android system picker to avoid sharing notifications or other apps.

The companion uses Android MediaProjection and a foreground notification while sharing. Start the lesson in the app, approve the system prompt, then switch to JNotes. Stopping capture in Android or from the app ends the published screen track. Test the APK on the actual teacher device before a class; no signing key, LiveKit credentials, or Android device are included in this repository.

The `0000` class code and shared attendee presentation controls are temporary. Replace class admission and presenter authorization with managed secrets before using the app for a private class.
