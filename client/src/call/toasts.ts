import { ref } from 'vue';

// One short notice at a time floats over the call; a new one replaces the one showing.
export function useToasts() {
  const toast = ref('');
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  function showToast(message: string, duration = 3500) {
    toast.value = message;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.value = ''; }, duration);
  }
  return { toast, showToast, dispose: () => clearTimeout(toastTimer) };
}
export type Toasts = ReturnType<typeof useToasts>;
