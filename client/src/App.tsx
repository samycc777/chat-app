import { useState, useEffect, useCallback } from 'react';
import { MessageCircle } from 'lucide-react';
import type { User, Conversation, Message } from './types';
import { api } from './api';
import { connectSocket, disconnectSocket, getSocket } from './socket';
import Auth from './components/Auth';
import Sidebar from './components/Sidebar';
import ChatView from './components/ChatView';
import './styles.css';

export default function App() {
  const [token, setToken] = useState<string | null>(localStorage.getItem('token'));
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const [onlineUsers, setOnlineUsers] = useState<Set<string>>(new Set());
  const [mobileShowChat, setMobileShowChat] = useState(false);

  const loadConversations = useCallback(async () => {
    try {
      const convs = await api.getConversations();
      setConversations(convs);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (!token) return;

    api.getMe()
      .then(user => {
        setCurrentUser(user);
        const socket = connectSocket(token);

        socket.on('new_message', (msg: Message) => {
          setConversations(prev => {
            const idx = prev.findIndex(c => c.id === msg.conversationId);
            if (idx === -1) {
              loadConversations();
              return prev;
            }
            const updated = [...prev];
            const conv = { ...updated[idx] };
            conv.lastMessage = msg.content;
            conv.lastMessageSender = msg.senderId;
            conv.lastMessageType = msg.type;
            conv.lastMessageTime = msg.createdAt;
            if (msg.senderId !== user.id) {
              conv.unreadCount = (conv.unreadCount || 0) + 1;
            }
            updated.splice(idx, 1);
            updated.unshift(conv);
            return updated;
          });
        });

        socket.on('messages_read', (data: { conversationId: string; userId: string }) => {
          if (data.userId === user.id) {
            setConversations(prev =>
              prev.map(c => c.id === data.conversationId ? { ...c, unreadCount: 0 } : c)
            );
          }
        });

        socket.on('presence', (data: { userId: string; online: boolean }) => {
          setOnlineUsers(prev => {
            const next = new Set(prev);
            if (data.online) next.add(data.userId);
            else next.delete(data.userId);
            return next;
          });
        });

        loadConversations();
      })
      .catch(() => {
        localStorage.removeItem('token');
        setToken(null);
      });

    return () => {
      disconnectSocket();
    };
  }, [token, loadConversations]);

  function handleAuth(newToken: string) {
    setToken(newToken);
  }

  function handleLogout() {
    localStorage.removeItem('token');
    disconnectSocket();
    setToken(null);
    setCurrentUser(null);
    setConversations([]);
    setActiveConvId(null);
  }

  function handleSelectConversation(id: string) {
    setActiveConvId(id);
    setMobileShowChat(true);
    const socket = getSocket();
    socket?.emit('mark_read', { conversationId: id });
    setConversations(prev =>
      prev.map(c => c.id === id ? { ...c, unreadCount: 0 } : c)
    );
  }

  function handleNewConversation(conv: { id: string }) {
    loadConversations().then(() => {
      setActiveConvId(conv.id);
      setMobileShowChat(true);
      const socket = getSocket();
      socket?.emit('join_conversation', { conversationId: conv.id });
    });
  }

  if (!token || !currentUser) {
    return <Auth onAuth={handleAuth} />;
  }

  const activeConversation = conversations.find(c => c.id === activeConvId);

  return (
    <div className="app-layout">
      <Sidebar
        conversations={conversations}
        activeId={activeConvId}
        currentUser={currentUser}
        onlineUsers={onlineUsers}
        onSelect={handleSelectConversation}
        onNewConversation={handleNewConversation}
        onLogout={handleLogout}
        hidden={mobileShowChat}
      />
      {activeConversation ? (
        <ChatView
          key={activeConversation.id}
          conversation={activeConversation}
          currentUser={currentUser}
          onlineUsers={onlineUsers}
          onBack={() => setMobileShowChat(false)}
        />
      ) : (
        <div className={`chat-area no-chat`}>
          <div className="empty-chat">
            <MessageCircle size={72} />
            <p>Select a conversation or start a new chat</p>
          </div>
        </div>
      )}
    </div>
  );
}
