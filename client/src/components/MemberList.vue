<script setup lang="ts">
import { computed } from 'vue';
import type { OnlineUser } from '../types';
import { useI18n } from '../i18n';
import Avatar from './Avatar.vue';

const props = defineProps<{ people: OnlineUser[]; currentUserId: string }>();
const { t } = useI18n();
const sorted = computed(() => [...props.people].sort((a, b) => a.displayName.localeCompare(b.displayName)));
</script>

<template>
  <aside class="member-list" :aria-label="t('members')">
    <p class="member-group">{{ t('onlineCount', { count: people.length }) }}</p>
    <ul>
      <li v-for="person in sorted" :key="person.id">
        <Avatar :name="person.displayName" :color="person.avatarColor" size="small" online />
        <bdi>{{ person.displayName }}</bdi>
        <small v-if="person.id === currentUserId">{{ t('youLabel') }}</small>
      </li>
    </ul>
  </aside>
</template>

<style scoped>
.member-list {
  width: 240px;
  min-height: 0;
  flex: 0 0 240px;
  overflow-y: auto;
  padding: max(16px, env(safe-area-inset-top)) 8px 16px;
  background: var(--bg-secondary);
}

.member-group {
  padding: 8px 8px 4px;
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.02em;
  text-transform: uppercase;
}

ul {
  list-style: none;
}

li {
  min-height: 42px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 8px;
  border-radius: 6px;
  color: var(--text-primary);
  font-size: 15px;
}

li:hover {
  background: var(--bg-hover);
}

li bdi {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

li small {
  color: var(--text-secondary);
  font-size: 12px;
}
</style>
