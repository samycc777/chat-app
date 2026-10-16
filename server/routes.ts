import { Response, Router } from 'express';
import db from './database';
import { AuthRequest, authMiddleware } from './auth';
import { getCall, screenIdentity } from './voice';
import { isVoiceChannel } from './channels';
import { AccessToken, TrackSource } from 'livekit-server-sdk';
import { liveKitConfig } from './livekit';
import { rateLimit } from './rateLimit';
import { pushRouter } from './push';
import { avatarRouter, avatarUrl } from './avatars';

const router = Router();
router.use(authMiddleware);
router.use(rateLimit<AuthRequest>(300, 60_000, req => req.userId!));

// Only someone the server has put in the voice channel gets into its call, so nobody can listen in
// without showing up in the sidebar.
router.post('/livekit/token', async (req: AuthRequest, res: Response) => {
  const channelId = req.body?.channelId;
  if (!isVoiceChannel(channelId, req.roomId)) { res.status(404).json({ error: 'Unknown channel' }); return; }
  const call = getCall(channelId);
  if (!call?.members.has(req.userId!)) { res.status(409).json({ error: 'Not in this voice channel' }); return; }

  const config = liveKitConfig();
  if (!config) { res.status(503).json({ error: 'Calls are not configured' }); return; }

  const user = db.prepare('SELECT display_name FROM users WHERE id = ?').get(req.userId!) as { display_name?: string } | undefined;
  const token = new AccessToken(config.apiKey, config.apiSecret, {
    identity: req.userId!,
    name: user?.display_name || 'Friend',
    ttl: '6h',
  });
  // Everyone is equal in a call: anyone can talk, show their camera and share their screen.
  token.addGrant({
    roomJoin: true,
    room: call.roomName,
    canSubscribe: true,
    canPublish: true,
    // Reactions travel over LiveKit data messages.
    canPublishData: true,
    canPublishSources: [TrackSource.MICROPHONE, TrackSource.CAMERA, TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO],
  });
  res.setHeader('Cache-Control', 'no-store');
  res.json({ url: config.url, token: await token.toJwt(), roomName: call.roomName, startedAt: call.startedAt });
});

// The phone apps share the screen from their Android code, which joins the call as a second,
// screen-only participant. It may publish nothing but the screen and receives nobody, so it adds
// no extra download to the phone that is already in the call.
router.post('/livekit/screen-token', async (req: AuthRequest, res: Response) => {
  const channelId = req.body?.channelId;
  if (!isVoiceChannel(channelId, req.roomId)) { res.status(404).json({ error: 'Unknown channel' }); return; }
  const call = getCall(channelId);
  if (!call?.members.has(req.userId!)) { res.status(409).json({ error: 'Not in this voice channel' }); return; }

  const config = liveKitConfig();
  if (!config) { res.status(503).json({ error: 'Calls are not configured' }); return; }

  const user = db.prepare('SELECT display_name FROM users WHERE id = ?').get(req.userId!) as { display_name?: string } | undefined;
  const token = new AccessToken(config.apiKey, config.apiSecret, {
    identity: screenIdentity(req.userId!),
    name: user?.display_name || 'Friend',
    ttl: '6h',
  });
  token.addGrant({
    roomJoin: true,
    room: call.roomName,
    canSubscribe: false,
    canPublish: true,
    canPublishData: false,
    canPublishSources: [TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO],
  });
  call.phoneScreens.add(req.userId!);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ url: config.url, token: await token.toJwt() });
});

router.get('/me', (req: AuthRequest, res: Response) => {
  const user = db.prepare(
    `SELECT u.id, u.username, u.display_name, u.avatar_color, u.status, u.notify_level, a.id AS avatar_id
     FROM users u LEFT JOIN avatars a ON a.user_id = u.id WHERE u.id = ?`
  ).get(req.userId!) as any;
  if (!user) { res.status(404).json({ error: 'User not found' }); return; }
  res.json({
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    avatarColor: user.avatar_color,
    avatarUrl: avatarUrl(user.avatar_id),
    status: user.status,
    notifyLevel: user.notify_level,
  });
});

router.use('/push', pushRouter);
router.use('/me/avatar', avatarRouter);

export default router;
