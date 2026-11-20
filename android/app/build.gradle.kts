import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
}

// Release signing comes from a properties file outside the repository: the
// gradle property keelSigning, else KEEL_ANDROID_SIGNING, else android/keystore.properties.
// A release task without it fails; there is no debug-key fallback.
val signingFile = file(providers.gradleProperty("keelSigning").orNull
    ?: providers.environmentVariable("KEEL_ANDROID_SIGNING").orNull
    ?: rootProject.file("keystore.properties").path)
val ks = Properties().apply { signingFile.takeIf { it.isFile }?.inputStream()?.use { load(it) } }
val hasReleaseKey = listOf("storeFile", "storePassword", "keyAlias", "keyPassword").all { !ks.getProperty(it).isNullOrBlank() }
val verifyReleaseSigning = tasks.register("verifyReleaseSigning") {
    doLast {
        check(hasReleaseKey) { "Release signing is required: point keelSigning or KEEL_ANDROID_SIGNING at a properties file (storeFile, storePassword, keyAlias, keyPassword). Use assembleDebug for local tests." }
        check(file(ks.getProperty("storeFile")).isFile) { "The configured release keystore is not there." }
    }
}
tasks.configureEach { if (name.matches(Regex("pre.*ReleaseBuild"))) dependsOn(verifyReleaseSigning) }

android {
    namespace = "dev.avifenesh.keel"
    compileSdk = 37
    defaultConfig {
        applicationId = "dev.avifenesh.keel"
        minSdk = 31
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
    signingConfigs {
        if (hasReleaseKey) create("rel") {
            storeFile = file(ks.getProperty("storeFile"))
            storePassword = ks.getProperty("storePassword")
            keyAlias = ks.getProperty("keyAlias")
            keyPassword = ks.getProperty("keyPassword")
        }
    }
    buildTypes {
        getByName("release") {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = if (hasReleaseKey) signingConfigs.getByName("rel") else null
        }
        // The release bytes (R8, shrunk resources) with the debug key and the dev
        // network config: checks the minified app against a dev daemon over HTTP.
        create("qa") {
            initWith(getByName("release"))
            signingConfig = signingConfigs.getByName("debug")
            applicationIdSuffix = ".qa"
            versionNameSuffix = "-qa"
            matchingFallbacks += "release"
        }
        getByName("debug") {
            // A debug build sits beside the release one on the same phone.
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures { compose = true }
    packaging { resources { excludes += "/META-INF/{AL2.0,LGPL2.1}" } }
    lint { checkReleaseBuilds = true; abortOnError = true; warningsAsErrors = false }
}

dependencies {
    implementation(platform("androidx.compose:compose-bom:2026.09.00"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.activity:activity-compose:1.13.0")
    implementation("androidx.fragment:fragment-ktx:1.9.1")
    implementation("androidx.core:core-ktx:1.19.1")
    implementation("androidx.biometric:biometric:1.1.0")
    implementation("androidx.work:work-runtime-ktx:2.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.11.0")
    implementation("com.squareup.okhttp3:okhttp:5.5.0")
    implementation("com.squareup.okhttp3:okhttp-sse:5.5.0")
    implementation("com.google.firebase:firebase-messaging:25.1.3")
    implementation("com.google.android.gms:play-services-code-scanner:16.1.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20231013")
    androidTestImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test:runner:1.7.0")
}
