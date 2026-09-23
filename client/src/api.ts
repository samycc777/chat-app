const API_URL = import.meta.env.VITE_API_URL ?? '';
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
type UploadResult = { attachmentId: string; name: string; type: 'image' | 'file' };
export type LiveKitCredentials = { url: string; token: string; roomName: string; encryptionKey: string; startedAt: number };
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

function getToken(): string | null {
  return sessionStorage.getItem('token');
}

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
  getClassInfo: (): Promise<{ name: string | null }> => request('/api/class'),
  getLiveKitToken: (conversationId: string): Promise<LiveKitCredentials> =>
    request('/api/livekit/token', { method: 'POST', body: JSON.stringify({ conversationId }) }),
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
  joinClass: (classCode: string, visitorId: string, displayName: string) =>
    request('/api/auth/join', { method: 'POST', body: JSON.stringify({ classCode, visitorId, displayName }) }),

  getMe: () => request('/api/me'),

  getConversations: () => request('/api/conversations'),

  getMessages: (conversationId: string, before?: number) =>
    request(`/api/conversations/${conversationId}/messages${before ? `?before=${before}` : ''}`),

  uploadFile: async (file: File, conversationId: string, onProgress?: (progress: number) => void) => {
    const maxUploadBytes = await api.getUploadLimit();
    if (file.size > maxUploadBytes) throw new Error(`File exceeds the upload size limit (${(maxUploadBytes / 1024 / 1024).toFixed(1)} MB).`);
    const formData = new FormData();
    formData.append('conversationId', conversationId);
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
  getAttachmentBlob: async (attachmentId: string): Promise<Blob> => {
    const token = getToken();
    const res = await fetch(`${API_URL}/api/attachments/${encodeURIComponent(attachmentId)}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error(`Attachment unavailable (${res.status})`);
    return res.blob();
  },
};

export { API_URL };
