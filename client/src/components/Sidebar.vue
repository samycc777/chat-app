<script setup lang="ts">
import { computed, ref } from 'vue';
import { format, isToday, isYesterday } from 'date-fns';
import { MessageSquarePlus, Users, Search, LogOut, Sun, Moon, Globe } from 'lucide-vue-next';
import type { Conversation, User } from '../types';
import { useI18n } from '../i18n';
import Avatar from './Avatar.vue';
import NewChatModal from './NewChatModal.vue';
const props = defineProps<{ conversations: Conversation[]; activeId: string | null; currentUser: User; onlineUsers: Set<string>; hidden: boolean; theme: 'dark' | 'light' }>();
const emit = defineEmits<{ select: [id: string]; created: [conversation: { id: string }]; logout: []; toggleTheme: [] }>();
const { t, lang, dateLocale, setLang } = useI18n();
const search = ref(''), showNewChat = ref<'direct' | 'group' | null>(null), showLangMenu = ref(false);
function conversationName(conv: Conversation) { if (conv.type === 'group') return conv.name || t('groupChat'); return conv.members.find(member => member.id !== props.currentUser.id)?.displayName || t('chat'); }
const filtered = computed(() => props.conversations.filter(conv => conversationName(conv).toLowerCase().includes(search.value.toLowerCase())));
function formatTime(ts: number | null) { if (!ts) return ''; const d = new Date(ts); if (isToday(d)) return format(d, 'HH:mm'); if (isYesterday(d)) return t('yesterday'); return format(d, 'dd/MM/yyyy', { locale: dateLocale.value }); }
</script>
<template>
  <div class="sidebar" :class="{ hidden }">
    <div class="sidebar-header"><h2>{{ t('chats') }}</h2><div class="header-actions">
      <button class="icon-btn" :title="t('newChat')" @click="showNewChat = 'direct'"><MessageSquarePlus :size="20"/></button><button class="icon-btn" :title="t('newGroup')" @click="showNewChat = 'group'"><Users :size="20"/></button><button class="icon-btn" :title="t('toggleTheme')" @click="emit('toggleTheme')"><Sun v-if="theme === 'dark'" :size="20"/><Moon v-else :size="20"/></button>
      <div class="lang-switcher"><button class="icon-btn" :title="t('language')" @click="showLangMenu = !showLangMenu"><Globe :size="20"/></button><template v-if="showLangMenu"><div class="lang-menu-backdrop" @click="showLangMenu = false"/><div class="lang-menu"><button :class="{ active: lang === 'en' }" @click="setLang('en'); showLangMenu = false">English</button><button :class="{ active: lang === 'ar' }" @click="setLang('ar'); showLangMenu = false">العربية</button></div></template></div>
      <button class="icon-btn" :title="t('logout')" @click="emit('logout')"><LogOut :size="20"/></button>
    </div></div>
    <div class="search-bar"><div class="search-input-wrap"><Search :size="18"/><input v-model="search" :placeholder="t('searchOrStart')"></div></div>
    <div class="conversation-list"><div v-for="conversation in filtered" :key="conversation.id" class="conversation-item" :class="{ active: activeId === conversation.id }" @click="emit('select', conversation.id)">
      <Avatar :name="conversationName(conversation)" :color="conversation.members.find(member => member.id !== currentUser.id)?.avatarColor || '#6366f1'" :online="conversation.type === 'direct' && onlineUsers.has(conversation.members.find(member => member.id !== currentUser.id)?.id || '')"/>
      <div class="conv-info"><div class="conv-top"><div class="conv-name">{{ conversationName(conversation) }}</div><div class="conv-time" :class="{ unread: conversation.unreadCount > 0 }">{{ formatTime(conversation.lastMessageTime) }}</div></div><div class="conv-bottom"><div class="conv-preview">{{ conversation.lastMessageType === 'image' ? `📷 ${t('photo')}` : conversation.lastMessageType === 'file' ? `📎 ${t('file')}` : conversation.lastMessage || t('noMessagesYet') }}</div><div v-if="conversation.unreadCount > 0" class="unread-badge">{{ conversation.unreadCount }}</div></div></div>
    </div><div v-if="filtered.length === 0" class="sidebar-empty">{{ search ? t('noConversationsFound') : t('noConversationsYet') }}</div></div>
    <NewChatModal v-if="showNewChat" :type="showNewChat" @close="showNewChat = null" @created="conv => { showNewChat = null; emit('created', conv) }"/>
  </div>
</template>
