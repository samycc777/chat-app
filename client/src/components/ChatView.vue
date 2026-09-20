<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { format, isToday, isYesterday, isSameDay } from 'date-fns';
import { ArrowLeft, Paperclip, Send, Reply, Pencil, Trash2, X, Phone, Video, Monitor } from 'lucide-vue-next';
import type { Conversation, Message, User } from '../types';
import { api } from '../api';
import { getSocket } from '../socket';
import { useI18n } from '../i18n';
import Avatar from './Avatar.vue';
import Attachment from './Attachment.vue';
const props = defineProps<{ conversation: Conversation; currentUser: User; onlineUsers: Set<string> }>();
const emit = defineEmits<{ back: []; call: [type: 'audio' | 'video']; whiteboard: [] }>();
const { t, dateLocale } = useI18n();
const messages = ref<Message[]>([]), input = ref(''), replyTo = ref<Message | null>(null), editingMsg = ref<Message | null>(null), typingUsers = ref(new Set<string>());
const container = ref<HTMLElement | null>(null), textarea = ref<HTMLTextAreaElement | null>(null), fileInput = ref<HTMLInputElement | null>(null);
const contextMenu = ref<{ x: number; y: number; message: Message } | null>(null);
let typingTimer: ReturnType<typeof setTimeout> | undefined; let atBottom = true;
const other = computed(() => props.conversation.type === 'direct' ? props.conversation.members.find(member => member.id !== props.currentUser.id) : null);
const chatName = computed(() => props.conversation.type === 'group' ? props.conversation.name || t('groupChat') : other.value?.displayName || t('chat'));
const typingNames = computed(() => [...typingUsers.value].map(id => props.conversation.members.find(member => member.id === id)?.displayName).filter((name): name is string => Boolean(name)));
function scrollBottom() { if (atBottom) nextTick(() => container.value?.lastElementChild?.scrollIntoView({ behavior: 'smooth' })); }
function markRead() { getSocket()?.emit('mark_read', { conversationId: props.conversation.id }); }
function onNewMessage(message: Message) { if (message.conversationId !== props.conversation.id) return; messages.value.push(message); scrollBottom(); markRead(); }
function onEdited(data: { messageId: string; content: string; editedAt: number }) { messages.value = messages.value.map(m => m.id === data.messageId ? { ...m, content: data.content, editedAt: data.editedAt } : m); }
function onDeleted(data: { messageId: string }) { messages.value = messages.value.map(m => m.id === data.messageId ? { ...m, deleted: true, content: null } : m); }
function onTyping(data: { conversationId: string; userId: string }) { if (data.conversationId === props.conversation.id && data.userId !== props.currentUser.id) typingUsers.value.add(data.userId); }
function onStopTyping(data: { conversationId: string; userId: string }) { if (data.conversationId === props.conversation.id) typingUsers.value.delete(data.userId); }
watch(() => props.conversation.id, async id => { messages.value = []; try { messages.value = await api.getMessages(id); await nextTick(); container.value?.lastElementChild?.scrollIntoView(); } catch { messages.value = []; } markRead(); }, { immediate: true });
onMounted(() => { const socket = getSocket(); if (!socket) return; socket.on('new_message', onNewMessage); socket.on('message_edited', onEdited); socket.on('message_deleted', onDeleted); socket.on('user_typing', onTyping); socket.on('user_stop_typing', onStopTyping); });
onBeforeUnmount(() => { const socket = getSocket(); socket?.off('new_message', onNewMessage); socket?.off('message_edited', onEdited); socket?.off('message_deleted', onDeleted); socket?.off('user_typing', onTyping); socket?.off('user_stop_typing', onStopTyping); clearTimeout(typingTimer); });
function onScroll() { if (container.value) atBottom = container.value.scrollHeight - container.value.scrollTop - container.value.clientHeight < 100; }
function updateInput(value: string) { input.value = value; const socket = getSocket(); socket?.emit('typing', { conversationId: props.conversation.id }); clearTimeout(typingTimer); typingTimer = setTimeout(() => socket?.emit('stop_typing', { conversationId: props.conversation.id }), 2000); }
function send() { const content = input.value.trim(), socket = getSocket(); if ((!content && !editingMsg.value) || !socket) return; if (editingMsg.value) { socket.emit('edit_message', { messageId: editingMsg.value.id, content }); editingMsg.value = null; input.value = ''; return; } socket.emit('send_message', { conversationId: props.conversation.id, content, type: 'text', replyTo: replyTo.value?.id || null }); socket.emit('stop_typing', { conversationId: props.conversation.id }); input.value = ''; replyTo.value = null; atBottom = true; }
function keydown(event: KeyboardEvent) { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(); } if (event.key === 'Escape') { replyTo.value = null; editingMsg.value = null; input.value = ''; } }
async function upload(event: Event) { const el = event.target as HTMLInputElement, file = el.files?.[0]; if (!file) return; try { const result = await api.uploadFile(file, props.conversation.id); getSocket()?.emit('send_message', { conversationId: props.conversation.id, content: result.type === 'image' ? '' : result.name, type: result.type, attachmentId: result.attachmentId, fileName: result.name }, (response: { error?: string }) => { if (response?.error) alert(response.error); }); atBottom = true; } catch (cause) { alert(cause instanceof Error ? cause.message : 'Upload failed'); } el.value = ''; }
function startReply(message: Message) { replyTo.value = message; editingMsg.value = null; contextMenu.value = null; textarea.value?.focus(); }
function startEdit(message: Message) { editingMsg.value = message; input.value = message.content || ''; replyTo.value = null; contextMenu.value = null; textarea.value?.focus(); }
function deleteMessage(message: Message) { getSocket()?.emit('delete_message', { messageId: message.id }); contextMenu.value = null; }
function openContext(event: MouseEvent, message: Message) { event.preventDefault(); contextMenu.value = { x: event.clientX, y: event.clientY, message }; }
function dateLabel(timestamp: number) { const date = new Date(timestamp); return isToday(date) ? t('today') : isYesterday(date) ? t('yesterday') : format(date, 'EEEE, MMMM d, yyyy', { locale: dateLocale.value }); }
</script>
<template>
  <div class="chat-area">
    <div class="chat-header"><button class="icon-btn back-btn" @click="emit('back')"><ArrowLeft :size="20"/></button><Avatar :name="chatName" :color="other?.avatarColor || '#6366f1'" :online="Boolean(other && onlineUsers.has(other.id))"/><div class="chat-header-info"><h3>{{ chatName }}</h3><div class="status-text" :class="{ online: other && onlineUsers.has(other.id) }">{{ conversation.type === 'group' ? t('members', { count: conversation.members.length }) : other && onlineUsers.has(other.id) ? t('online') : '' }}</div></div><div class="chat-header-actions"><button class="icon-btn" :title="t('whiteboard')" @click="emit('whiteboard')"><Monitor :size="20"/></button><template v-if="conversation.type === 'direct'"><button class="icon-btn" :title="t('voiceCall')" @click="emit('call', 'audio')"><Phone :size="20"/></button><button class="icon-btn" :title="t('videoCall')" @click="emit('call', 'video')"><Video :size="20"/></button></template></div></div>
    <div ref="container" class="messages-container" @scroll="onScroll">
      <template v-for="(message, index) in messages" :key="message.id"><div v-if="index === 0 || !isSameDay(new Date(message.createdAt), new Date(messages[index - 1].createdAt))" class="date-separator"><span>{{ dateLabel(message.createdAt) }}</span></div><div class="message-group"><div class="message-bubble" :class="message.senderId === currentUser.id ? 'out' : 'in'" @contextmenu="openContext($event, message)">
        <div v-if="conversation.type === 'group' && message.senderId !== currentUser.id && (index === 0 || messages[index - 1].senderId !== message.senderId)" class="message-sender" :style="{ color: message.sender.avatarColor }">{{ message.sender.displayName }}</div>
        <div v-if="message.replyTo" class="message-reply"><div class="reply-sender">{{ message.replyTo.senderDisplayName }}</div><div class="reply-text">{{ message.replyTo.type === 'image' ? `📷 ${t('photo')}` : message.replyTo.content }}</div></div>
        <div v-if="message.deleted" class="deleted-message">🚫 {{ t('messageDeleted') }}</div><Attachment v-else-if="message.type === 'image' && message.attachmentId" :attachment-id="message.attachmentId" :name="message.fileName || t('sharedImage')" image/><Attachment v-else-if="message.type === 'file' && message.attachmentId" :attachment-id="message.attachmentId" :name="message.fileName || t('file')"/><div v-else class="message-content">{{ message.content }}</div>
        <div class="message-meta"><span v-if="message.editedAt" class="message-edited">{{ t('edited') }}</span><span class="message-time">{{ format(new Date(message.createdAt), 'HH:mm') }}</span></div><div class="message-actions"><button v-if="!message.deleted" :title="t('reply')" @click="startReply(message)"><Reply :size="14"/></button><template v-if="message.senderId === currentUser.id && !message.deleted"><button :title="t('edit')" @click="startEdit(message)"><Pencil :size="14"/></button><button :title="t('delete')" @click="deleteMessage(message)"><Trash2 :size="14"/></button></template></div>
      </div></div></template><div class="messages-end"/>
    </div>
    <div class="typing-indicator"><span v-if="typingNames.length">{{ typingNames.length === 1 ? t('isTyping', { names: typingNames.join(', ') }) : t('areTyping', { names: typingNames.join(', ') }) }}</span></div>
    <div v-if="replyTo || editingMsg" class="reply-preview"><div class="reply-preview-content"><div class="reply-preview-sender">{{ editingMsg ? t('editingMessage') : replyTo?.sender.displayName }}</div><div class="reply-preview-text">{{ editingMsg ? editingMsg.content : replyTo?.content }}</div></div><button class="icon-btn" @click="replyTo = null; editingMsg = null; input = ''"><X :size="18"/></button></div>
    <div class="chat-input-area"><label class="icon-btn" style="cursor:pointer" @click="fileInput?.click()"><Paperclip :size="20"/><input ref="fileInput" type="file" accept="image/jpeg,image/png,image/gif,image/webp,application/pdf" style="display:none" @change="upload"></label><div class="message-input-wrap"><textarea ref="textarea" :value="input" :placeholder="t('typeAMessage')" rows="1" @input="updateInput(($event.target as HTMLTextAreaElement).value); ($event.target as HTMLTextAreaElement).style.height = 'auto'; ($event.target as HTMLTextAreaElement).style.height = Math.min(($event.target as HTMLTextAreaElement).scrollHeight, 150) + 'px'" @keydown="keydown"/></div><button class="send-btn" @click="send"><Send :size="20"/></button></div>
    <template v-if="contextMenu"><div class="context-menu-backdrop" @click="contextMenu = null"/><div class="context-menu" :style="{ top: `${contextMenu.y}px`, left: `${contextMenu.x}px` }"><button @click="startReply(contextMenu.message)"><Reply :size="16"/> {{ t('reply') }}</button><template v-if="contextMenu.message.senderId === currentUser.id && !contextMenu.message.deleted"><button @click="startEdit(contextMenu.message)"><Pencil :size="16"/> {{ t('edit') }}</button><button class="danger" @click="deleteMessage(contextMenu.message)"><Trash2 :size="16"/> {{ t('delete') }}</button></template></div></template>
  </div>
</template>
