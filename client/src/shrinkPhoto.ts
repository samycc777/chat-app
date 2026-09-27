// A photo straight from a phone camera is often several megabytes, which is slow to send and slow
// for everyone to download on a weak connection. Photos are resized to what a screen can show and
// saved as JPEG before they are sent; anything that cannot be shrunk is sent as it is.
const LONGEST_SIDE = 1600;
const QUALITY = 0.85;
// Smaller files are already light, and GIFs would lose their animation.
const MIN_BYTES = 300 * 1024;
const SHRINKABLE = /^image\/(jpeg|png|webp|heic|heif)$/;

export async function shrinkPhoto(file: File): Promise<File> {
  if (!SHRINKABLE.test(file.type) || file.size < MIN_BYTES || typeof createImageBitmap === 'undefined') return file;
  try {
    // Browsers turn the picture the way the camera held it (its EXIF orientation) while decoding.
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, LONGEST_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const context = canvas.getContext('2d');
    if (!context) return file;
    // JPEG has no transparency, so a see-through PNG gets a white background instead of black.
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', QUALITY));
    if (!blob || blob.size >= file.size * 0.9) return file;
    const name = file.name.replace(/\.[^.]*$/, '') + '.jpg';
    return new File([blob], name, { type: 'image/jpeg', lastModified: file.lastModified });
  } catch {
    return file;
  }
}
