const API_URL = import.meta.env.VITE_API_URL ?? '';
/** The full address of something the server gives as a path, such as a profile picture. */
export const serverUrl = (path: string) => `${API_URL}${path}`;
export type LiveKitCredentials = { url: string; token: string; roomName: string; startedAt: number };

// Carries the HTTP status so callers can tell an ended session (401) from a network problem.
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

// Kept across app restarts, so a friend who opens the app from their home screen is straight in.
export const session = {
  get token(): string | null { try { return localStorage.getItem('token'); } catch { return null; } },
  set token(value: string | null) {
    try { if (value) localStorage.setItem('token', value); else localStorage.removeItem('token'); } catch { /* Private browsing: the session lasts until the tab closes. */ }
  },
};
const getToken = () => session.token;

export async function request(path: string, options: RequestInit = {}) {
  const token = getToken();
  const headers: Record<string, string> = {
    ...options.headers as Record<string, string>,
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  // Pictures carry their own type.
  if (!(options.body instanceof Blob)) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(`${API_URL}${path}`, { ...options, headers });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(data.error || `Request failed: ${res.status}`, res.status);
  }
  return res.json();
}

export const api = {
  // With an invite, the name is that invite's room's.
  getServerInfo: (invite?: string): Promise<{ name: string | null; invite?: string }> =>
    request(`/api/server${invite ? `?invite=${encodeURIComponent(invite)}` : ''}`),
  createRoom: (name: string, creationKey: string): Promise<{ id: string; name: string; invite: string }> =>
    request('/api/rooms', { method: 'POST', body: JSON.stringify({ name, creationKey }) }),
  getLiveKitToken: (channelId: string): Promise<LiveKitCredentials> =>
    request('/api/livekit/token', { method: 'POST', body: JSON.stringify({ channelId }) }),
  getScreenToken: (channelId: string): Promise<{ url: string; token: string }> =>
    request('/api/livekit/screen-token', { method: 'POST', body: JSON.stringify({ channelId }) }),
  join: (inviteKey: string, visitorId: string, displayName: string) =>
    request('/api/auth/join', { method: 'POST', body: JSON.stringify({ inviteKey, visitorId, displayName }) }),

  getMe: () => request('/api/me'),
  setAvatar: (picture: Blob): Promise<{ avatarUrl: string }> => request('/api/me/avatar', { method: 'PUT', body: picture }),
  removeAvatar: (): Promise<{ avatarUrl: null }> => request('/api/me/avatar', { method: 'DELETE' }),
};

export { API_URL };
