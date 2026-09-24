export interface User {
  id: string;
  username: string;
  displayName: string;
  avatarColor: string;
  status: string;
  lastSeen?: number;
}

export interface OnlineUser {
  id: string;
  displayName: string;
  avatarColor: string;
}

export interface Message {
  id: string;
  /** Order of arrival on the server, which separates messages sent in the same millisecond. */
  seq?: number;
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

export interface Channel {
  id: string;
  name: string;
  kind: 'text' | 'voice';
  position: number;
}

/** Who is in a voice channel's call, as the server knows it. */
export interface VoiceCall {
  channelId: string;
  startedAt: number;
  members: OnlineUser[];
  hands: { userId: string; displayName: string }[];
}
