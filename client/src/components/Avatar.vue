<script setup lang="ts">
import { computed } from "vue";
const props = withDefaults(
  defineProps<{
    name: string;
    color: string;
    size?: "normal" | "small";
    online?: boolean;
  }>(),
  { size: "normal", online: false },
);
const ARABIC = /\p{Script=Arabic}/u;
// Arabic names take one initial, skipping the article "ال" that starts so many of them; other
// names take the first letter of their first two words. Array.from keeps emoji whole.
const initials = computed(() => {
  const words = props.name.trim().split(/\s+/).filter(Boolean);
  if (ARABIC.test(props.name)) {
    const word = words.find((part) => part.replace(/^ال/, "").length > 0) ?? "";
    return Array.from(word.length > 3 ? word.replace(/^ال/, "") : word)[0] ?? "";
  }
  return words
    .slice(0, 2)
    .map((word) => Array.from(word)[0])
    .join("")
    .toUpperCase();
});
</script>
<template>
  <div class="avatar" :class="size" :style="{ backgroundColor: color }">
    {{ initials }}
    <div v-if="online" class="online-dot" />
  </div>
</template>

<style scoped>
/* Shared avatar */
.avatar {
  width: 44px;
  height: 44px;
  flex: 0 0 44px;
  position: relative;
  display: grid;
  place-items: center;
  border-radius: 15px;
  color: #ffffff;
  font-size: 15px;
  font-weight: 700;
}

.avatar.small {
  width: 30px;
  height: 30px;
  flex-basis: 30px;
  border-radius: 10px;
  font-size: 11px;
}

.online-dot {
  width: 9px;
  height: 9px;
  position: absolute;
  inset-inline-end: -1px;
  bottom: -1px;
  border: 2px solid var(--bg-chat);
  border-radius: 50%;
  background: #38b878;
}

@media (max-width: 768px) {
  .avatar.small {
    width: 28px;
    height: 28px;
    flex-basis: 28px;
  }
}
</style>
