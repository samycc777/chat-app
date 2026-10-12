import { computed, ref, watch } from 'vue';

const read = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
const save = (key: string, value: boolean) => {
  try { localStorage.setItem(key, value ? '1' : '0'); } catch { /* Keep the choice for this visit. */ }
};

// Start calm even when the device has no reduced-motion preference. A device preference always
// takes priority over opting into effects here. index.html applies this before the first paint.
const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
export const deviceReducesMotion = ref(motionQuery.matches);
motionQuery.addEventListener('change', event => { deviceReducesMotion.value = event.matches; });
export const reduceEffects = ref(read('reduceVisualEffects') !== '0');
export const calm = computed(() => reduceEffects.value || deviceReducesMotion.value);

watch(calm, value => { document.documentElement.dataset.calm = String(value); }, { immediate: true, flush: 'sync' });
watch(reduceEffects, value => save('reduceVisualEffects', value), { flush: 'sync' });
