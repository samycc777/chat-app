import http2 from 'http2';
import { createHash } from 'crypto';
import { Response, Router } from 'express';
import jwt from 'jsonwebtoken';
import webpush from 'web-push';
import { v4 as uuid } from 'uuid';
import db from './database';
import { AuthRequest } from './auth';
import { Channel } from './channels';
import { mentionedUserIds, mentionsEveryone, plainText } from './messages';
import { rateLimit } from './rateLimit';

// Notifications reach friends who do not have the app in front of them: through Web Push in
// browsers (and iPhone home-screen web apps), through Firebase Cloud Messaging in the Android app,
// and through Apple's push service in the iPhone app. Web Push needs no setup; the phone routes
// switch themselves on when their keys are configured.

export type NotifyLevel = 'all' | 'mentions' | 'off';
export const NOTIFY_LEVELS: NotifyLevel[] = ['all', 'mentions', 'off'];
type Kind = 'web' | 'fcm' | 'apns';
type Lang = 'en' | 'ar';
interface Subscription { id: string; user_id: string; kind: Kind; endpoint: string; keys: string | null; notify_level: NotifyLevel }
interface Notice { title: string; body: string; channelId: string; ttlSeconds: number }

const testing = process.env.NODE_ENV === 'test';
const MAX_DEVICES_PER_PERSON = 20;
const CALL_NOTICE_GAP_MS = 5 * 60_000;
const MESSAGE_TTL_SECONDS = 12 * 3600;
// A call notice hours later would send people to a call that has long ended.
const CALL_TTL_SECONDS = 10 * 60;

// The phone shows the notification without opening the app, so its words are made here, in the
// language the device was using when it asked for notifications.
const WORDS: Record<Lang, Record<'message' | 'mention' | 'call' | 'photo' | 'voice' | 'video', string>> = {
  en: {
    message: '{name} in #{channel}',
    mention: '{name} mentioned you in #{channel}',
    call: '{name} started a call in 🔊 {channel}',
    photo: '📷 Photo',
    voice: '🎤 Voice message',
    video: '🎥 Video',
  },
  ar: {
    message: '{name} في #{channel}',
    mention: '{name} ذكرك في #{channel}',
    call: '{name} بدأ مكالمة في 🔊 {channel}',
    photo: '📷 صورة',
    voice: '🎤 رسالة صوتية',
    video: '🎥 فيديو',
  },
};
function words(lang: Lang, key: keyof typeof WORDS.en, vars: Record<string, string> = {}) {
  return WORDS[lang][key].replace(/\{(\w+)\}/g, (_match, name: string) => vars[name] ?? '');
}

// ---------------------------------------------------------------------------------------------
// Who has the app in front of them. The Android app keeps its connection open in the background
// during a call, so being connected is not enough: each page says whether it is being looked at.

const activeSockets = new Map<string, Set<string>>();

export function setAppActive(userId: string, socketId: string, active: boolean) {
  const sockets = activeSockets.get(userId) ?? new Set<string>();
  if (active) sockets.add(socketId);
  else sockets.delete(socketId);
  if (sockets.size) activeSockets.set(userId, sockets);
  else activeSockets.delete(userId);
}
export const forgetSocket = (userId: string, socketId: string) => setAppActive(userId, socketId, false);
const isAppActive = (userId: string) => activeSockets.has(userId);

// ---------------------------------------------------------------------------------------------
// Web Push. The server makes its own keys the first time and keeps them, so nothing needs setting up.

const settingQuery = db.prepare('SELECT value FROM app_settings WHERE key = ?');
const saveSetting = db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
let vapid: { publicKey: string; privateKey: string } | null = null;
function vapidKeys() {
  if (vapid) return vapid;
  const stored = settingQuery.get('vapid_keys') as { value: string } | undefined;
  if (stored) vapid = JSON.parse(stored.value);
  else {
    vapid = webpush.generateVAPIDKeys();
    saveSetting.run('vapid_keys', JSON.stringify(vapid));
  }
  return vapid!;
}

// Push services want a way to reach whoever runs the server: the site's own address does that
// without putting anyone's email in every notification.
function vapidSubject() {
  const origin = (process.env.ALLOWED_ORIGINS || '').split(',').map(entry => entry.trim()).find(entry => entry.startsWith('https://'));
  return origin || 'https://localhost';
}

