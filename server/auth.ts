import { Request, Response, NextFunction, Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuid } from 'uuid';
import db from './database';

const JWT_SECRET = process.env.JWT_SECRET || (process.env.NODE_ENV === 'production'
  ? (() => { throw new Error('JWT_SECRET is required in production'); })()
  : 'local-development-only-change-me');
if (process.env.NODE_ENV === 'production' && JWT_SECRET.length < 32) {
  throw new Error('JWT_SECRET must be at least 32 characters in production');
}
const AVATAR_COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899'];

export interface AuthRequest extends Request {
  userId?: string;
}

export function authMiddleware(req: AuthRequest, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) {
    res.status(401).json({ error: 'No token provided' });
    return;
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { userId: string };
    req.userId = decoded.userId;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

export function verifyToken(token: string): string | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { userId: string };
    return decoded.userId;
  } catch {
    return null;
  }
}

const router = Router();

router.post('/register', (req: Request, res: Response) => {
  const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
  const displayName = typeof req.body.displayName === 'string' ? req.body.displayName.trim() : '';
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (!username || !displayName || !password) {
    res.status(400).json({ error: 'All fields are required' });
    return;
  }
  if (username.length < 3 || username.length > 20) {
    res.status(400).json({ error: 'Username must be 3-20 characters' });
    return;
  }
  if (password.length < 10 || password.length > 128) {
    res.status(400).json({ error: 'Password must be 10-128 characters' });
    return;
  }
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username) || !displayName || displayName.length > 60) {
    res.status(400).json({ error: 'Invalid username or display name' });
    return;
  }

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) {
    res.status(409).json({ error: 'Username already taken' });
    return;
  }

  const id = uuid();
  const passwordHash = bcrypt.hashSync(password, 10);
  const avatarColor = AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];

  db.prepare(
    'INSERT INTO users (id, username, display_name, password_hash, avatar_color) VALUES (?, ?, ?, ?, ?)'
  ).run(id, username, displayName, passwordHash, avatarColor);

  const token = jwt.sign({ userId: id }, JWT_SECRET, { expiresIn: '30d' });

  res.status(201).json({
    token,
    user: { id, username, displayName, avatarColor, status: 'Hey there! I am using ChatApp' },
  });
});

router.post('/login', (req: Request, res: Response) => {
  const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (!username || !password || password.length > 128) {
    res.status(400).json({ error: 'Username and password are required' });
    return;
  }

  const user = db.prepare(
    'SELECT id, username, display_name, password_hash, avatar_color, status FROM users WHERE username = ?'
  ).get(username) as any;

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });

  res.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      avatarColor: user.avatar_color,
      status: user.status,
    },
  });
});

export default router;
