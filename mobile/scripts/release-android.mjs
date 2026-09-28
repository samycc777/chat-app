// Builds the Android app and sends it to Google Play's internal testing track in one go:
//
//   npm run release:android                      (from mobile/)
//   npm run release:android -- "What changed"    (with release notes, in English)
//
// It asks Google Play for the highest version number already uploaded and uses the next one, so
// nobody has to raise versionCode by hand. The testers get the update from Google Play by themselves.
//
// It needs three things that stay out of git:
// - a Google service account key allowed to release in Play Console, at
//   ~/.config/google-play/service-account.json (or the path in GOOGLE_PLAY_KEY);
// - the release signing key, android/keystore.properties (see README.md);
// - the address the app opens, in HANGOUT_URL or in release.json as {"hangoutUrl": "..."}.
import { spawnSync } from 'node:child_process';
import { createSign } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE = 'com.samycc777.majlis';
const TRACK = 'internal';
const mobileDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const API = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE}`;
const UPLOAD_API = `https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/${PACKAGE}`;

function stop(message) {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

const keyPath = process.env.GOOGLE_PLAY_KEY || join(homedir(), '.config', 'google-play', 'service-account.json');
if (!existsSync(keyPath)) stop(`No Google Play key at ${keyPath}. See "Releasing automatically" in mobile/README.md.`);
const key = JSON.parse(readFileSync(keyPath, 'utf8'));
if (!existsSync(join(mobileDir, 'android', 'keystore.properties'))) stop('android/keystore.properties is missing, so the app cannot be signed for Google Play.');
const releaseConfig = existsSync(join(mobileDir, 'release.json')) ? JSON.parse(readFileSync(join(mobileDir, 'release.json'), 'utf8')) : {};
const hangoutUrl = process.env.HANGOUT_URL?.trim() || releaseConfig.hangoutUrl;
if (!hangoutUrl?.startsWith('https://')) stop('Set HANGOUT_URL (or hangoutUrl in release.json) to the live invite link.');
const notes = process.argv.slice(2).join(' ').trim();

// Google's sign-in for a service account: a short signed note swapped for an hour-long access token.
async function accessToken() {
  const now = Math.floor(Date.now() / 1000);
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
    iss: key.client_email, scope: 'https://www.googleapis.com/auth/androidpublisher',
    aud: key.token_uri, iat: now, exp: now + 3600,
  })}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(key.private_key, 'base64url');
  const response = await fetch(key.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }),
  });
  const body = await response.json();
  if (!response.ok) stop(`Google refused the key: ${body.error_description || body.error}`);
  return body.access_token;
}

const token = await accessToken();
async function play(method, url, body, headers = { 'Content-Type': 'application/json' }) {
  const response = await fetch(url, { method, headers: { Authorization: `Bearer ${token}`, ...headers }, body });
  const text = await response.text();
  if (!response.ok) {
    let reason = text;
    try { reason = JSON.parse(text).error.message; } catch { /* Not JSON. */ }
    if (response.status === 403) reason += '\n  The key needs release permission in Play Console (Users and permissions), and the Google Play Android Developer API must be enabled.';
    stop(`Google Play said: ${reason}`);
  }
  return text ? JSON.parse(text) : {};
}

// An "edit" is Google Play's draft: nothing changes for testers until it is committed.
const edit = await play('POST', `${API}/edits`, '{}');
const { tracks = [] } = await play('GET', `${API}/edits/${edit.id}/tracks`);
const uploaded = tracks.flatMap(track => (track.releases ?? []).flatMap(release => release.versionCodes ?? [])).map(Number);
const versionCode = Math.max(0, ...uploaded) + 1;
// Version 1.4 was number 5, and the name has followed the number since.
const versionName = `1.${versionCode - 1}`;
console.log(`\n▶ Building version ${versionName} (number ${versionCode}) for ${hangoutUrl.replace(/invite=[^&]+/, 'invite=…')}\n`);

const env = { ...process.env, HANGOUT_URL: hangoutUrl };
const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: mobileDir, env, stdio: 'inherit' });
  if (result.status !== 0) stop(`${command} ${args.join(' ')} failed.`);
};
run('npx', ['cap', 'sync', 'android']);
run('node', ['scripts/gradle.mjs', 'bundleRelease', `-PversionCode=${versionCode}`, `-PversionName=${versionName}`]);

const bundlePath = join(mobileDir, 'android', 'app', 'build', 'outputs', 'bundle', 'release', 'app-release.aab');
console.log(`\n▶ Uploading to Google Play…`);
const bundle = await play('POST', `${UPLOAD_API}/edits/${edit.id}/bundles?uploadType=media`, readFileSync(bundlePath), { 'Content-Type': 'application/octet-stream' });
await play('PUT', `${API}/edits/${edit.id}/tracks/${TRACK}`, JSON.stringify({
  track: TRACK,
  releases: [{
    name: `${versionName} (${bundle.versionCode})`,
    versionCodes: [String(bundle.versionCode)],
    status: 'completed',
    ...(notes ? { releaseNotes: [{ language: 'en-US', text: notes }] } : {}),
  }],
}));
await play('POST', `${API}/edits/${edit.id}:commit`);
console.log(`\n✔ Version ${versionName} is on Google Play's internal testing. Testers get it within a few minutes to a few hours.\n`);