// A signed VAPID header may be reused for up to a day, so one is made per push service twice a day.
const vapidHeaders = new Map<string, { authorization: string; expiresAt: number }>();
function vapidAuthorization(endpoint: string) {
  const audience = new URL(endpoint).origin;
  const cached = vapidHeaders.get(audience);
  if (cached && cached.expiresAt > Date.now()) return cached.authorization;
  const keys = vapidKeys();
  const expiresAt = Date.now() + 12 * 3600_000;
  const headers = webpush.getVapidHeaders(audience, vapidSubject(), keys.publicKey, keys.privateKey, 'aes128gcm', Math.floor(expiresAt / 1000));
  vapidHeaders.set(audience, { authorization: String(headers.Authorization), expiresAt: expiresAt - 60_000 });
  return String(headers.Authorization);
}

// Browsers only hand out addresses at these push services. Accepting no others keeps anyone from
// making the server send requests to addresses of their choosing.
const PUSH_SERVICE_HOSTS = ['googleapis.com', 'google.com', 'push.services.mozilla.com', 'push.apple.com', 'notify.windows.com'];
function validWebEndpoint(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (testing && url.protocol === 'http:' && url.hostname === '127.0.0.1') return true;
  return url.protocol === 'https:' && !url.port && PUSH_SERVICE_HOSTS.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`));
}
function base64urlBytes(value: unknown, length: number) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+={0,2}$/.test(value)) return null;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.length === length ? bytes : null;
}

// A channel's notifications share a topic, so a phone that was offline gets only the latest.
const topicOf = (channelId: string) => createHash('sha256').update(channelId).digest('base64url').slice(0, 32);

async function sendWeb(subscription: Subscription, notice: Notice) {
  const keys = JSON.parse(subscription.keys || '{}');
  const payload = JSON.stringify({
    title: notice.title, body: notice.body, tag: `channel-${notice.channelId}`,
    channelId: notice.channelId, url: `/?channel=${encodeURIComponent(notice.channelId)}`,
  });
  const details = webpush.generateRequestDetails({ endpoint: subscription.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } }, payload, {
    TTL: notice.ttlSeconds, urgency: 'high', topic: topicOf(notice.channelId),
    headers: { Authorization: vapidAuthorization(subscription.endpoint) },
  });
  // web-push can only send over https, so the request itself is made here, which also lets the
  // tests stand in for a push service on this computer.
  const headers = Object.fromEntries(Object.entries(details.headers).filter(([name]) => name.toLowerCase() !== 'content-length').map(([name, value]) => [name, String(value)]));
  const response = await fetch(details.endpoint, { method: 'POST', headers, body: details.body ?? undefined, signal: AbortSignal.timeout(15_000) });
  await response.arrayBuffer().catch(() => undefined);
  if (response.status === 404 || response.status === 410) return 'gone';
  if (!response.ok) throw new Error(`web push answered ${response.status}`);
  return 'sent';
}

// ---------------------------------------------------------------------------------------------
// Firebase Cloud Messaging, for the Android app. The service account's key signs a short pass,
// which Google exchanges for an hour-long access token.

interface ServiceAccount { project_id: string; client_email: string; private_key: string; token_uri?: string }
let parsedAccount: { raw: string; account: ServiceAccount | null } | null = null;
function fcmAccount(): ServiceAccount | null {
  const raw = process.env.FCM_SERVICE_ACCOUNT?.trim() || '';
  if (parsedAccount?.raw === raw) return parsedAccount.account;
  let account: ServiceAccount | null = null;
  if (raw) {
    // The JSON file may be pasted as it is, or encoded in base64 to keep it on one line.
    for (const text of [raw, Buffer.from(raw, 'base64').toString('utf8')]) {
      try {
        const candidate = JSON.parse(text);
        if (candidate?.project_id && candidate.client_email && candidate.private_key) { account = candidate; break; }
      } catch { /* Try the next form. */ }
    }
    if (!account) console.warn('FCM_SERVICE_ACCOUNT is set but is not a Firebase service account, so Android notifications are off.');
  }
  parsedAccount = { raw, account };
  fcmAccessToken = null;
  return account;
}
// Only the tests send Firebase messages somewhere else.
const fcmApiBase = () => (testing && process.env.FCM_API_BASE) || 'https://fcm.googleapis.com';

// Several notifications usually go out at once, so they share one request for the access token.
let fcmAccessToken: Promise<{ token: string; expiresAt: number }> | null = null;
async function fcmToken(account: ServiceAccount) {
  const cached = fcmAccessToken && await fcmAccessToken.catch(() => null);
  if (cached && cached.expiresAt > Date.now()) return cached.token;
  const pending = requestFcmToken(account);
  fcmAccessToken = pending;
  pending.catch(() => { if (fcmAccessToken === pending) fcmAccessToken = null; });
  return (await pending).token;
}
async function requestFcmToken(account: ServiceAccount) {
  const tokenUri = account.token_uri || 'https://oauth2.googleapis.com/token';
  const assertion = jwt.sign({ scope: 'https://www.googleapis.com/auth/firebase.messaging' }, account.private_key.replace(/\\n/g, '\n'), {
    algorithm: 'RS256', issuer: account.client_email, audience: tokenUri, expiresIn: 3600,
  });
  const response = await fetch(tokenUri, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await response.json().catch(() => ({})) as { access_token?: string; expires_in?: number };
  if (!response.ok || !data.access_token) throw new Error(`Google refused the Firebase key (${response.status})`);
  return { token: data.access_token, expiresAt: Date.now() + ((data.expires_in ?? 3600) - 120) * 1000 };
}

async function sendFcm(subscription: Subscription, notice: Notice) {
  const account = fcmAccount();
  if (!account) return 'skipped';
  const tag = `channel-${notice.channelId}`;
  const response = await fetch(`${fcmApiBase()}/v1/projects/${encodeURIComponent(account.project_id)}/messages:send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await fcmToken(account)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: {
      token: subscription.endpoint,
      notification: { title: notice.title, body: notice.body },
      // Tapping the notification hands these to the app, which opens the channel.
      data: { channelId: notice.channelId },
      android: {
        priority: 'high', ttl: `${notice.ttlSeconds}s`, collapse_key: tag,
        // The app makes this channel (PushSetupPlugin.kt), so people can tune it in Android's settings.
        notification: { tag, channel_id: 'messages' },
      },
    } }),
    signal: AbortSignal.timeout(15_000),
  });
  if (response.ok) { await response.arrayBuffer().catch(() => undefined); return 'sent'; }
  const error = await response.json().catch(() => ({})) as { error?: { status?: string; details?: { errorCode?: string }[] } };
  if (response.status === 401) fcmAccessToken = null;
  if (response.status === 404 || error.error?.status === 'NOT_FOUND' || error.error?.details?.some(detail => detail.errorCode === 'UNREGISTERED')) return 'gone';
  throw new Error(`Firebase answered ${response.status} ${error.error?.status ?? ''}`.trim());
}

