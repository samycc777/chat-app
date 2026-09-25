import express from 'express';
import http from 'http';
import compression from 'compression';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import authRouter from './auth';
import apiRouter from './routes';
import { setupSocket } from './socket';
import { serverName, DEFAULT_MAX_UPLOAD_BYTES, MAX_UPLOAD_BYTES, production, UPLOADS_DIR } from './config';
import { rateLimit } from './rateLimit';

fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const allowedOrigins = (process.env.ALLOWED_ORIGINS || (production ? '' : 'http://localhost:5173,https://localhost:5173'))
  .split(',').map(origin => origin.trim()).filter(Boolean);
if (production && allowedOrigins.length === 0) throw new Error('ALLOWED_ORIGINS is required in production');

const app = express();
const server = http.createServer(app);

app.set('trust proxy', production ? 1 : false);
app.use(cors({ origin: (origin, callback) => {
  if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
  return callback(new Error('Origin not allowed'));
} }));
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self), screen-wake-lock=(self)');
  if (production) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  next();
});
// Friends often join on mobile data; compressing the app's code and data cuts what they download.
app.use(compression());
app.use(express.json({ limit: '64kb' }));
app.get('/api/health', (_req, res) => res.json({ ok: true }));
// The server's name is shown on the join screen, before anyone has joined.
app.get('/api/server', (_req, res) => res.json({ name: serverName() || null }));

// Several friends may share one network address, so these per-address limits are generous;
// signed-in requests are also limited per person in the API router.
app.use('/api/auth', rateLimit(300, 15 * 60_000), authRouter);
app.use('/api', rateLimit(1200, 60_000), apiRouter);
app.use('/uploads', (_req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (res.headersSent) return next(err);
  if (err?.code === 'LIMIT_FILE_SIZE') {
    const limitMb = MAX_UPLOAD_BYTES === DEFAULT_MAX_UPLOAD_BYTES ? '100 MB by default' : `${(MAX_UPLOAD_BYTES / 1024 / 1024).toFixed(1)} MB`;
    return res.status(413).json({ error: `File exceeds the upload size limit (${limitMb}).` });
  }
  if (err?.message === 'Origin not allowed') return res.status(403).json({ error: 'Origin not allowed' });
  if (err instanceof SyntaxError && 'body' in err) return res.status(400).json({ error: 'Invalid JSON' });
  console.error('Request failed:', err?.message || 'unknown error');
  return res.status(500).json({ error: 'Internal server error' });
});

const clientDist = path.join(__dirname, '..', 'client', 'dist');
// Named after the server, so someone who adds the app to their home screen sees its name.
app.get('/manifest.webmanifest', (_req, res) => {
  const name = serverName() || 'Majlis';
  res.setHeader('Content-Type', 'application/manifest+json');
  res.json({
    name, short_name: name, start_url: '/', scope: '/', display: 'standalone',
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
  res.sendFile(path.join(clientDist, 'sw.js'), error => { if (error && !res.headersSent) res.status(404).end(); });
});
app.use(express.static(clientDist));
app.get('/{*path}', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(clientDist, 'index.html'));
});

setupSocket(server, allowedOrigins);

if (require.main === module) {
  const PORT = process.env.PORT || 3001;
  server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

export { app, server };
