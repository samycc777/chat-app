import express from 'express';
import http from 'http';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import authRouter from './auth';
import apiRouter from './routes';
import { setupSocket } from './socket';
import { className, DEFAULT_MAX_UPLOAD_BYTES, MAX_UPLOAD_BYTES, production, UPLOADS_DIR } from './config';
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
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self)');
  next();
});
app.use(express.json({ limit: '64kb' }));
app.get('/api/health', (_req, res) => res.json({ ok: true }));
// The class name is shown on the join screen, before anyone has entered a code.
app.get('/api/class', (_req, res) => res.json({ name: className() || null }));

// A whole class may share one school network address, so these per-address limits are generous;
// signed-in requests are also limited per student in the API router.
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
app.use(express.static(clientDist));
app.get('/{*path}', (_req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'));
});

setupSocket(server, allowedOrigins);

if (require.main === module) {
  const PORT = process.env.PORT || 3001;
  server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

export { app, server };
