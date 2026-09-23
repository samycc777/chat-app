# Classroom Teacher for Android

This private, Arabic-only companion lets the teacher present a lesson from an Android phone or tablet: it shares JNotes (or another app) and the device's microphone with the class through the website's LiveKit lesson, while the lesson PDF stays on the device. The APK runs on Android 8.0 and newer on ARM devices, 64-bit and 32-bit, such as the OPPO Reno7 phone or a Galaxy Tab A (2016) tablet; it leaves out emulator libraries.

On Android 14 and newer the teacher can share a single app, so only JNotes is shown. Older Android versions always share the whole screen: close anything private before the lesson, since students see everything on the screen, including notifications.

## What the app does during a lesson

- Signs in with the **teacher code** (not the students' class code) and starts the lesson; a student's code is refused with an explanation.
- Shares the screen of the app chosen in Android's prompt, and the microphone, which can be muted from the app.
- Shows the participants, with raised hands first. Tap ✋ to lower a hand, tap a student's 🎤 to mute them, or use "Mute everyone".
- Shows the class chat, including recent history, and lets the teacher reply. A long press deletes a message for everyone.
- While the teacher is in JNotes, a raised hand or a new chat message appears as a silent pop-up notification, so no sound reaches the class through the microphone.
- Keeps running with the screen locked, survives rotation, and stops cleanly if the lesson is ended from the website or lost in a server restart.

## Build a private APK

1. Open `android-teacher` in a current Android Studio installation and let it sync the Gradle project.
2. Create a release keystore outside this repository. Do not commit it, its password, or a `keystore.properties` file.
3. Increase `versionCode` for every release, build a signed release APK from Android Studio, and install it directly on the teacher's Android 8.0+ device. Keep using the same signing key so Android can update the installed app without uninstalling it.
4. In the app, set the classroom URL, the teacher code, and the teacher name. These are saved on the device. Start the lesson and approve Android's screen-sharing prompt; on Android 14 and newer, choose the single-app option and then JNotes.

From this directory, the signed release can also be built with `./gradlew assembleRelease`. The APK is written to `app/build/outputs/apk/release/app-release.apk`.

## Required server configuration

The website deployment must have `TEACHER_CODE` set, and `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET` configured for a LiveKit project with recording and egress disabled. The app cannot start a lesson until the website can issue an authenticated LiveKit token.

## Device checks before teaching

- Start a lesson with the teacher code; confirm that a student's code is refused.
- Verify JNotes is selectable and renders normally in the shared stream, and that students hear the teacher.
- From a student's phone, raise a hand and send a chat message while the teacher is in JNotes: both should pop up silently. Lower the hand and mute the student from the app.
- Allow notifications when Android asks; without them the pop-ups cannot appear.
- Confirm the persistent Android sharing notification is visible and stops capture correctly.
- Test microphone mute, rotation, Wi-Fi/mobile-network changes, screen lock, and an iPhone Safari viewer.
- Keep the source PDF in JNotes; never select it in the website upload controls.
