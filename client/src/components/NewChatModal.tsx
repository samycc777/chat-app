import { useState } from 'react';
import { X } from 'lucide-react';
import { api } from '../api';
import type { User } from '../types';
import { useI18n } from '../i18n';
import Avatar from './Avatar';

interface Props {
  type: 'direct' | 'group';
  onClose: () => void;
  onCreated: (conv: { id: string }) => void;
}

export default function NewChatModal({ type, onClose, onCreated }: Props) {
  const { t } = useI18n();
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<User[]>([]);
  const [selectedMembers, setSelectedMembers] = useState<User[]>([]);
  const [groupName, setGroupName] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSearch(q: string) {
    setSearch(q);
    if (q.length < 1) { setResults([]); return; }
    try {
      const users = await api.searchUsers(q);
      setResults(users);
    } catch { /* ignore */ }
  }

  async function startDirectChat(userId: string) {
    setLoading(true);
    try {
      const conv = await api.createConversation('direct', [userId]);
      onCreated(conv);
    } catch { /* ignore */ }
    setLoading(false);
  }

  async function createGroup() {
    if (selectedMembers.length === 0 || !groupName.trim()) return;
    setLoading(true);
    try {
      const conv = await api.createConversation('group', selectedMembers.map(m => m.id), groupName);
      onCreated(conv);
    } catch { /* ignore */ }
    setLoading(false);
  }

  function toggleMember(user: User) {
    setSelectedMembers(prev =>
      prev.some(m => m.id === user.id)
        ? prev.filter(m => m.id !== user.id)
        : [...prev, user]
    );
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{type === 'direct' ? t('newChat') : t('newGroup')}</h3>
          <button className="icon-btn" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        <div className="modal-body">
          {type === 'group' && (
            <div className="group-form">
              <input
                className="modal-search"
                placeholder={t('groupName')}
                value={groupName}
                onChange={e => setGroupName(e.target.value)}
              />
              {selectedMembers.length > 0 && (
                <div className="selected-members">
                  {selectedMembers.map(m => (
                    <div key={m.id} className="member-chip">
                      {m.displayName}
                      <button onClick={() => toggleMember(m)}>&times;</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <input
            className="modal-search"
            placeholder={t('searchUsers')}
            value={search}
            onChange={e => handleSearch(e.target.value)}
            autoFocus
          />

          {results.map(user => (
            <div
              key={user.id}
              className="user-result"
              onClick={() => type === 'direct' ? startDirectChat(user.id) : toggleMember(user)}
            >
              <Avatar name={user.displayName} color={user.avatarColor} size="small" />
              <div className="user-result-info">
                <h4>{user.displayName}</h4>
                <p>@{user.username}</p>
              </div>
              {type === 'group' && selectedMembers.some(m => m.id === user.id) && (
                <span style={{ marginLeft: 'auto', color: 'var(--text-accent)' }}>✓</span>
              )}
            </div>
          ))}

          {type === 'group' && (
            <button
              className="create-group-btn"
              onClick={createGroup}
              disabled={loading || selectedMembers.length === 0 || !groupName.trim()}
            >
              {t('createGroup', { count: selectedMembers.length })}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
