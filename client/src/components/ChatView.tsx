import { useState, useEffect, useRef, useCallback } from 'react';
import {
  ArrowLeft, Paperclip, Send, Reply, Pencil, Trash2, X, Download, Phone, Video, Monitor,
} from 'lucide-react';
import { format, isToday, isYesterday, isSameDay } from 'date-fns';
import type { Conversation, Message, User } from '../types';
import { api, API_URL } from '../api';
import { getSocket } from '../socket';
import Avatar from './Avatar';
import { getConversationName } from './Sidebar';

interface Props {
  conversation: Conversation;
  currentUser: User;
  onlineUsers: Set<string>;
  onBack: () => void;
  onStartCall: (type: 'audio' | 'video') => void;
  onWhiteboardClick: () => void;
}

export default function ChatView({ conversation, currentUser, onlineUsers, onBack, onStartCall, onWhiteboardClick }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [editingMsg, setEditingMsg] = useState<Message | null>(null);
  const [typingUsers, setTypingUsers] = useState<Set<string>>(new Set());
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; msg: Message } | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isAtBottom = useRef(true);

  const scrollToBottom = useCallback(() => {
    if (isAtBottom.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.getMessages(conversation.id).then(msgs => {
      if (!cancelled) {
        setMessages(msgs);
        setTimeout(() => {
          messagesEndRef.current?.scrollIntoView();
        }, 50);
      }
    });
    return () => { cancelled = true; };
  }, [conversation.id]);

  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

    socket.emit('mark_read', { conversationId: conversation.id });

    function handleNewMessage(msg: Message) {
      if (msg.conversationId !== conversation.id) return;
      setMessages(prev => [...prev, msg]);
      setTimeout(scrollToBottom, 50);
      socket!.emit('mark_read', { conversationId: conversation.id });
    }

    function handleEdited(data: { messageId: string; content: string; editedAt: number }) {
      setMessages(prev => prev.map(m =>
        m.id === data.messageId ? { ...m, content: data.content, editedAt: data.editedAt } : m
      ));
    }

    function handleDeleted(data: { messageId: string }) {
      setMessages(prev => prev.map(m =>
        m.id === data.messageId ? { ...m, deleted: true, content: null } : m
      ));
    }

    function handleTyping(data: { conversationId: string; userId: string }) {
      if (data.conversationId !== conversation.id || data.userId === currentUser.id) return;
      setTypingUsers(prev => new Set(prev).add(data.userId));
    }

    function handleStopTyping(data: { conversationId: string; userId: string }) {
      if (data.conversationId !== conversation.id) return;
      setTypingUsers(prev => {
        const next = new Set(prev);
        next.delete(data.userId);
        return next;
      });
    }

    socket.on('new_message', handleNewMessage);
    socket.on('message_edited', handleEdited);
    socket.on('message_deleted', handleDeleted);
    socket.on('user_typing', handleTyping);
    socket.on('user_stop_typing', handleStopTyping);

    return () => {
      socket.off('new_message', handleNewMessage);
      socket.off('message_edited', handleEdited);
      socket.off('message_deleted', handleDeleted);
      socket.off('user_typing', handleTyping);
      socket.off('user_stop_typing', handleStopTyping);
      setTypingUsers(new Set());
    };
  }, [conversation.id, currentUser.id, scrollToBottom]);

  function handleScroll() {
    const el = containerRef.current;
    if (!el) return;
    isAtBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
  }

  function handleInputChange(val: string) {
    setInput(val);
    const socket = getSocket();
    if (!socket) return;

    socket.emit('typing', { conversationId: conversation.id });
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(() => {
      socket.emit('stop_typing', { conversationId: conversation.id });
    }, 2000);
  }

  function handleSend() {
    const text = input.trim();
    if (!text && !editingMsg) return;
    const socket = getSocket();
    if (!socket) return;

    if (editingMsg) {
      socket.emit('edit_message', { messageId: editingMsg.id, content: text });
      setEditingMsg(null);
      setInput('');
      return;
    }

    socket.emit('send_message', {
      conversationId: conversation.id,
      content: text,
      type: 'text',
      replyTo: replyTo?.id || null,
    });

    socket.emit('stop_typing', { conversationId: conversation.id });
    setInput('');
    setReplyTo(null);
    isAtBottom.current = true;
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
    if (e.key === 'Escape') {
      setReplyTo(null);
      setEditingMsg(null);
      setInput('');
    }
  }

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const result = await api.uploadFile(file);
      const socket = getSocket();
      socket?.emit('send_message', {
        conversationId: conversation.id,
        content: result.type === 'image' ? '' : result.name,
        type: result.type,
        fileUrl: result.url,
        fileName: result.name,
      });
      isAtBottom.current = true;
    } catch { /* ignore */ }
    e.target.value = '';
  }

  function handleContextMenu(e: React.MouseEvent, msg: Message) {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, msg });
  }

  function startEdit(msg: Message) {
    setEditingMsg(msg);
    setInput(msg.content || '');
    setReplyTo(null);
    setContextMenu(null);
    textareaRef.current?.focus();
  }

  function startReply(msg: Message) {
    setReplyTo(msg);
    setEditingMsg(null);
    setContextMenu(null);
    textareaRef.current?.focus();
  }

  function deleteMessage(msg: Message) {
    const socket = getSocket();
    socket?.emit('delete_message', { messageId: msg.id });
    setContextMenu(null);
  }

  const other = conversation.type === 'direct'
    ? conversation.members.find(m => m.id !== currentUser.id)
    : null;
  const chatName = getConversationName(conversation, currentUser.id);
  const isOnline = other ? onlineUsers.has(other.id) : false;

  const typingNames = Array.from(typingUsers)
    .map(uid => conversation.members.find(m => m.id === uid)?.displayName)
    .filter(Boolean);

  return (
    <div className="chat-area">
      <div className="chat-header">
        <button className="icon-btn back-btn" onClick={onBack}>
          <ArrowLeft size={20} />
        </button>
        <Avatar
          name={chatName}
          color={other?.avatarColor || '#6366f1'}
          online={isOnline}
        />
        <div className="chat-header-info">
          <h3>{chatName}</h3>
          <div className={`status-text ${isOnline ? 'online' : ''}`}>
            {conversation.type === 'group'
              ? `${conversation.members.length} members`
              : isOnline
                ? 'online'
                : other?.lastSeen
                  ? `last seen ${formatLastSeen(other.lastSeen)}`
                  : ''}
          </div>
        </div>
        <div className="chat-header-actions">
          <button className="icon-btn" title="Whiteboard" onClick={onWhiteboardClick}>
            <Monitor size={20} />
          </button>
          {conversation.type === 'direct' && (
            <>
              <button className="icon-btn" title="Voice call" onClick={() => onStartCall('audio')}>
                <Phone size={20} />
              </button>
              <button className="icon-btn" title="Video call" onClick={() => onStartCall('video')}>
                <Video size={20} />
              </button>
            </>
          )}
        </div>
      </div>

      <div className="messages-container" ref={containerRef} onScroll={handleScroll}>
        {messages.map((msg, i) => {
          const showDate = i === 0 || !isSameDay(new Date(msg.createdAt), new Date(messages[i - 1].createdAt));
          const isOwn = msg.senderId === currentUser.id;
          const showSender = conversation.type === 'group' && !isOwn &&
            (i === 0 || messages[i - 1].senderId !== msg.senderId);

          return (
            <div key={msg.id}>
              {showDate && (
                <div className="date-separator">
                  <span>{formatDate(msg.createdAt)}</span>
                </div>
              )}
              <div className="message-group">
                <div
                  className={`message-bubble ${isOwn ? 'out' : 'in'}`}
                  onContextMenu={e => handleContextMenu(e, msg)}
                >
                  {showSender && (
                    <div className="message-sender" style={{ color: msg.sender.avatarColor }}>
                      {msg.sender.displayName}
                    </div>
                  )}

                  {msg.replyTo && (
                    <div className="message-reply">
                      <div className="reply-sender">{msg.replyTo.senderDisplayName}</div>
                      <div className="reply-text">
                        {msg.replyTo.type === 'image' ? '📷 Photo' : msg.replyTo.content}
                      </div>
                    </div>
                  )}

                  {msg.deleted ? (
                    <div className="deleted-message">🚫 This message was deleted</div>
                  ) : msg.type === 'image' && msg.fileUrl ? (
                    <div>
                      <img
                        className="message-image"
                        src={`${API_URL}${msg.fileUrl}`}
                        alt="Shared image"
                        loading="lazy"
                      />
                    </div>
                  ) : msg.type === 'file' && msg.fileUrl ? (
                    <a className="message-file" href={`${API_URL}${msg.fileUrl}`} target="_blank" rel="noreferrer">
                      <Download size={18} />
                      <span>{msg.fileName || 'File'}</span>
                    </a>
                  ) : (
                    <div className="message-content">{msg.content}</div>
                  )}

                  <div className="message-meta">
                    {msg.editedAt && <span className="message-edited">edited</span>}
                    <span className="message-time">{format(new Date(msg.createdAt), 'HH:mm')}</span>
                  </div>

                  <div className="message-actions">
                    {!msg.deleted && (
                      <>
                        <button onClick={() => startReply(msg)} title="Reply">
                          <Reply size={14} />
                        </button>
                        {isOwn && (
                          <>
                            <button onClick={() => startEdit(msg)} title="Edit">
                              <Pencil size={14} />
                            </button>
                            <button onClick={() => deleteMessage(msg)} title="Delete">
                              <Trash2 size={14} />
                            </button>
                          </>
                        )}
                      </>
                    )}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
        <div ref={messagesEndRef} />
      </div>

      <div className="typing-indicator">
        {typingNames.length > 0 && (
          <span>{typingNames.join(', ')} {typingNames.length === 1 ? 'is' : 'are'} typing...</span>
        )}
      </div>

      {replyTo && (
        <div className="reply-preview">
          <div className="reply-preview-content">
            <div className="reply-preview-sender">{replyTo.sender.displayName}</div>
            <div className="reply-preview-text">
              {replyTo.type === 'image' ? '📷 Photo' : replyTo.content}
            </div>
          </div>
          <button className="icon-btn" onClick={() => setReplyTo(null)}>
            <X size={18} />
          </button>
        </div>
      )}

      {editingMsg && (
        <div className="reply-preview">
          <div className="reply-preview-content">
            <div className="reply-preview-sender">Editing message</div>
            <div className="reply-preview-text">{editingMsg.content}</div>
          </div>
          <button className="icon-btn" onClick={() => { setEditingMsg(null); setInput(''); }}>
            <X size={18} />
          </button>
        </div>
      )}

      <div className="chat-input-area">
        <label className="icon-btn" style={{ cursor: 'pointer' }}>
          <Paperclip size={20} />
          <input type="file" style={{ display: 'none' }} onChange={handleFileUpload} />
        </label>
        <div className="message-input-wrap">
          <textarea
            ref={textareaRef}
            placeholder="Type a message"
            value={input}
            onChange={e => {
              handleInputChange(e.target.value);
              e.target.style.height = 'auto';
              e.target.style.height = Math.min(e.target.scrollHeight, 150) + 'px';
            }}
            onKeyDown={handleKeyDown}
            rows={1}
          />
        </div>
        <button className="send-btn" onClick={handleSend}>
          <Send size={20} />
        </button>
      </div>

      {contextMenu && (
        <>
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 99 }}
            onClick={() => setContextMenu(null)}
          />
          <div className="context-menu" style={{ top: contextMenu.y, left: contextMenu.x }}>
            <button onClick={() => startReply(contextMenu.msg)}>
              <Reply size={16} /> Reply
            </button>
            {contextMenu.msg.senderId === currentUser.id && !contextMenu.msg.deleted && (
              <>
                <button onClick={() => startEdit(contextMenu.msg)}>
                  <Pencil size={16} /> Edit
                </button>
                <button className="danger" onClick={() => deleteMessage(contextMenu.msg)}>
                  <Trash2 size={16} /> Delete
                </button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function formatDate(ts: number): string {
  const d = new Date(ts);
  if (isToday(d)) return 'Today';
  if (isYesterday(d)) return 'Yesterday';
  return format(d, 'EEEE, MMMM d, yyyy');
}

function formatLastSeen(ts: number): string {
  const d = new Date(ts);
  if (isToday(d)) return `today at ${format(d, 'HH:mm')}`;
  if (isYesterday(d)) return `yesterday at ${format(d, 'HH:mm')}`;
  return format(d, 'dd/MM/yyyy HH:mm');
}
