import express from 'express';
import http from 'http';
import compression from 'compression';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { createHash } from 'crypto';
import authRouter, { authMiddleware, checkInvite, cleanDisplayName, handoffFormat } from './auth';
import { signOut } from './account';
import apiRouter from './routes';
import { setupSocket } from './socket';
import { inviteKey, openJoin, serverName, production } from './config';
import { liveKitConfig } from './livekit';
import { roomsRouter } from './rooms';
import { roomAdminRouter } from './roomAdmin';
import { rateLimit } from './rateLimit';
import { serveAvatar } from './avatars';
import db, { closeDatabase } from './database';

const allowedOrigins = (process.env.ALLOWED_ORIGINS || (production ? '' : 'http://localhost:5173,https://localhost:5173'))
  .split(',').map(origin => origin.trim()).filter(Boolean);
if (production && allowedOrigins.length === 0) throw new Error('ALLOWED_ORIGINS is required in production');

const app = express();
const server = http.createServer(app);
app.disable('x-powered-by');
const clientDist = path.join(__dirname, '..', 'client', 'dist');

// The page may run only its own code, and talk only to this server and the call server, so a name
// or anything else someone types can never run as code in everyone's app, and the app cannot be
// shown inside another site. The one script written into the page (the theme chooser in index.html)
// is allowed by its exact content. Calls need 'wasm-unsafe-eval' for the voice filter (cleanVoice.ts),
// blob: and mediastream: for cameras, screens and sound, and blob:/data: for pictures.
const inlineScriptHashes = (() => {
  try {
    const page = fs.readFileSync(path.join(clientDist, 'index.html'), 'utf8');
    return [...page.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
      .map(([, code]) => `'sha256-${createHash('sha256').update(code).digest('base64')}'`);
  } catch { return []; }
})();
function contentSecurityPolicy(req: express.Request) {
  const connect = ["'self'"];
  // Older Safari does not count the page's own address over WebSocket as 'self'.
  const host = req.get('host');
  if (host && /^[\w.-]+(:\d+)?$/.test(host)) connect.push(`${req.secure ? 'wss' : 'ws'}://${host}`);
  // Read on every request, like the call server's settings themselves (see livekit.ts).
  const liveKitUrl = liveKitConfig()?.url;
  if (liveKitUrl) {
    try {
      const callServer = new URL(liveKitUrl);
      const secure = callServer.protocol === 'wss:' || callServer.protocol === 'https:';
      connect.push(`${secure ? 'wss' : 'ws'}://${callServer.host}`, `${secure ? 'https' : 'http'}://${callServer.host}`);
    } catch { /* A broken LIVEKIT_URL already stops calls; the page itself still loads. */ }
  }
  return [
    "default-src 'self'",
    `script-src 'self' 'wasm-unsafe-eval' ${inlineScriptHashes.join(' ')}`.trim(),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' blob: mediastream:",
    "worker-src 'self' blob:",
    `connect-src ${connect.join(' ')}`,
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

app.set('trust proxy', production ? 1 : false);
app.use(cors({ origin: (origin, callback) => {
  if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
  return callback(new Error('Origin not allowed'));
} }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self), screen-wake-lock=(self)');
  if (production) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  // Set on every answer: pages need it, and on anything else it does nothing.
  res.setHeader('Content-Security-Policy', contentSecurityPolicy(req));
  next();
});
// Friends often join on mobile data; compressing the app's code and data cuts what they download.
app.use(compression());
app.use(express.json({ limit: '64kb' }));
// Railway checks this before sending people to a new version; it is healthy only if the database answers.
app.get('/api/health', (_req, res) => {
  try {
    db.prepare('SELECT 1').get();
    res.json({ ok: true });
  } catch (error) {
    console.error('Health check: the database did not answer:', error);
    res.status(503).json({ ok: false });
  }
});
// The room's name is shown on the join screen, before anyone has joined: the room of the invite
// the page has, or else the home room. When joining is open, the home room's key comes along, so
// the plain address joins exactly as the invite link does. It checks invites, so it is limited
// like joining is, and wrong keys count with joining's (see checkInvite), so it cannot be used to guess a key.
app.get('/api/server', rateLimit(300, 15 * 60_000), (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const { room, retryAfterSeconds } = typeof req.query.invite === 'string' && req.query.invite
    ? checkInvite(req.ip || 'unknown', req.query.invite) : {};
  if (retryAfterSeconds) {
    res.setHeader('Retry-After', retryAfterSeconds);
    res.status(429).json({ error: 'Too many attempts' }); return;
  }
  res.json({ name: (room ? room.name : serverName()) || null, ...(openJoin() ? { invite: inviteKey() } : {}) });
});

// Several friends may share one network address, so these per-address limits are generous;
// signed-in requests are also limited per person in the API router.
app.use('/api/auth', rateLimit(300, 15 * 60_000), authRouter);
app.post('/api/auth/sign-out', authMiddleware, signOut);
app.use('/api/rooms', rateLimit(60, 15 * 60_000), roomsRouter, roomAdminRouter);
// Pictures are shown by images, which cannot send the session header (see avatars.ts), so this
// comes before the API's session check.
app.get('/api/avatars/:id', rateLimit(1200, 60_000), serveAvatar);
app.use('/api', rateLimit(1200, 60_000), apiRouter);
// An unknown API address is an error, not the page (which the fallback below would send).
app.use('/api', (_req, res) => { res.status(404).json({ error: 'Not found' }); });
app.use((err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (res.headersSent) return next(err);
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Too large' });
  if (err?.message === 'Origin not allowed') return res.status(403).json({ error: 'Origin not allowed' });
  if (err instanceof SyntaxError && 'body' in err) return res.status(400).json({ error: 'Invalid JSON' });
  console.error('Request failed:', err?.message || 'unknown error');
  return res.status(500).json({ error: 'Internal server error' });
});

// Named after the room, so someone who adds the app to their home screen sees its name.
// An iPhone keeps a Home Screen app's storage apart from Safari's, so the app would open knowing
// nothing: no invite, no name. The page therefore asks for the manifest with its invite, a hand-off
// pass (see makeHandoff in auth.ts) and the name, and the app's start link carries them, so it opens
// as the same person. They are only echoed back when the invite is right, to someone who already has them.
// It checks the invite, so wrong keys count with joining's (see checkInvite): it cannot be used to guess one.
app.get('/manifest.webmanifest', rateLimit(300, 15 * 60_000), (req, res) => {
  const param = (key: string) => typeof req.query[key] === 'string' ? req.query[key] as string : '';
  const invite = param('invite'), handoff = param('handoff'), person = cleanDisplayName(param('name')).slice(0, 60);
  const { room, retryAfterSeconds } = invite ? checkInvite(req.ip || 'unknown', invite) : {};
  if (retryAfterSeconds) {
    res.setHeader('Retry-After', retryAfterSeconds);
    res.status(429).json({ error: 'Too many attempts' }); return;
  }
  const name = (room ? room.name : serverName()) || 'Majlis';
  let startUrl = '/';
  if (room) {
    const start = new URLSearchParams({ invite });
    if (handoffFormat(handoff)) start.set('handoff', handoff);
    if (person) start.set('name', person);
    startUrl = `/?${start}`;
  }
  res.setHeader('Content-Type', 'application/manifest+json');
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    name, short_name: name, start_url: startUrl, scope: '/', display: 'standalone',
    background_color: '#313338', theme_color: '#1e1f22',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' },
    ],
  });
});
// Built files carry a hash of their content in their names, so browsers may keep them for a year;
// the page itself is revalidated on every visit, so a new deploy reaches everyone straight away.
app.use('/assets', express.static(path.join(clientDist, 'assets'), { immutable: true, maxAge: '1y', fallthrough: false }));
// The notification service worker must always be the newest one, and it caches nothing itself.
app.get('/sw.js', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile('sw.js', { root: clientDist }, error => { if (error && !res.headersSent) res.status(404).end(); });
});
app.use(express.static(clientDist));
app.get('/{*path}', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(clientDist, 'index.html'));
});

