export interface User {
  id: string;
  username: string;
  displayName: string;
  avatarColor: string;
  status: string;
  lastSeen?: number;
}

export interface Message {
  id: string;
  conversationId: string;
  senderId: string;
  content: string | null;
  type: 'text' | 'image' | 'file' | 'system';
  fileUrl?: string;
  fileName?: string;
  replyTo?: {
    id: string;
    content: string;
    type: string;
    senderId: string;
    senderDisplayName: string;
  } | null;
  editedAt: number | null;
  deleted: boolean;
  createdAt: number;
  sender: {
    username: string;
    displayName: string;
    avatarColor: string;
  };
}

export interface Conversation {
  id: string;
  type: 'direct' | 'group';
  name: string | null;
  createdAt: number;
  lastMessage: string | null;
  lastMessageSender: string | null;
  lastMessageType: string | null;
  lastMessageTime: number | null;
  unreadCount: number;
  members: User[];
}
