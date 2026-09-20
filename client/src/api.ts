const API_URL = import.meta.env.VITE_API_URL ?? '';

function getToken(): string | null {
  return localStorage.getItem('token');
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
  register: (username: string, displayName: string, password: string) =>
    request('/api/auth/register', { method: 'POST', body: JSON.stringify({ username, displayName, password }) }),

  login: (username: string, password: string) =>
    request('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),

  getMe: () => request('/api/me'),

  searchUsers: (q: string) => request(`/api/users/search?q=${encodeURIComponent(q)}`),

  getConversations: () => request('/api/conversations'),

  createConversation: (type: string, memberIds: string[], name?: string) =>
    request('/api/conversations', { method: 'POST', body: JSON.stringify({ type, memberIds, name }) }),

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