// ---------------------------------------------------------------------------------------------
// Apple's push service, for the iPhone app, over one HTTP/2 connection signed with a .p8 key.

interface ApnsConfig { key: string; keyId: string; teamId: string; bundleId: string; host: string }
function apnsConfig(): ApnsConfig | null {
  const rawKey = process.env.APNS_KEY?.trim();
  const keyId = process.env.APNS_KEY_ID?.trim();
  const teamId = process.env.APNS_TEAM_ID?.trim();
  if (!rawKey || !keyId || !teamId) return null;
  // The .p8 file may be pasted as it is, with its line breaks written as \n, or in base64.
  const key = rawKey.includes('BEGIN PRIVATE KEY') ? rawKey.replace(/\\n/g, '\n') : Buffer.from(rawKey, 'base64').toString('utf8');
  if (!key.includes('BEGIN PRIVATE KEY')) return null;
  // TestFlight and App Store apps use Apple's main service; apps run from Xcode use its sandbox.
  const host = (testing && process.env.APNS_HOST) || (process.env.APNS_PRODUCTION === 'false' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com');
  return { key, keyId, teamId, bundleId: process.env.APNS_BUNDLE_ID?.trim() || 'com.samycc777.majlis', host };
}

// Apple wants the signed pass renewed at most every 20 minutes and at least every hour.
let apnsPass: { token: string; expiresAt: number; configKey: string } | null = null;
function apnsToken(config: ApnsConfig) {
  const configKey = `${config.keyId}:${config.teamId}`;
  if (apnsPass && apnsPass.configKey === configKey && apnsPass.expiresAt > Date.now()) return apnsPass.token;
  const token = jwt.sign({}, config.key, { algorithm: 'ES256', keyid: config.keyId, issuer: config.teamId });
  apnsPass = { token, expiresAt: Date.now() + 45 * 60_000, configKey };
  return token;
}

let apnsSession: http2.ClientHttp2Session | null = null;
function apnsConnection(host: string) {
  if (apnsSession && !apnsSession.closed && !apnsSession.destroyed) return apnsSession;
  const session = http2.connect(host);
  session.on('error', () => { if (apnsSession === session) apnsSession = null; });
  session.on('close', () => { if (apnsSession === session) apnsSession = null; });
  session.on('goaway', () => { if (apnsSession === session) apnsSession = null; });
  // An idle connection must not keep the server (or the tests) from stopping.
  session.unref();
  session.setTimeout(10 * 60_000, () => session.close());
  apnsSession = session;
  return session;
}

function sendApns(subscription: Subscription, notice: Notice): Promise<string> {
  const config = apnsConfig();
  if (!config) return Promise.resolve('skipped');
  const body = JSON.stringify({
    aps: { alert: { title: notice.title, body: notice.body }, sound: 'default', 'thread-id': notice.channelId },
    channelId: notice.channelId,
  });
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error: Error | null, result = '') => {
      if (settled) return;
      settled = true;
      if (error) reject(error); else resolve(result);
    };
    const request = apnsConnection(config.host).request({
      ':method': 'POST',
      ':path': `/3/device/${subscription.endpoint}`,
      authorization: `bearer ${apnsToken(config)}`,
      'apns-topic': config.bundleId,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'apns-expiration': String(Math.floor(Date.now() / 1000) + notice.ttlSeconds),
      'apns-collapse-id': `channel-${notice.channelId}`,
      'content-type': 'application/json',
    });
    let status = 0;
    let answer = '';
    request.setEncoding('utf8');
    request.setTimeout(15_000, () => request.close(http2.constants.NGHTTP2_CANCEL));
    request.on('response', headers => { status = Number(headers[':status']); });
    request.on('data', chunk => { answer += chunk; });
    request.on('error', error => finish(error));
    request.on('end', () => {
      if (status === 200) return finish(null, 'sent');
      let reason = '';
      try { reason = JSON.parse(answer).reason ?? ''; } catch { /* No reason given. */ }
      if (reason === 'ExpiredProviderToken') apnsPass = null;
      if (status === 410 || reason === 'BadDeviceToken' || reason === 'Unregistered') return finish(null, 'gone');
      finish(new Error(`Apple answered ${status} ${reason}`.trim()));
    });
    // A connection that broke or timed out ends the request without an answer.
    request.on('close', () => finish(new Error('Apple did not answer')));
    request.end(body);
  });
}