const io = setupSocket(server, allowedOrigins);

if (require.main === module) {
  const PORT = process.env.PORT || 3001;
  server.listen(PORT, () => console.log(`Server running on port ${PORT}`));

  // A deploy stops the old server with SIGTERM. Closing in order tells every app it was
  // disconnected (so it reconnects to the new server at once), lets requests under way finish, and
  // leaves the database file complete. If something hangs, the server stops anyway after 10 s, as
  // the platform would soon force it to.
  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal}: shutting down`);
    setTimeout(() => { console.error('Shutting down took too long; stopping now'); process.exit(1); }, 10_000).unref();
    // Closing Socket.IO also stops the HTTP server from taking new connections.
    io.close(() => {
      try { closeDatabase(); } catch (error) { console.error('Closing the database failed:', error); process.exit(1); }
      console.log('Shut down cleanly');
      process.exit(0);
    });
    server.closeIdleConnections();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
  // A promise nobody waited for (a notification, a LiveKit request) must not end everyone's calls,
  // so it is only logged. A thrown error nobody caught leaves the server in an unknown state, so it
  // stops and the platform starts it again.
  process.on('unhandledRejection', reason => console.error('Unhandled promise rejection:', reason));
  process.on('uncaughtException', error => {
    console.error('Uncaught exception, stopping:', error);
    process.exit(1);
  });
}

export { app, server };
