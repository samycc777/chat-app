plugins {
  id("com.android.application")
  kotlin("android")
}

android {
  namespace = "org.classroom.teacher"
  compileSdk = 35

  defaultConfig {
    applicationId = "org.classroom.teacher"
    minSdk = 29
    targetSdk = 35
    versionCode = 1
    versionName = "1.0.0"
  }
}

dependencies {
  implementation("androidx.core:core-ktx:1.15.0")
  implementation("androidx.appcompat:appcompat:1.7.0")
  implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
  implementation("io.livekit:livekit-android:2.29.0")
  implementation("io.socket:socket.io-client:2.1.1")
}
