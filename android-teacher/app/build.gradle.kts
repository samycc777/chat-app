import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import java.util.Properties

val signingProperties = Properties()
val signingPropertiesFile = rootProject.file("keystore.properties")
if (signingPropertiesFile.isFile) {
  signingPropertiesFile.inputStream().use(signingProperties::load)
}

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
    versionCode = 2
    versionName = "1.1.0"
    ndk {
      abiFilters += "arm64-v8a"
    }
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }

  signingConfigs {
    if (signingPropertiesFile.isFile) {
      create("release") {
        keyAlias = signingProperties.getProperty("keyAlias")
        keyPassword = signingProperties.getProperty("keyPassword")
        storeFile = rootProject.file(signingProperties.getProperty("storeFile"))
        storePassword = signingProperties.getProperty("storePassword")
      }
    }
  }

  lint {
    abortOnError = false
    checkReleaseBuilds = false
  }

  buildTypes {
    release {
      isMinifyEnabled = false
      signingConfig = signingConfigs.findByName("release")
        ?: error("A private release signing key is required. Add android-teacher/keystore.properties locally.")
    }
  }
}

kotlin {
  compilerOptions {
    jvmTarget.set(JvmTarget.JVM_17)
  }
}

dependencies {
  implementation("androidx.core:core-ktx:1.15.0")
  implementation("androidx.appcompat:appcompat:1.7.0")
  implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
  implementation("io.livekit:livekit-android:2.29.0")
  implementation("io.socket:socket.io-client:2.1.1")
}
