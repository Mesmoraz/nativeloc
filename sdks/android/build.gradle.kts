plugins {
    id("com.android.library") version "8.7.2"
    id("org.jetbrains.kotlin.android") version "2.0.21"
}

android {
    namespace = "dev.nativeloc"
    compileSdk = 35
    defaultConfig { minSdk = 24 } // android.icu.text.MessageFormat
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}
