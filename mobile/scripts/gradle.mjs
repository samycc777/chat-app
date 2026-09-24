// Runs an Android Gradle task, e.g. `node scripts/gradle.mjs assembleDebug`.
// Gradle needs Java 21 or newer. We use the Java that comes with Android
// Studio, because that is what Android Studio itself builds with and it is
// always recent enough; an older system Java (JAVA_HOME) would fail with
// "invalid source release: 21". Without Android Studio, JAVA_HOME is used.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const androidDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'android');
const env = { ...process.env };
const studioJava = '/Applications/Android Studio.app/Contents/jbr/Contents/Home';
if (existsSync(studioJava)) env.JAVA_HOME = studioJava;

const gradlew = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
const result = spawnSync(gradlew, process.argv.slice(2), {
  cwd: androidDir,
  env,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
process.exit(result.status ?? 1);
