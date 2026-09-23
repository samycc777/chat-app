# Classroom

Classroom is a single-room live class app built with Vue 3, Express, Socket.IO, and SQLite. Students enter the class code (`CLASS_CODE`), choose a display name the first time they visit, and join the shared chat. The teacher enters the teacher code (`TEACHER_CODE`) in the same field, on the website or in the Android companion. The display name and browser identity are saved locally; the code is requested for each new browser session.

The room supports messages, image/PDF attachments, and live lessons. Only the teacher can start or end a lesson, and the teacher's messages carry a Teacher badge. The teacher can delete any message; students can delete their own. A teacher can present from the Android companion while using JNotes: the original PDF remains on the teacher's device and students receive only the live screen and microphone stream. Starting a lesson from a second teacher device takes the lesson over.

## Local development

Install the root and client dependencies, then run `npm run dev`. The server listens on port 3001 and Vite on port 5173. Local development uses a development-only JWT key and stores the SQLite database and uploads in the repository directory.

## Production deployment

Set `NODE_ENV=production`, `JWT_SECRET` to a random value of at least 32 characters, `DATA_DIR` to a mounted persistent directory, `ALLOWED_ORIGINS` to a comma-separated list of exact browser origins, `CLASS_CODE` to the students' code (at least 6 characters), and `TEACHER_CODE` to a different, private code for the teacher (at least 8 characters). Configure a Railway Volume mounted at the `DATA_DIR` path. The server refuses to start without these settings. `CLASS_NAME` optionally sets the name shown on the join screen.

Codes ignore letter case and spaces, and Arabic-Indic digits count as the same digits, so `١٢٣٤٥٦` works for `123456`. Changing a code signs out everyone who joined with the old one, which is how to remove someone who should no longer have access. After ten wrong codes in a minute, an address must wait before trying again.

Run `npm run build` to compile the server and create the client bundle, then `npm start` to serve both from the Node process. `/api/health` is the deployment health endpoint.

Uploads are limited to signature-checked images and PDFs, with a default maximum size of 100 MB (`MAX_UPLOAD_BYTES` can change the limit). Do not upload lesson PDFs from JNotes: they are not needed for Android screen sharing. SQLite and local uploads require one application instance. Presence and lesson sessions are held in memory and are lost on restart.

Live lessons require a LiveKit Cloud project. Set `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET` as deployment secrets. The server creates a random LiveKit room and E2EE key for each active lesson, keeps them only in memory, and returns them only to authenticated classroom members. Do not configure LiveKit recording or egress for this project. The LiveKit server receives normal connection metadata, but E2EE protects the screen and microphone media.

## Android teacher companion

The native project is in `android-teacher/`. Open that directory in Android Studio and build a private signed APK; in the app, set the website URL, the teacher code, and the teacher name. Use a release signing key kept outside this repository (for example via `keystore.properties`, which must remain untracked). The app targets Android 14+ screen sharing, where the teacher should select JNotes in the Android system picker to avoid sharing notifications or other apps.

The companion uses Android MediaProjection and a foreground notification while sharing. Start the lesson in the app, approve the system prompt, then switch to JNotes. Stopping capture in Android or from the app ends the published screen track. Test the APK on the actual teacher device before a class; no signing key, LiveKit credentials, or Android device are included in this repository.
