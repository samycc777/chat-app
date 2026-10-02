import { computed, ref, watchEffect } from 'vue';
import { bridge } from './nativeScreenShare';

export type Theme = 'light' | 'dark';

// The app looks like the device it is on: light when the phone or computer is set to light, dark
// when it is set to dark, and it changes along with it, as phones that turn dark at sunset do.
// Someone who prefers the other look picks it with the sun or moon button, and this device
// remembers that. Picking the device's own look again forgets the choice, so the app follows the
// device once more; there is no third "automatic" setting to understand. index.html reads the same
// key before the page is drawn, so a light device never sees a dark flash while the app loads.
const CHOICE_KEY = 'themeChoice';
// The look used to start dark everywhere and kept its switch under this key; that old choice is
// dropped so everyone starts with their device's look.
try { localStorage.removeItem('theme'); } catch { /* Private browsing. */ }

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
const deviceTheme = ref<Theme>(darkQuery.matches ? 'dark' : 'light');
darkQuery.addEventListener('change', event => { deviceTheme.value = event.matches ? 'dark' : 'light'; });

const storedChoice = (() => { try { return localStorage.getItem(CHOICE_KEY); } catch { return null; } })();
const choice = ref<Theme | null>(storedChoice === 'light' || storedChoice === 'dark' ? storedChoice : null);
const theme = computed<Theme>(() => choice.value ?? deviceTheme.value);

function toggleTheme() {
  const next: Theme = theme.value === 'light' ? 'dark' : 'light';
  choice.value = next === deviceTheme.value ? null : next;
  try {
    if (choice.value) localStorage.setItem(CHOICE_KEY, choice.value);
    else localStorage.removeItem(CHOICE_KEY);
  } catch { /* Private browsing: the choice lasts until the page closes. */ }
}

// The phone apps draw the page under the clock and battery icons, which the phone colours for its
// own look, not the app's: on a dark phone showing the light look they would be white on white.
// Capacitor's SystemBars, built into both apps, sets them to match the page.
const hasSystemBars = Boolean(bridge?.PluginHeaders?.some(plugin => plugin.name === 'SystemBars'));
const BROWSER_BAR = { light: '#ffffff', dark: '#1e1f22' } as const;
watchEffect(() => {
  document.documentElement.dataset.theme = theme.value;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', BROWSER_BAR[theme.value]);
  if (hasSystemBars) bridge!.nativePromise('SystemBars', 'setStyle', { style: theme.value === 'dark' ? 'DARK' : 'LIGHT' }).catch(() => {});
});

export function useTheme() {
  return { theme, toggleTheme };
}
