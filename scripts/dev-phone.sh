#!/bin/sh
# Runs the whole app on this computer for trying it on an Android phone connected with (wireless)
# debugging, and in this computer's browser at http://localhost:5173/?invite=0000.
#
# The phone reaches the website and LiveKit's signalling as "localhost" through adb reverse, because
# phones only allow the camera and microphone on https or localhost. Call audio and video go
# straight to this computer over the Wi-Fi, so the phone must be on the same network.
set -e
ADB="${ANDROID_HOME:-$HOME/Library/Android/sdk}/platform-tools/adb"
for port in 5173 7880 7881; do "$ADB" reverse "tcp:$port" "tcp:$port"; done
export LIVEKIT_URL=ws://localhost:7880 LIVEKIT_API_KEY=devkey LIVEKIT_API_SECRET=secret DEV_HTTP=1
exec npx concurrently -n livekit,server,client -c gray,blue,green \
  "livekit-server --dev --bind 0.0.0.0" "npm run server" "npm run client"
