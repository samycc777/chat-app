const API_URL = import.meta.env.VITE_API_URL ?? '';

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
    throw new Error(data.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

export const api = {
  getIceConfiguration: async (): Promise<RTCConfiguration> => {
    const data = await request('/api/ice-config');
    return { iceServers: data.iceServers };
  },
  joinClass: (classCode: string, visitorId: string, displayName: string) =>
    request('/api/auth/join', { method: 'POST', body: JSON.stringify({ classCode, visitorId, displayName }) }),

  getMe: () => request('/api/me'),

  getConversations: () => request('/api/conversations'),

  getMessages: (conversationId: string, before?: number) =>
    request(`/api/conversations/${conversationId}/messages${before ? `?before=${before}` : ''}`),

  uploadFile: (file: File, conversationId: string) => {
    const formData = new FormData();
    formData.append('conversationId', conversationId);
    formData.append('file', file);
    return request('/api/upload', { method: 'POST', body: formData });
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
