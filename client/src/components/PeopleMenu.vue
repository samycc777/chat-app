<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { Undo2, UserX, Users } from 'lucide-vue-next';
import type { OnlineUser } from '../types';
import { api } from '../api';
import { getSocket } from '../socket';
import { useI18n } from '../i18n';
import Avatar from './Avatar.vue';

const props = defineProps<{ people: OnlineUser[]; currentUserId: string; isTeacher: boolean }>();
const { t } = useI18n();
const open = ref(false);
const confirming = ref<string | null>(null);
const removed = ref<{ id: string; displayName: string; avatarColor: string }[]>([]);
const sorted = computed(() => [...props.people].sort((a, b) =>
  Number(b.role === 'teacher') - Number(a.role === 'teacher') || a.displayName.localeCompare(b.displayName)));

async function loadRemoved() {
  if (props.isTeacher) removed.value = await api.getRemovedMembers().catch(() => removed.value);
}
function closeOnEscape(event: KeyboardEvent) { if (event.key === 'Escape') open.value = false; }
watch(open, isOpen => {
  confirming.value = null;
  if (isOpen) {
    void loadRemoved();
    document.addEventListener('keydown', closeOnEscape);
  } else document.removeEventListener('keydown', closeOnEscape);
});
onBeforeUnmount(() => document.removeEventListener('keydown', closeOnEscape));

// The server signs the student out everywhere at once and keeps them out until allowed back.
function remove(person: OnlineUser) {
  getSocket()?.emit('remove_member', { userId: person.id }, () => {
    confirming.value = null;
    void loadRemoved();
  });
}
function allowBack(userId: string) {
  getSocket()?.emit('restore_member', { userId }, () => { void loadRemoved(); });
}
</script>

<template>
  <div class="people-menu">
    <button
      class="header-action people-trigger"
      :class="{ open }"
      type="button"
      :title="t('people')"
      :aria-label="t('peopleOnline', { count: people.length })"
      :aria-expanded="open"
      @click="open = !open"
    >
      <Users :size="18" /><span class="people-count" aria-hidden="true">{{ people.length }}</span>
    </button>
    <template v-if="open">
      <div class="popover-backdrop" @click="open = false" />
      <div class="display-popover people-popover" role="dialog" :aria-label="t('people')">
        <p class="display-label">{{ t('peopleOnline', { count: people.length }) }}</p>
        <ul class="people-list">
          <li v-for="person in sorted" :key="person.id">
            <Avatar :name="person.displayName" :color="person.avatarColor" size="small" />
            <span class="people-name">
              <bdi>{{ person.displayName }}</bdi>
              <small v-if="person.id === currentUserId">{{ t('youLabel') }}</small>
              <span v-if="person.role === 'teacher'" class="role-badge">{{ t('teacherBadge') }}</span>
            </span>
            <template v-if="isTeacher && person.role === 'student'">
              <span v-if="confirming === person.id" class="people-confirm">
                <button class="danger" type="button" @click="remove(person)">{{ t('remove') }}</button>
                <button type="button" @click="confirming = null">{{ t('cancel') }}</button>
              </span>
              <button
                v-else
                class="people-action"
                type="button"
                :title="t('removeFromClass')"
                :aria-label="`${t('removeFromClass')}: ${person.displayName}`"
                @click="confirming = person.id"
              >
                <UserX :size="16" />
              </button>
            </template>
          </li>
        </ul>
        <p v-if="confirming" class="people-warning">{{ t('removeExplained') }}</p>
        <template v-if="isTeacher && removed.length">
          <p class="display-label">{{ t('removedStudents') }}</p>
          <ul class="people-list">
            <li v-for="person in removed" :key="person.id">
              <Avatar :name="person.displayName" :color="person.avatarColor" size="small" />
              <span class="people-name"><bdi>{{ person.displayName }}</bdi></span>
              <button class="people-action text" type="button" @click="allowBack(person.id)">
                <Undo2 :size="15" />{{ t('allowBack') }}
              </button>
            </li>
          </ul>
        </template>
      </div>
    </template>
  </div>
</template>
