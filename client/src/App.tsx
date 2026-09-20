import { useState, useEffect, useCallback, useRef } from 'react';
import { MessageCircle } from 'lucide-react';
import type { User, Conversation, Message } from './types';
import { api } from './api';
import { connectSocket, disconnectSocket, getSocket } from './socket';
import Auth from './components/Auth';
import Sidebar from './components/Sidebar';
import ChatView from './components/ChatView';
import CallView, { IncomingCallBanner } from './components/CallView';
import type { CallState } from './components/CallView';
import WhiteboardView from './components/WhiteboardView';
import { useI18n } from './i18n';
import './styles.css';

export default function App() {
  const { t, translateError } = useI18n();
  const tRef = useRef(t);
  const translateErrorRef = useRef(translateError);
  useEffect(() => {
    tRef.current = t;
    translateErrorRef.current = translateError;
  }, [t, translateError]);
  const [token, setToken] = useState<string | null>(localStorage.getItem('token'));
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const [onlineUsers, setOnlineUsers] = useState<Set<string>>(new Set());
  const [mobileShowChat, setMobileShowChat] = useState(false);
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    return (localStorage.getItem('theme') as 'dark' | 'light') || 'dark';
  });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  const [whiteboard, setWhiteboard] = useState<{
    conversationId: string;
    pdfUrl: string | null;
    presenterId: string;
  } | null>(null);
  const [showWhiteboard, setShowWhiteboard] = useState(false);

  const [activeCall, setActiveCall] = useState<CallState | null>(null);
  const [incomingCall, setIncomingCall] = useState<{
    from: User;
    conversationId: string;
    offer: RTCSessionDescriptionInit;
    callType: 'audio' | 'video';
  } | null>(null);
  const incomingCallRef = useRef<typeof incomingCall>(null);
  const incomingCandidatesRef = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());

  function toggleTheme() {
    setTheme(prev => prev === 'dark' ? 'light' : 'dark');
  }

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

        socket.on('incoming_call', (data: {
          from: { id: string; username: string; displayName: string; avatarColor: string };
          conversationId: string;
          offer: RTCSessionDescriptionInit;
          callType: 'audio' | 'video';
        }) => {
          incomingCallRef.current = { from: { ...data.from, status: '' }, conversationId: data.conversationId, offer: data.offer, callType: data.callType };
          setIncomingCall({
            from: { ...data.from, status: '' },
            conversationId: data.conversationId,
            offer: data.offer,
            callType: data.callType,
          });
        });

        socket.on('ice_candidate', (data: { from: string; candidate: RTCIceCandidateInit }) => {
          if (incomingCallRef.current?.from.id !== data.from) return;
          const candidates = incomingCandidatesRef.current.get(data.from) || [];
          if (candidates.length < 64) candidates.push(data.candidate);
          incomingCandidatesRef.current.set(data.from, candidates);
        });

        socket.on('call_failed', (data: { reason: string }) => {
          setActiveCall(null);
          alert(tRef.current('callFailed', { reason: translateErrorRef.current(data.reason) }));
        });

        socket.on('wb_started', (data: {
          conversationId: string; presenterId: string; pdfUrl: string | null;
        }) => {
          if (data.presenterId === user.id) return;
          setWhiteboard({
            conversationId: data.conversationId,
            pdfUrl: data.pdfUrl,
            presenterId: data.presenterId,
          });
          setShowWhiteboard(true);
        });

        socket.on('wb_ended', (data: { conversationId: string }) => {
          setWhiteboard(prev => prev?.conversationId === data.conversationId ? null : prev);
          setShowWhiteboard(false);
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

  function handleStartCall(type: 'audio' | 'video') {
    if (activeCall || !activeConvId) return;
    const conv = conversations.find(c => c.id === activeConvId);
    if (!conv || conv.type !== 'direct') return;
    const other = conv.members.find(m => m.id !== currentUser?.id);
    if (!other) return;

    setActiveCall({
      active: true,
      type,
      direction: 'outgoing',
      remoteUser: other,
      conversationId: activeConvId,
    });
  }

  function handleAcceptCall() {
    if (!incomingCall) return;
    setActiveCall({
      active: true,
      type: incomingCall.callType,
      direction: 'incoming',
      remoteUser: incomingCall.from,
      conversationId: incomingCall.conversationId,
      offer: incomingCall.offer,
      pendingCandidates: incomingCandidatesRef.current.get(incomingCall.from.id) || [],
    });
    incomingCandidatesRef.current.delete(incomingCall.from.id);
    incomingCallRef.current = null;
    setIncomingCall(null);
  }

  function handleRejectCall() {
    if (!incomingCall) return;
    const socket = getSocket();
    socket?.emit('call_reject', { targetUserId: incomingCall.from.id });
    incomingCandidatesRef.current.delete(incomingCall.from.id);
    incomingCallRef.current = null;
    setIncomingCall(null);
  }

  const handleEndCall = useCallback(() => {
    setActiveCall(null);
  }, []);

  function handleWhiteboardClick() {
    if (!activeConvId || !currentUser) return;
    if (whiteboard && whiteboard.conversationId === activeConvId) {
      setShowWhiteboard(true);
      return;
    }
    const socket = getSocket();
    socket?.emit('wb_start', { conversationId: activeConvId });
    setWhiteboard({ conversationId: activeConvId, pdfUrl: null, presenterId: currentUser.id });
    setShowWhiteboard(true);
  }

  function handleWhiteboardEnd() {
    setWhiteboard(null);
    setShowWhiteboard(false);
  }

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
        theme={theme}
        onToggleTheme={toggleTheme}
      />
      {activeConversation ? (
        <ChatView
          key={activeConversation.id}
          conversation={activeConversation}
          currentUser={currentUser}
          onlineUsers={onlineUsers}
          onBack={() => setMobileShowChat(false)}
          onStartCall={handleStartCall}
          onWhiteboardClick={handleWhiteboardClick}
        />
      ) : (
        <div className={`chat-area no-chat`}>
          <div className="empty-chat">
            <MessageCircle size={72} />
            <p>{t('selectConversation')}</p>
          </div>
        </div>
      )}

      {activeCall && currentUser && (
        <CallView
          call={activeCall}
          onEnd={handleEndCall}
        />
      )}

      {showWhiteboard && whiteboard && currentUser && (
        <WhiteboardView
          conversationId={whiteboard.conversationId}
          pdfUrl={whiteboard.pdfUrl}
          presenterId={whiteboard.presenterId}
          currentUser={currentUser}
          onEnd={handleWhiteboardEnd}
        />
      )}

      {incomingCall && !activeCall && (
        <IncomingCallBanner
          caller={incomingCall.from}
          callType={incomingCall.callType}
          onAccept={handleAcceptCall}
          onReject={handleRejectCall}
        />
      )}
    </div>
  );
}
