import type { CapacitorConfig } from '@capacitor/cli';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

// The phone apps are thin shells around the website: they load the deployed
// site directly, so every web update reaches phones without a new app build.
// The address is the full invite link, read from HANGOUT_URL when running
// `npx cap sync`, so friends who install the app only have to type their name.
const DEV_URL = 'https://localhost:5173/?invite=0000';
const serverUrl = process.env.HANGOUT_URL?.trim() || DEV_URL;

if (!process.env.HANGOUT_URL?.trim()) {
  console.warn(
    `\n[hangout] HANGOUT_URL is not set, so the app will load ${DEV_URL}.\n` +
      '[hangout] That only works for development. For a real build run for example:\n' +
      '[hangout]   HANGOUT_URL="https://your-app.up.railway.app/?invite=KEY" npm run sync\n',
  );
}

let host: string;
try {
  host = new URL(serverUrl).hostname;
} catch {
  throw new Error(`HANGOUT_URL is not a valid address: ${serverUrl}`);
}

// The "can't reach the server" page needs to know where Retry should go.
// Capacitor reads this file before copying www/ into the apps, so writing the
// address here keeps the page in step with every sync.
writeFileSync(
  join(__dirname, 'www', 'server-url.js'),
  `window.HANGOUT_URL = ${JSON.stringify(serverUrl)};\n`,
);

const config: CapacitorConfig = {
  appId: 'com.samycc777.hangout',
  appName: 'Hangout',
  // Only shown when the server can't be reached (see www/index.html).
  webDir: 'www',
  backgroundColor: '#313338',
  server: {
    url: serverUrl,
    // Only the Hangout server opens inside the app; any other link opens in
    // the phone's normal browser.
    allowNavigation: [host],
    // Shown instead of a blank error page when the site fails to load.
    errorPath: 'index.html',
    // Plain http is only allowed for local development addresses.
    cleartext: serverUrl.startsWith('http://'),
  },
  ios: {
    contentInset: 'never',
    backgroundColor: '#313338',
  },
  android: {
    backgroundColor: '#313338',
  },
};

export default config;
