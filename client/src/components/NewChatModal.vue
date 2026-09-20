<script setup lang="ts">
import { ref } from 'vue';
import { X } from 'lucide-vue-next';
import { api } from '../api';
import type { User } from '../types';
import { useI18n } from '../i18n';
import Avatar from './Avatar.vue';
const props = defineProps<{ type: 'direct' | 'group' }>();
const emit = defineEmits<{ close: []; created: [conversation: { id: string }] }>();
const { t } = useI18n();
const search = ref(''), results = ref<User[]>([]), selected = ref<User[]>([]), groupName = ref(''), loading = ref(false);
let searchTimer: ReturnType<typeof setTimeout> | undefined;
function searchUsers(value: string) {
  search.value = value; clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => { if (!value.trim()) { results.value = []; return; } try { results.value = await api.searchUsers(value); } catch { results.value = []; } }, 180);
}
async function choose(user: User) {
  if (props.type === 'group') { selected.value = selected.value.some(item => item.id === user.id) ? selected.value.filter(item => item.id !== user.id) : [...selected.value, user]; return; }
  loading.value = true; try { emit('created', await api.createConversation('direct', [user.id])); } finally { loading.value = false; }
}
async function createGroup() {
  if (!selected.value.length || !groupName.value.trim()) return;
  loading.value = true; try { emit('created', await api.createConversation('group', selected.value.map(member => member.id), groupName.value)); } finally { loading.value = false; }
}
</script>
<template>
  <div class="modal-overlay" @click="emit('close')"><div class="modal" @click.stop>
    <div class="modal-header"><h3>{{ type === 'direct' ? t('newChat') : t('newGroup') }}</h3><button class="icon-btn" @click="emit('close')"><X :size="20" /></button></div>
    <div class="modal-body">
      <div v-if="type === 'group'" class="group-form"><input v-model="groupName" class="modal-search" :placeholder="t('groupName')"><div v-if="selected.length" class="selected-members"><div v-for="member in selected" :key="member.id" class="member-chip">{{ member.displayName }}<button @click="choose(member)">×</button></div></div></div>
      <input class="modal-search" :placeholder="t('searchUsers')" :value="search" autofocus @input="searchUsers(($event.target as HTMLInputElement).value)">
      <div v-for="user in results" :key="user.id" class="user-result" @click="choose(user)"><Avatar :name="user.displayName" :color="user.avatarColor" size="small"/><div class="user-result-info"><h4>{{ user.displayName }}</h4><p>@{{ user.username }}</p></div><span v-if="type === 'group' && selected.some(member => member.id === user.id)" class="user-result-check">✓</span></div>
      <button v-if="type === 'group'" class="create-group-btn" :disabled="loading || !selected.length || !groupName.trim()" @click="createGroup">{{ t('createGroup', { count: selected.length }) }}</button>
    </div>
  </div></div>
</template>