// ---------------------------------------------------------------------------------------------
// Sending. Nothing here may slow down or break sending a message, so every delivery runs on its
// own, after the message is out, and a failure is only noted in the log.

const deleteSubscription = db.prepare('DELETE FROM push_subscriptions WHERE id = ?');
const SENDERS: Record<Kind, (subscription: Subscription, notice: Notice) => Promise<string>> = { web: sendWeb, fcm: sendFcm, apns: sendApns };

function deliver(subscription: Subscription, notice: Notice) {
  SENDERS[subscription.kind](subscription, notice)
    .then(result => { if (result === 'gone') deleteSubscription.run(subscription.id); })
    .catch(error => console.warn(`Notification (${subscription.kind}) not delivered: ${error?.message ?? 'unknown error'}`));
}

const subscriptionsQuery = db.prepare(`
  SELECT s.id, s.user_id, s.kind, s.endpoint, s.keys, u.notify_level
  FROM push_subscriptions s JOIN users u ON u.id = s.user_id
  WHERE s.user_id != ?
`);
const langOf = (subscription: Subscription): Lang => {
  try { return JSON.parse(subscription.keys || '{}').lang === 'ar' ? 'ar' : 'en'; } catch { return 'en'; }
};

function shorten(text: string, length = 180) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
}

interface NewMessage {
  id: string; conversationId: string; senderId: string; content: string | null; type: string;
  fileName?: string | null; mimeType?: string | null; sender: { displayName: string };
}

function messageBody(message: NewMessage, lang: Lang) {
  if (message.type === 'image') return words(lang, 'photo');
  if (message.mimeType?.startsWith('audio/')) return words(lang, 'voice');
  if (message.mimeType?.startsWith('video/')) return words(lang, 'video');
  if (message.type === 'file') return shorten(message.fileName || '');
  return shorten(plainText(message.content));
}

/** Tells everyone who is away about a new message, or only those it mentions, as each person chose. */
export function notifyNewMessage(message: NewMessage, channel: Channel) {
  setImmediate(() => {
    try {
      const mentioned = new Set(mentionedUserIds(message.content));
      const everyone = mentionsEveryone(message.content);
      for (const subscription of subscriptionsQuery.all(message.senderId) as Subscription[]) {
        const mentionsThem = everyone || mentioned.has(subscription.user_id);
        if (subscription.notify_level === 'off' || isAppActive(subscription.user_id)) continue;
        if (subscription.notify_level === 'mentions' && !mentionsThem) continue;
        const lang = langOf(subscription);
        deliver(subscription, {
          title: words(lang, mentionsThem ? 'mention' : 'message', { name: message.sender.displayName, channel: channel.name }),
          body: messageBody(message, lang), channelId: channel.id, ttlSeconds: MESSAGE_TTL_SECONDS,
        });
      }
    } catch (error) {
      console.warn('Notifications for a message failed:', (error as Error)?.message);
    }
  });
}

