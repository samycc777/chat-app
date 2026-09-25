const API_URL = import.meta.env.VITE_API_URL ?? '';
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
type UploadResult = { attachmentId: string; name: string; type: 'image' | 'file'; mimeType: string; durationMs: number | null };
export type LiveKitCredentials = { url: string; token: string; roomName: string; startedAt: number };
let cachedUploadLimit: number | null = null;
let pendingUploadLimit: Promise<number> | null = null;

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

async function request(path: string, options: RequestInit = {}) {
  const token = getToken();
  const headers: Record<string, string> = {
    ...options.headers as Record<string, string>,
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (!(options.body instanceof FormData)) {
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
  getServerInfo: (): Promise<{ name: string | null }> => request('/api/server'),
  getLiveKitToken: (channelId: string): Promise<LiveKitCredentials> =>
    request('/api/livekit/token', { method: 'POST', body: JSON.stringify({ channelId }) }),
  getScreenToken: (channelId: string): Promise<{ url: string; token: string }> =>
    request('/api/livekit/screen-token', { method: 'POST', body: JSON.stringify({ channelId }) }),
  getUploadLimit: (): Promise<number> => {
    if (cachedUploadLimit !== null) return Promise.resolve(cachedUploadLimit);
    if (pendingUploadLimit) return pendingUploadLimit;
    const pending = request('/api/upload-config').then(data => {
      const limit = Number.isSafeInteger(data.maxUploadBytes) && data.maxUploadBytes > 0
        ? data.maxUploadBytes
        : MAX_ATTACHMENT_BYTES;
      cachedUploadLimit = limit;
      return limit;
    }).finally(() => { pendingUploadLimit = null; });
    pendingUploadLimit = pending;
    return pending;
  },
  join: (inviteKey: string, visitorId: string, displayName: string) =>
    request('/api/auth/join', { method: 'POST', body: JSON.stringify({ inviteKey, visitorId, displayName }) }),

  getMe: () => request('/api/me'),

  // Pages back from the given message; its ID separates messages sent in the same millisecond.
  getMessages: (conversationId: string, before?: { createdAt: number; id: string }) =>
    request(`/api/conversations/${conversationId}/messages${before ? `?before=${before.createdAt}&beforeId=${encodeURIComponent(before.id)}` : ''}`),

  uploadFile: async (file: File, conversationId: string, onProgress?: (progress: number) => void, durationMs?: number) => {
    const maxUploadBytes = await api.getUploadLimit();
    if (file.size > maxUploadBytes) throw new Error(`File exceeds the upload size limit (${(maxUploadBytes / 1024 / 1024).toFixed(1)} MB).`);
    const formData = new FormData();
    formData.append('conversationId', conversationId);
    if (durationMs) formData.append('durationMs', String(Math.round(durationMs)));
    formData.append('file', file);
    const token = getToken();
    return new Promise<UploadResult>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${API_URL}/api/upload`);
      if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      xhr.upload.addEventListener('progress', event => {
        if (!onProgress || !event.lengthComputable || event.total <= 0) return;
        onProgress(Math.min(99, Math.round((event.loaded / event.total) * 100)));
      });
      xhr.addEventListener('load', () => {
        let data: Partial<UploadResult> & { error?: string } = {};
        try { data = JSON.parse(xhr.responseText); } catch { /* Use the HTTP status below. */ }
        if (xhr.status < 200 || xhr.status >= 300) {
          reject(new Error(data.error || `Request failed: ${xhr.status}`));
          return;
        }
        resolve(data as UploadResult);
      });
      xhr.addEventListener('error', () => reject(new Error('Network error while uploading file.')));
      xhr.addEventListener('abort', () => reject(new Error('File upload was cancelled.')));
      xhr.send(formData);
    });
  },
  getAttachmentBlob: (attachmentId: string, onProgress?: (percent: number) => void) => new Promise<Blob>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', `${API_URL}/api/attachments/${encodeURIComponent(attachmentId)}`);
    xhr.responseType = 'blob';
    const token = getToken();
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.addEventListener('progress', event => {
      if (onProgress && event.lengthComputable && event.total > 0) onProgress(Math.round((event.loaded / event.total) * 100));
    });
    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.response as Blob);
      else reject(new ApiError(`Attachment unavailable (${xhr.status})`, xhr.status));
    });
    xhr.addEventListener('error', () => reject(new Error('Attachment unavailable')));
    xhr.send();
  }),
};

export { API_URL };
