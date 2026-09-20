<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { MessageCircle } from "lucide-vue-next";
import type { Conversation, Message, User } from "./types";
import { api } from "./api";
import { connectSocket, disconnectSocket, getSocket } from "./socket";
import { useI18n } from "./i18n";
import Auth from "./components/Auth.vue";
import Sidebar from "./components/Sidebar.vue";
import ChatView from "./components/ChatView.vue";
import CallView, { type CallState } from "./components/CallView.vue";
import IncomingCallBanner from "./components/IncomingCallBanner.vue";
import WhiteboardView from "./components/WhiteboardView.vue";
const { t, translateError } = useI18n();
const token = ref<string | null>(localStorage.getItem("token")),
  currentUser = ref<User | null>(null),
  conversations = ref<Conversation[]>([]),
  activeConvId = ref<string | null>(null),
  onlineUsers = ref(new Set<string>()),
  mobileShowChat = ref(false);
const theme = ref<"dark" | "light">(
  localStorage.getItem("theme") === "light" ? "light" : "dark",
);
const whiteboard = ref<{
    conversationId: string;
    pdfUrl: string | null;
    presenterId: string;
  } | null>(null),
  showWhiteboard = ref(false),
  activeCall = ref<CallState | null>(null);
const incomingCall = ref<{
  from: User;
  conversationId: string;
  offer: RTCSessionDescriptionInit;
  callType: "audio" | "video";
} | null>(null);
const incomingCandidates = new Map<string, RTCIceCandidateInit[]>();
const activeConversation = computed(() =>
  conversations.value.find((conv) => conv.id === activeConvId.value),
);
watch(
  theme,
  (value) => {
    document.documentElement.setAttribute("data-theme", value);
    localStorage.setItem("theme", value);
  },
  { immediate: true },
);
async function loadConversations() {
  try {
    conversations.value = await api.getConversations();
  } catch {
    /* session may be ending */
  }
}
function receiveMessage(message: Message) {
  const index = conversations.value.findIndex(
    (conv) => conv.id === message.conversationId,
  );
  if (index === -1) {
    void loadConversations();
    return;
  }
  const [conversation] = conversations.value.splice(index, 1);
  conversation.lastMessage = message.content;
  conversation.lastMessageSender = message.senderId;
  conversation.lastMessageType = message.type;
  conversation.lastMessageTime = message.createdAt;
  if (message.senderId !== currentUser.value?.id)
    conversation.unreadCount = (conversation.unreadCount || 0) + 1;
  conversations.value.unshift(conversation);
}
function onRead(data: { conversationId: string; userId: string }) {
  if (data.userId === currentUser.value?.id) {
    const conv = conversations.value.find(
      (item) => item.id === data.conversationId,
    );
    if (conv) conv.unreadCount = 0;
  }
}
function onPresence(data: { userId: string; online: boolean }) {
  const next = new Set(onlineUsers.value);
  data.online ? next.add(data.userId) : next.delete(data.userId);
  onlineUsers.value = next;
}
function onIncoming(data: {
  from: Omit<User, "status">;
  conversationId: string;
  offer: RTCSessionDescriptionInit;
  callType: "audio" | "video";
}) {
  incomingCall.value = { ...data, from: { ...data.from, status: "" } };
}
function onCandidate(data: { from: string; candidate: RTCIceCandidateInit }) {
  if (incomingCall.value?.from.id !== data.from) return;
  const candidates = incomingCandidates.get(data.from) || [];
  if (candidates.length < 64) candidates.push(data.candidate);
  incomingCandidates.set(data.from, candidates);
}
function onCallFailed(data: { reason: string }) {
  activeCall.value = null;
  alert(t("callFailed", { reason: translateError(data.reason) }));
}
function onWhiteboardStarted(data: {
  conversationId: string;
  presenterId: string;
  pdfUrl: string | null;
}) {
  if (data.presenterId === currentUser.value?.id) return;
  whiteboard.value = data;
  showWhiteboard.value = true;
}
function onWhiteboardEnded(data: { conversationId: string }) {
  if (whiteboard.value?.conversationId === data.conversationId)
    whiteboard.value = null;
  showWhiteboard.value = false;
}
function bindSocket(user: User, authToken: string) {
  const socket = connectSocket(authToken);
  socket.on("new_message", receiveMessage);
  socket.on("messages_read", onRead);
  socket.on("presence", onPresence);
  socket.on("incoming_call", onIncoming);
  socket.on("ice_candidate", onCandidate);
  socket.on("call_failed", onCallFailed);
  socket.on("wb_started", onWhiteboardStarted);
  socket.on("wb_ended", onWhiteboardEnded);
  void user;
  void loadConversations();
}
watch(
  token,
  async (value) => {
    if (!value) {
      currentUser.value = null;
      conversations.value = [];
      activeConvId.value = null;
      disconnectSocket();
      return;
    }
    try {
      const user = await api.getMe();
      currentUser.value = user;
      bindSocket(user, value);
    } catch {
      localStorage.removeItem("token");
      token.value = null;
    }
  },
  { immediate: true },
);
onBeforeUnmount(() => disconnectSocket());
function logout() {
  localStorage.removeItem("token");
  token.value = null;
  currentUser.value = null;
  conversations.value = [];
  activeConvId.value = null;
  incomingCall.value = null;
  activeCall.value = null;
  disconnectSocket();
}
function selectConversation(id: string) {
  activeConvId.value = id;
  mobileShowChat.value = true;
  getSocket()?.emit("mark_read", { conversationId: id });
  const conv = conversations.value.find((item) => item.id === id);
  if (conv) conv.unreadCount = 0;
}
async function newConversation(conv: { id: string }) {
  await loadConversations();
  activeConvId.value = conv.id;
  mobileShowChat.value = true;
  getSocket()?.emit("join_conversation", { conversationId: conv.id });
}
function startCall(type: "audio" | "video") {
  const conv = activeConversation.value;
  if (activeCall.value || !conv || conv.type !== "direct") return;
  const other = conv.members.find(
    (member) => member.id !== currentUser.value?.id,
  );
  if (other)
    activeCall.value = {
      active: true,
      type,
      direction: "outgoing",
      remoteUser: other,
      conversationId: conv.id,
    };
}
function acceptCall() {
  const call = incomingCall.value;
  if (!call) return;
  activeCall.value = {
    active: true,
    type: call.callType,
    direction: "incoming",
    remoteUser: call.from,
    conversationId: call.conversationId,
    offer: call.offer,
    pendingCandidates: incomingCandidates.get(call.from.id) || [],
  };
  incomingCandidates.delete(call.from.id);
  incomingCall.value = null;
}
function rejectCall() {
  const call = incomingCall.value;
  if (!call) return;
  getSocket()?.emit("call_reject", { targetUserId: call.from.id });
  incomingCandidates.delete(call.from.id);
  incomingCall.value = null;
}
function openWhiteboard() {
  const convId = activeConvId.value,
    user = currentUser.value;
  if (!convId || !user) return;
  if (whiteboard.value?.conversationId === convId) {
    showWhiteboard.value = true;
    return;
  }
  getSocket()?.emit("wb_start", { conversationId: convId });
  whiteboard.value = {
    conversationId: convId,
    pdfUrl: null,
    presenterId: user.id,
  };
  showWhiteboard.value = true;
}
function endWhiteboard() {
  whiteboard.value = null;
  showWhiteboard.value = false;
}
</script>
<template>
  <Auth v-if="!token || !currentUser" @auth="token = $event" />
  <div v-else class="app-layout">
    <Sidebar
      :conversations="conversations"
      :active-id="activeConvId"
      :current-user="currentUser"
      :online-users="onlineUsers"
      :hidden="mobileShowChat"
      :theme="theme"
      @select="selectConversation"
      @created="newConversation"
      @logout="logout"
      @toggle-theme="theme = theme === 'dark' ? 'light' : 'dark'"
    />
    <ChatView
      v-if="activeConversation"
      :key="activeConversation.id"
      :conversation="activeConversation"
      :current-user="currentUser"
      :online-users="onlineUsers"
      @back="mobileShowChat = false"
      @call="startCall"
      @whiteboard="openWhiteboard"
    />
    <div v-else class="chat-area no-chat">
      <div class="empty-chat">
        <MessageCircle :size="72" />
        <p>{{ t("selectConversation") }}</p>
      </div>
    </div>
    <CallView v-if="activeCall" :call="activeCall" @end="activeCall = null" />
    <WhiteboardView
      v-if="showWhiteboard && whiteboard && currentUser"
      :conversation-id="whiteboard.conversationId"
      :pdf-url="whiteboard.pdfUrl"
      :presenter-id="whiteboard.presenterId"
      :current-user="currentUser"
      @end="endWhiteboard"
    />
    <IncomingCallBanner
      v-if="incomingCall && !activeCall"
      :caller="incomingCall.from"
      :call-type="incomingCall.callType"
      @accept="acceptCall"
      @reject="rejectCall"
    />
  </div>
</template>
