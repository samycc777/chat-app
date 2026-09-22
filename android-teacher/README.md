# Classroom Teacher for Android

This private, Arabic-only companion lets a teacher share JNotes to the Classroom website without uploading the source PDF. The app sends only the Android screen and microphone through the active LiveKit lesson. Its release APK is limited to ARM64 devices, including the OPPO Reno7, so it does not bundle unused emulator and 32-bit native libraries.

## Build a private APK

1. Open `android-teacher` in a current Android Studio installation and let it sync the Gradle project.
2. Create a release keystore outside this repository. Do not commit it, its password, or a `keystore.properties` file.
3. Increase `versionCode` for every release, build a signed release APK from Android Studio, and install it directly on the teacher's Android 14+ device. Keep using the same signing key so Android can update the installed app without uninstalling it.
4. Set the deployed classroom URL, class code, and teacher name in the app. These values are saved on the device. Start the lesson, choose the single-app sharing option in Android's system capture picker, and then choose JNotes.

From this directory, the signed ARM64 release can also be built with `./gradlew assembleRelease`. The APK is written to `app/build/outputs/apk/release/app-release.apk`.

## Required server configuration

The website deployment must have `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET` configured. Use a LiveKit project with recording and egress disabled. The app cannot start a lesson until the website can issue an authenticated LiveKit token.

## Device checks before teaching

- Verify JNotes is selectable and renders normally in the shared stream.
- Confirm the persistent Android sharing notification is visible and stops capture correctly.
- Test microphone mute, rotation, Wi-Fi/mobile-network changes, screen lock, and an iPhone Safari viewer.
- Keep the source PDF in JNotes; never select it in the website upload controls.
