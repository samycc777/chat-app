<script setup lang="ts">
import { MessageSquare, Mic, MicOff, Volume1 } from 'lucide-vue-next';
import { useI18n } from '../i18n';
import { useCall } from '../call/context';
import { canAdjustVolume, MIN_VOLUME } from '../call/sound';
import Avatar from './Avatar.vue';
import CallSheet from './CallSheet.vue';

// Who is in the call: whether their microphone is on and whether they are talking, a raised hand,
// how loud they are on this device, and a way to write to them privately.
const { t } = useI18n();
const call = useCall();
const { participants, sheet } = call.state;
const { levelOf, setPersonVolume } = call.sound;
const { raisedHands, colorOf, pictureOf } = call.tiles;
const { chatTo } = call.chat;
function messagePrivately(identity: string) {
  chatTo.value = identity;
  sheet.value = 'chat';
}
</script>

<template>
  <CallSheet side :label="t('participants')" :title="t('participantsCount', { count: participants.length })">
    <ul class="call-people">
      <li v-for="person in participants" :key="person.identity">
        <Avatar :name="person.name" :color="colorOf(person.identity)" :picture="pictureOf(person.identity)" size="small" />
        <div class="call-person-main">
          <span class="call-person-name">
            <bdi>{{ person.name }}</bdi>
            <small v-if="person.local">{{ t('youLabel') }}</small>
          </span>
          <!-- Only on this device: turning someone down here changes nothing for anyone else. -->
          <label v-if="canAdjustVolume && !person.local" class="call-person-volume">
            <Volume1 :size="16" aria-hidden="true" />
            <input
              type="range"
              :min="MIN_VOLUME"
              max="1"
              step="0.05"
              :value="levelOf(person.identity)"
              :aria-label="t('personVolume', { name: person.name })"
              @input="setPersonVolume(person.identity, ($event.target as HTMLInputElement).valueAsNumber)"
            >
          </label>
        </div>
        <span v-if="raisedHands.has(person.identity)" class="call-person-hand anime-wave">✋</span>
        <button v-if="!person.local" class="call-icon-btn" type="button" :title="t('messagePrivately', { name: person.name })" :aria-label="t('messagePrivately', { name: person.name })" @click="messagePrivately(person.identity)">
          <MessageSquare :size="18" />
        </button>
        <Mic v-if="person.micOn" :size="18" class="call-person-mic" :class="{ on: person.speaking }" />
        <MicOff v-else :size="18" class="call-person-mic off" />
      </li>
    </ul>
  </CallSheet>
</template>

<style scoped>
.call-people {
  margin: 0 -16px;
  padding: 6px 0;
  list-style: none;
}

.call-people li {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 16px;
}

.call-person-main {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
}

.call-person-name {
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 6px;
  overflow: hidden;
  font-size: 15px;
  white-space: nowrap;
}

.call-person-name bdi {
  overflow: hidden;
  text-overflow: ellipsis;
}

.call-person-name small {
  color: var(--text-secondary);
  font-size: 13px;
}

.call-person-volume {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-secondary);
}

.call-person-volume input {
  min-width: 0;
  height: 30px;
  flex: 1;
  margin: 0;
  accent-color: var(--text-accent);
}

.call-person-hand {
  font-size: 18px;
}

.call-person-mic {
  flex: none;
  color: var(--text-secondary);
}

.call-person-mic.on {
  color: var(--speaking);
}

.call-person-mic.off {
  color: var(--danger);
}
</style>
