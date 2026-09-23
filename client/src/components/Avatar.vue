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
