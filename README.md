# Classroom

Classroom is the online room for one class: a shared chat, shared worksheets (images and PDFs), and live lessons in which the teacher shares their screen and voice. It is built for an Arabic class: the interface is available in Arabic and English, Arabic is set in Noto Naskh Arabic with room for the vowel marks, and students without an Arabic keyboard can type vocalised Arabic on an on-screen keyboard.

It runs as one Node.js process (Express, Socket.IO, SQLite) serving a Vue 3 web app, with live audio and video carried by [LiveKit](https://livekit.io). The teacher can present from a laptop browser or from the Android teacher app in `android-teacher/`, which shares a note-taking app such as JNotes while the lesson PDF stays on the teacher's phone.

## What students and the teacher can do

- **Join with a code.** Students open the class link, enter the class code and their name once, and are in. The teacher enters the teacher code in the same field and gets the teacher's controls. The name and browser identity are remembered; the code is asked for again in each new browser session.
- **Chat.** Messages, replies, edits, links, images, and PDFs. The teacher's messages carry a Teacher badge. Everyone can delete their own messages; the teacher can delete any message. Earlier history loads a page at a time.
- **Read and write Arabic.** Arabic messages are shown larger with taller lines, each student can choose from four text sizes, and the ع button opens an on-screen Arabic keyboard with every haraka.
- **Live lessons.** Only the teacher starts or ends a lesson. Students join listening, with their microphone off, and unmute to speak. They can raise a hand, which the teacher sees immediately even in the Android app, and send reactions. The teacher can mute one student or everyone, and lower hands.
- **People.** The People button shows who is online. The teacher can remove a disruptive student, who is signed out at once and cannot rejoin until the teacher allows them back.
- **Phones.** The site works on phones and can be added to the home screen. Students' screens stay awake during a lesson, and the app reconnects by itself after a network drop, fetching any messages it missed.

## Teacher quick start

1. Open the class link and enter the **teacher code** with your name. You get a Teacher badge and a **Start lesson** button.
2. To teach from your Android phone or tablet, open the Classroom Teacher app, enter the teacher code and your name, and tap **Start lesson**. On Android 14 and newer, choose "A single app" in the screen-sharing prompt, then JNotes; older devices share the whole screen, so close anything private first. Then teach as usual. Raised hands and new questions pop up over JNotes without a sound, so nothing reaches the class through your microphone.
3. To teach from a laptop, start the lesson on the website and use **Share screen** in the lesson controls.
4. End the lesson with **End lesson** (in the app) or **End → End lesson for everyone** (on the website). If your phone loses its connection, the lesson keeps going for a while; if you do not come back, it ends by itself.

Please do not redeploy the server during a lesson: a restart ends the running lesson, and you would need to start it again.

## A message you can send to your class

> **العربية:** السلام عليكم! هذا رابط فصلنا: `<رابط الموقع>`
> افتحوا الرابط، وأدخلوا رمز الفصل `<الرمز>` واسمكم. لوحة المفاتيح العربية موجودة في زر «ع» بجانب خانة الكتابة، ويمكنكم تكبير النص من زر «Aa». عندما يبدأ الدرس يظهر زر «انضم إلى الدرس». ميكروفونكم مغلق في البداية؛ اضغطوا «إلغاء الكتم» عندما تريدون التحدث، أو ارفعوا أيديكم من «المزيد».
>
> **English:** Here is our class link: `<link>`. Open it and enter the class code `<code>` and your name. The ع button next to the message box opens an Arabic keyboard, and the Aa button makes the text larger. When the lesson starts, a Join lesson button appears. Your microphone starts muted: tap Unmute to speak, or raise your hand from More.

## Setting up the server

### Configuration

| Variable | Required | Meaning |
| --- | --- | --- |
| `NODE_ENV` | production | Set to `production` on the deployed server. |
| `JWT_SECRET` | production | Random secret of at least 32 characters that signs sessions. |
| `DATA_DIR` | production | Persistent directory for the SQLite database and uploads (a Railway Volume). |
| `ALLOWED_ORIGINS` | production | Comma-separated exact origins allowed to use the site, such as `https://your-app.up.railway.app`. |
| `CLASS_CODE` | production | The students' code, at least 4 characters. |
| `TEACHER_CODE` | production | The teacher's private code, at least 4 characters, different from the class code. Anyone who enters it gets the teacher's controls. |
| `CLASS_NAME` | no | Name shown on the join screen, in the header, in the browser tab, and under the home-screen icon, for example `العربية — المستوى الأول`. |
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | for lessons | Credentials of a LiveKit Cloud project. Without them the chat works but lessons cannot start. |
| `MAX_UPLOAD_BYTES` | no | Largest upload in bytes; 100 MB by default. |
| `LESSON_ABANDON_GRACE_MS` | no | How long a presenter may be gone before their lesson ends by itself; 90 seconds by default. |

In production the server refuses to start if a required variable is missing or too short. Codes ignore letter case and spaces, and Arabic-Indic digits count as the same digits, so `١٢٣٤٥٦` works for `123456`. After ten wrong codes in a minute, a network address must wait a minute before trying again.

**Changing a code** signs out everyone who joined with the old one. To remove one person, use the People menu instead; to let the whole class back in, give them the new code.

### Deploying on Railway

1. Create a Railway service from this repository. `railway.json` already sets the build (`npm run build`), the start command, and the `/api/health` health check.
2. Add a Volume and set `DATA_DIR` to its mount path.
3. Set the variables above as service variables, including a public domain in `ALLOWED_ORIGINS`.
4. For lessons, create a LiveKit Cloud project and copy its URL, API key, and API secret into the `LIVEKIT_*` variables. Leave recording and egress off.

The app keeps its database and uploads on the one volume, so it must run as a single instance. Who is online and the running lesson are held in memory and reset when the server restarts. Back up the volume if the chat history matters to you.

### Privacy

Uploaded files are only served to signed-in members of the class, and their contents are checked to be real images or PDFs. Lesson audio and video pass through LiveKit Cloud, encrypted in transit; LiveKit's end-to-end encryption is currently turned off. Nothing is recorded. Deleting a message removes its text and file from the server.

## Development

```sh
npm install
npm --prefix client install
npm run dev        # server on port 3001, web app on https://localhost:5173
npm test           # server tests
```

Development uses built-in defaults: class code `0000`, teacher code `teacher`, and a development-only signing key, with the database and uploads stored in the repository directory. The tests start a real server on a temporary database and stand in for LiveKit with a small local fake, so they need no LiveKit account.

`npm run build` compiles the server and builds the web app; `npm start` then serves both from one process.

## Android teacher app

The Android project is in `android-teacher/`; see [its README](android-teacher/README.md) for building a signed APK and for the checks to run on the teacher's phone before a class.
