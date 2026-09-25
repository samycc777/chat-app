<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { formatDistanceToNowStrict } from 'date-fns';
import type { Member, OnlineUser } from '../types';
import { useI18n } from '../i18n';
import Avatar from './Avatar.vue';

const props = defineProps<{ members: Member[]; online: Map<string, OnlineUser>; currentUserId: string }>();
const { t, dateLocale } = useI18n();
const byName = (a: Member, b: Member) => a.displayName.localeCompare(b.displayName);
const onlineMembers = computed(() => {
  // Someone who joined a moment ago may be online before the member list has them.
  const known = new Map(props.members.map(member => [member.id, member]));
  for (const person of props.online.values()) if (!known.has(person.id)) known.set(person.id, person);
  return [...known.values()].filter(member => props.online.has(member.id)).sort(byName);
});
// Offline people are listed with the most recently seen first.
const offlineMembers = computed(() => props.members.filter(member => !props.online.has(member.id))
  .sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0)));

// "Last seen" is worded relative to now, so it is refreshed every minute.
const now = ref(Date.now());
const clock = setInterval(() => { now.value = Date.now(); }, 60_000);
onBeforeUnmount(() => clearInterval(clock));
function lastSeen(member: Member) {
  if (!member.lastSeen) return '';
  if (now.value - member.lastSeen < 60_000) return t('lastSeenJustNow');
  return t('lastSeen', { time: formatDistanceToNowStrict(member.lastSeen, { locale: dateLocale.value, addSuffix: true }) });
}
</script>

<template>
  <aside class="member-list" :aria-label="t('members')">
    <p class="member-group">{{ t('onlineCount', { count: onlineMembers.length }) }}</p>
    <ul>
      <li v-for="person in onlineMembers" :key="person.id">
        <Avatar :name="person.displayName" :color="person.avatarColor" size="small" online />
        <bdi>{{ person.displayName }}</bdi>
        <small v-if="person.id === currentUserId">{{ t('youLabel') }}</small>
      </li>
    </ul>
    <template v-if="offlineMembers.length">
      <p class="member-group">{{ t('offlineCount', { count: offlineMembers.length }) }}</p>
      <ul>
        <li v-for="person in offlineMembers" :key="person.id" class="offline">
          <Avatar :name="person.displayName" :color="person.avatarColor" size="small" />
          <span class="member-text">
            <bdi>{{ person.displayName }}</bdi>
            <small>{{ lastSeen(person) }}</small>
          </span>
        </li>
      </ul>
    </template>
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

ul + .member-group {
  margin-top: 12px;
}

li.offline {
  min-height: 48px;
}

li.offline :deep(.avatar) {
  opacity: 0.5;
}

li.offline bdi {
  color: var(--text-secondary);
}

.member-text {
  min-width: 0;
  display: flex;
  flex-direction: column;
  line-height: 1.3;
}

.member-text small {
  overflow: hidden;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
