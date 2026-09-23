export type Role = 'student' | 'teacher';

export interface User {
  id: string;
  username: string;
  displayName: string;
  avatarColor: string;
  status: string;
  role: Role;
  lastSeen?: number;
}

export interface Message {
  id: string;
  conversationId: string;
  senderId: string;
  content: string | null;
  type: 'text' | 'image' | 'file' | 'system';
  fileUrl?: string;
  attachmentId?: string | null;
  fileName?: string;
  replyTo?: {
    id: string;
    content: string | null;
    type: string;
    deleted?: boolean;
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
    role?: Role;
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
