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
const initials = computed(() =>
  props.name
    .split(" ")
    .map((word) => word[0])
    .join("")
    .toUpperCase()
    .slice(0, 2),
);
</script>
<template>
  <div class="avatar" :class="size" :style="{ backgroundColor: color }">
    {{ initials }}
    <div v-if="online" class="online-dot" />
  </div>
</template>
