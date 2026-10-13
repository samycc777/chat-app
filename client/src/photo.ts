import { ref } from 'vue';
import { api } from './api';
import { useI18n } from './i18n';

// Your photo shows wherever your initials did, to everyone in the room, and can be changed before
// the call or during it. Any picture works: it is cut to a square from its middle and made small
// here, so it uploads quickly on mobile data.
const PICTURE_SIZE = 256;

async function shrinkPicture(file: File) {
  const image = await createImageBitmap(file);
  const side = Math.min(image.width, image.height);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = Math.min(PICTURE_SIZE, side);
  const context = canvas.getContext('2d')!;
  // A see-through picture would turn black as a JPEG.
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, (image.width - side) / 2, (image.height - side) / 2, side, side, 0, 0, canvas.width, canvas.height);
  image.close();
  return new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('No picture')), 'image/jpeg', 0.85));
}

/** Choosing and removing your own photo. The server tells everyone in the room, you included. */
export function usePhoto(saved: (url: string | null) => void = () => {}) {
  const { t } = useI18n();
  const busy = ref(false);
  const problem = ref('');
  async function change(action: () => Promise<{ avatarUrl: string | null }>) {
    busy.value = true;
    problem.value = '';
    try { saved((await action()).avatarUrl); } catch { problem.value = t('photoNotSaved'); }
    busy.value = false;
  }
  function choose() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (file) void change(async () => api.setAvatar(await shrinkPicture(file)));
    });
    input.click();
  }
  return { busy, problem, choose, remove: () => change(api.removeAvatar) };
}
