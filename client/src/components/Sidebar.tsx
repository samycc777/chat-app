import { useState } from 'react';
import { MessageSquarePlus, Users, Search, LogOut, Sun, Moon } from 'lucide-react';
import { format, isToday, isYesterday } from 'date-fns';
import type { Conversation, User } from '../types';
import Avatar from './Avatar';
import NewChatModal from './NewChatModal';

interface Props {
  conversations: Conversation[];
  activeId: string | null;
  currentUser: User;
  onlineUsers: Set<string>;
  onSelect: (id: string) => void;
  onNewConversation: (conv: { id: string }) => void;
  onLogout: () => void;
  hidden?: boolean;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
}

function formatTime(ts: number | null) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isToday(d)) return format(d, 'HH:mm');
  if (isYesterday(d)) return 'Yesterday';
  return format(d, 'dd/MM/yyyy');
}

export default function Sidebar({
  conversations, activeId, currentUser, onlineUsers,
  onSelect, onNewConversation, onLogout, hidden, theme, onToggleTheme,
}: Props) {
  const [search, setSearch] = useState('');
  const [showNewChat, setShowNewChat] = useState<'direct' | 'group' | null>(null);

  const filtered = conversations.filter(c => {
    const name = getConversationName(c, currentUser.id);
    return name.toLowerCase().includes(search.toLowerCase());
  });

  return (
    <div className={`sidebar ${hidden ? 'hidden' : ''}`}>
      <div className="sidebar-header">
        <h2>Chats</h2>
        <div className="header-actions">
          <button className="icon-btn" title="New chat" onClick={() => setShowNewChat('direct')}>
            <MessageSquarePlus size={20} />
          </button>
          <button className="icon-btn" title="New group" onClick={() => setShowNewChat('group')}>
            <Users size={20} />
          </button>
          <button className="icon-btn" title="Toggle theme" onClick={onToggleTheme}>
            {theme === 'dark' ? <Sun size={20} /> : <Moon size={20} />}
          </button>
          <button className="icon-btn" title="Logout" onClick={onLogout}>
            <LogOut size={20} />
          </button>
        </div>
      </div>

      <div className="search-bar">
        <div className="search-input-wrap">
          <Search size={18} />
          <input
            placeholder="Search or start new chat"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
      </div>

      <div className="conversation-list">
        {filtered.map(c => {
          const name = getConversationName(c, currentUser.id);
          const other = c.type === 'direct'
            ? c.members.find(m => m.id !== currentUser.id)
            : null;
          const color = other?.avatarColor || '#6366f1';
          const isOnline = other ? onlineUsers.has(other.id) : false;

          return (
            <div
              key={c.id}
              className={`conversation-item ${activeId === c.id ? 'active' : ''}`}
              onClick={() => onSelect(c.id)}
            >
              <Avatar name={name} color={color} online={isOnline} />
              <div className="conv-info">
                <div className="conv-top">
                  <div className="conv-name">{name}</div>
                  <div className={`conv-time ${c.unreadCount > 0 ? 'unread' : ''}`}>
                    {formatTime(c.lastMessageTime)}
                  </div>
                </div>
                <div className="conv-bottom">
                  <div className="conv-preview">
                    {c.lastMessageType === 'image' ? '📷 Photo' :
                     c.lastMessageType === 'file' ? '📎 File' :
                     c.lastMessage || 'No messages yet'}
                  </div>
                  {c.unreadCount > 0 && (
                    <div className="unread-badge">{c.unreadCount}</div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
        {filtered.length === 0 && (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-secondary)', fontSize: 14 }}>
            {search ? 'No conversations found' : 'No conversations yet. Start a new chat!'}
          </div>
        )}
      </div>

      {showNewChat && (
        <NewChatModal
          type={showNewChat}
          onClose={() => setShowNewChat(null)}
          onCreated={conv => {
            setShowNewChat(null);
            onNewConversation(conv);
          }}
        />
      )}
    </div>
  );
}

export function getConversationName(conv: Conversation, currentUserId: string): string {
  if (conv.type === 'group') return conv.name || 'Group Chat';
  const other = conv.members.find(m => m.id !== currentUserId);
  return other?.displayName || 'Chat';
}