// People hopping in and out of an empty channel would otherwise announce the same call again and again.
const lastCallNotice = new Map<string, number>();

/** Tells everyone who is away that someone started a call, at most once per channel every 5 minutes. */
export function notifyCallStarted(channel: Channel, starterId: string) {
  const now = Date.now();
  if (now - (lastCallNotice.get(channel.id) ?? 0) < CALL_NOTICE_GAP_MS) return;
  lastCallNotice.set(channel.id, now);
  setImmediate(() => {
    try {
      const starter = db.prepare('SELECT display_name FROM users WHERE id = ?').get(starterId) as { display_name: string } | undefined;
      for (const subscription of subscriptionsQuery.all(starterId) as Subscription[]) {
        if (subscription.notify_level === 'off' || isAppActive(subscription.user_id)) continue;
        const lang = langOf(subscription);
        deliver(subscription, {
          title: words(lang, 'call', { name: starter?.display_name ?? '', channel: channel.name }),
          body: '', channelId: channel.id, ttlSeconds: CALL_TTL_SECONDS,
        });
      }
    } catch (error) {
      console.warn('Notifications for a call failed:', (error as Error)?.message);
    }
  });
}

// ---------------------------------------------------------------------------------------------
// The app's side: what it may use, adding and removing this device, and each person's choice.

export const pushRouter = Router();

pushRouter.get('/config', (_req: AuthRequest, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ webPublicKey: vapidKeys().publicKey, fcm: Boolean(fcmAccount()), apns: Boolean(apnsConfig()) });
});

pushRouter.post('/subscribe', rateLimit<AuthRequest>(30, 60_000, req => req.userId!), (req: AuthRequest, res: Response) => {
  const { kind, endpoint, keys, lang } = req.body ?? {};
  if (kind !== 'web' && kind !== 'fcm' && kind !== 'apns') { res.status(400).json({ error: 'Invalid subscription' }); return; }
  if (typeof endpoint !== 'string' || endpoint.length > 2048) { res.status(400).json({ error: 'Invalid subscription' }); return; }
  const stored: Record<string, string> = { lang: lang === 'ar' ? 'ar' : 'en' };
  if (kind === 'web') {
    // A browser's key must be a point on the P-256 curve (65 bytes starting with 4), and its secret 16 bytes.
    const p256dh = base64urlBytes(keys?.p256dh, 65);
    const auth = base64urlBytes(keys?.auth, 16);
    if (!validWebEndpoint(endpoint) || !p256dh || p256dh[0] !== 4 || !auth) { res.status(400).json({ error: 'Invalid subscription' }); return; }
    Object.assign(stored, { p256dh: keys.p256dh, auth: keys.auth });
  } else if (kind === 'fcm' ? !/^[\w:.-]{20,4096}$/.test(endpoint) : !/^[0-9a-f]{64,200}$/i.test(endpoint)) {
    res.status(400).json({ error: 'Invalid subscription' }); return;
  }
  const userId = req.userId!;
  db.transaction(() => {
    // A device that someone else used before moves to whoever is signed in on it now.
    db.prepare(`
      INSERT INTO push_subscriptions (id, user_id, kind, endpoint, keys, created_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, kind = excluded.kind, keys = excluded.keys, created_at = excluded.created_at
    `).run(uuid(), userId, kind, endpoint, JSON.stringify(stored), Date.now());
    // Old browsers and reinstalled apps leave devices behind; only the most recent ones are kept.
    db.prepare(`
      DELETE FROM push_subscriptions WHERE user_id = ? AND id NOT IN
        (SELECT id FROM push_subscriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?)
    `).run(userId, userId, MAX_DEVICES_PER_PERSON);
  })();
  res.json({ ok: true });
});

// Signing out stops notifications on that device, but only for the person who owns it.
pushRouter.delete('/subscribe', (req: AuthRequest, res: Response) => {
  const endpoint = req.body?.endpoint;
  if (typeof endpoint !== 'string' || endpoint.length > 2048) { res.status(400).json({ error: 'Invalid subscription' }); return; }
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').run(endpoint, req.userId!);
  res.json({ ok: true });
});

pushRouter.put('/level', (req: AuthRequest, res: Response) => {
  const level = req.body?.level;
  if (!NOTIFY_LEVELS.includes(level)) { res.status(400).json({ error: 'Invalid notification level' }); return; }
  db.prepare('UPDATE users SET notify_level = ? WHERE id = ?').run(level, req.userId!);
  res.json({ level });
});
