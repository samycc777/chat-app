# Hangout phone apps (iPhone and Android)

This folder holds the iPhone and Android apps for Hangout.

## What these apps are

The apps are thin "wrappers" made with [Capacitor](https://capacitorjs.com). Each one is a full-screen
web view (a browser window with no address bar) that opens the Hangout website. There is no separate
phone version of Hangout to maintain: the website, the iPhone app and the Android app are the same app.

Why it works this way: when the website is updated and deployed, everyone with the app gets the change
the next time they open it. You only need to build and send out a new app when something in this
`mobile/` folder changes (the app icon, the permissions, the server address).

The app opens the full invite link (`https://<server>/?invite=<KEY>`), so friends who install it only
type their name. Links to other websites open in the phone's normal browser. If the server can't be
reached, the app shows "Can't reach the server. Check your internet connection." with a Retry button.

What's where:

- `capacitor.config.ts`: app name (`Majlis`), app id (`com.samycc777.majlis`) and the server address.
- `www/index.html`: the "can't reach the server" page. It is the only web page inside the app itself.
- `ios/`: the Xcode project for iPhone. `android/`: the Android Studio project.
- `scripts/icons.mjs`: makes the app icons and launch screens from `client/public/icon.svg`.
- `scripts/gradle.mjs`: runs Android builds with the Java that comes with Android Studio.

## Setup (once)

You need Node.js, Xcode (for iPhone) and Android Studio (for Android).

```sh
cd mobile
npm ci
```

## Point the apps at the server: HANGOUT_URL and sync

The server address is baked into the apps when you run `sync`. Set `HANGOUT_URL` to the **full invite
link** of the deployed site:

```sh
cd mobile
HANGOUT_URL="https://your-app.up.railway.app/?invite=YOUR_KEY" npm run sync
```

`sync` copies the settings into both the `ios/` and `android/` projects. Run it again, then rebuild, if
the address or the invite key changes.

If `HANGOUT_URL` is not set, the apps use `https://localhost:5173/?invite=0000` (the development server)
and print a warning. That address only means "this same computer", so it is only useful in the iPhone
Simulator, and even there the development server's self-signed certificate may be refused. To test on a
real phone, point `HANGOUT_URL` at the deployed site.

The invite key is a secret, so the files that contain it (`ios/App/App/capacitor.config.json`,
`android/app/src/main/assets/capacitor.config.json`, `www/server-url.js`) are kept out of git. Anyone
who has the app can still get in, so only give the app to friends.

Other commands:

| Command | What it does |
| --- | --- |
| `npm run open:ios` | Opens the iPhone project in Xcode |
| `npm run open:android` | Opens the Android project in Android Studio |
| `npm run build:android` | Syncs and builds a test APK (Android app file) |
| `npm run build:android:release` | Syncs and builds a signed release APK (needs a keystore, see below) |
| `npm run build:ios:simulator` | Syncs and builds the iPhone app for the Simulator, without signing |
| `npm run assets` | Remakes the app icons and launch screens from `client/public/icon.svg` |

The build commands already run `sync`, so put `HANGOUT_URL=...` in front of them too, for example
`HANGOUT_URL="https://.../?invite=KEY" npm run build:android`.

## Android: build the APK and share it with a friend

### Quick test build

```sh
cd mobile
HANGOUT_URL="https://your-app.up.railway.app/?invite=YOUR_KEY" npm run build:android
```

The app file is `mobile/android/app/build/outputs/apk/debug/app-debug.apk`. A test build is signed with a
throwaway key that only exists on this computer, which is fine for trying it out.

### Release build (recommended for friends)

A release build is signed with **your own** key. Android only installs an update over an existing app
if it is signed with the same key, so keep this key forever and back it up (for example in a password
manager). If you lose it, friends have to uninstall the app before installing a new version.

1. Create the key once (it asks for a password; remember it). Run this in `mobile/android/`:

   ```sh
   "/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/keytool" -genkeypair -v \
     -keystore hangout-release.jks -alias hangout -keyalg RSA -keysize 2048 -validity 10000
   ```

2. Create `mobile/android/keystore.properties` with:

   ```properties
   storeFile=hangout-release.jks
   storePassword=the password you chose
   keyAlias=hangout
   keyPassword=the password you chose
   ```

   Both files are ignored by git, so they never end up on GitHub.

3. Build:

   ```sh
   cd mobile
   HANGOUT_URL="https://your-app.up.railway.app/?invite=YOUR_KEY" npm run build:android:release
   ```

   The app file is `mobile/android/app/build/outputs/apk/release/app-release.apk`.

For each new version, raise `versionCode` (and `versionName`) in `android/app/build.gradle`, otherwise
phones refuse to install it over the old one.

### Sending it

Send the `.apk` file to your friend (for example over WhatsApp, Telegram, email or Google Drive). When
they open it, Android warns that it comes from an "unknown source" and asks them to allow installs from
that app (the messaging app or file manager they opened it with). They tap **Settings**, turn on
**Allow from this source**, go back and tap **Install**. The first time they join a voice channel,
Android asks for the microphone (and the camera if they turn it on).

## Android: Google Play internal testing

This is how the class gets the Android app: through Google Play, but only for the people you list, and
without the "unknown source" warning of an APK. Random people cannot find or install it.

1. Build the file Google Play wants (an `.aab`, signed with the release key from the section above):

   ```sh
   cd mobile
   HANGOUT_URL="https://<the site>/?invite=<INVITE_KEY>" npm run build:android:play
   ```

   The file is `mobile/android/app/build/outputs/bundle/release/app-release.aab`.
2. In [Play Console](https://play.google.com/console): **Create app** → name "Hangout", app, free. Then
   **Test and release → Testing → Internal testing → Testers**: create an email list with the Gmail
   addresses of the teacher and the students, and save.
3. **Internal testing → Create new release**: let Google manage the app signing key, upload the `.aab`,
   and roll it out.
4. Copy the **invite link** under Testers and send it to the class. Each person opens it on their Android
   phone or tablet with the Gmail address you listed, taps **Accept**, then **Download it on Google Play**.

Google also asks for a privacy policy address: use `https://<the site>/privacy.html`.

For each new version, raise `versionCode` (and `versionName`) in `android/app/build.gradle`, build again
and create a new release. Only changes in this `mobile/` folder need a new version; website changes reach
the app by themselves.

## iPhone: send the app to friends with TestFlight

Apple doesn't allow sending an app file directly. The simplest way to share it is TestFlight, Apple's
app for testing apps before they're in the App Store. It needs a paid Apple developer account.

1. Join the **Apple Developer Program** at <https://developer.apple.com/programs/> (99 USD per year).
   Approval can take a day or two.
2. Open Xcode and sign in: **Xcode → Settings → Accounts → +**, choose **Apple ID** and sign in with
   the same account.
3. Point the app at the server and open the project:

   ```sh
   cd mobile
   HANGOUT_URL="https://your-app.up.railway.app/?invite=YOUR_KEY" npm run sync
   npm run open:ios
   ```

4. In Xcode, click **App** at the top of the file list on the left, pick the **App** target, open the
   **Signing & Capabilities** tab and choose your **Team**. Leave "Automatically manage signing" on.
   The bundle identifier must stay `com.samycc777.majlis`.
5. Go to <https://appstoreconnect.apple.com> → **Apps** → **+** → **New App**. Platform iOS, name
   "Hangout" (if the name is taken, add something, e.g. "Hangout Friends"; the name on the phone stays
   "Majlis"), any language, bundle ID `com.samycc777.majlis` (if it isn't in the list, Xcode creates
   it after step 4; refresh the page), SKU anything, e.g. `hangout`.
6. In Xcode, choose **Any iOS Device (arm64)** as the destination at the top of the window, then
   **Product → Archive**. This takes a few minutes.
7. When the Organizer window opens, select the new archive and click **Distribute App** → **TestFlight
   & App Store** (or **TestFlight Internal Only**) → follow the steps. After upload, Apple processes the
   build for 10 to 30 minutes; you get an email when it is ready.
8. Add your friend as a tester in App Store Connect → your app → **TestFlight**:
   - **Internal testers** get the app immediately, but first have to be added to your team (App Store
     Connect → **Users and Access**), which gives them access to your App Store Connect account.
   - **External testers** are simpler for friends: create an external group, add their email (or share
     a public link). The first build for external testers needs a short **Beta App Review** by Apple,
     usually within a day.
9. Your friend installs the **TestFlight** app from the App Store, opens the invitation email or link,
   and taps **Install**. TestFlight builds expire after 90 days; upload a new build before then.

For each new upload, raise the **Build** number (App target → General → Identity), or App Store Connect
rejects the upload.

## What works in the apps

On phones, people can chat, talk and listen in voice channels, turn on their camera and **watch** other
people's shared screens.

**Sharing your own screen works in the Android app.** A web page inside an app can't capture the screen,
so the Android app does it with its own code: `ScreenSharePlugin.kt` shows Android's "Share your screen
with Hangout?" prompt, then joins the call a second time with a screen-only pass from the server and sends
the screen with LiveKit's Android library. `ScreenShareService.kt` keeps a notification with a **Stop
sharing** button while it lasts; Android needs it to keep the microphone on while another app is in front.
Everyone sees it as that person's screen, not as an extra person.

**The iPhone app can't share its screen yet.** It needs a "broadcast upload extension", which needs the
paid Apple developer account first. Phone browsers can't share either; computers can.

The Android project builds with Gradle 9.3, because the Java inside Android Studio is now version 25, which
older Gradle versions can't run on. An app installed before screen sharing existed still shows "this device
can't share its screen" until it is updated.

Calls keep going when the iPhone screen locks (the app is allowed to play audio in the background).

**On Android, calls keep going while another app is in front.** Android cuts an app's microphone and lets
its sound stop once it is in the background, unless the app shows a notification that it is in a call.
So while someone is in a voice channel, `CallPlugin.kt` runs `CallService.kt`, which shows "You are in a
voice call" with a **Leave call** button. The call screen switches it on when the call starts and off when
it ends (`client/src/nativeCall.ts`). An app installed before this existed still goes quiet in the
background until it is updated. Some phones also pause apps to save battery; if a call still stops, turn
off battery saving for Majlis in the phone's settings.

## Changing things

- **The website**: just deploy it. Apps pick it up next time they open.
- **Server address or invite key**: run `sync` with the new `HANGOUT_URL`, rebuild and send the new app.
- **App icon**: change `client/public/icon.svg`, run `npm run assets`, commit the new images, rebuild.
- **Permissions**: iPhone ones are in `ios/App/App/Info.plist`, Android ones in
  `android/app/src/main/AndroidManifest.xml`.
