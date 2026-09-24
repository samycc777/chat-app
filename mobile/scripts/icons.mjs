// Makes the app icons and launch screens from the website's icon, so the phone
// apps look the same as the site. Run with `npm run assets` whenever the icon
// in client/public changes, then commit the images it writes into ios/ and android/.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const BACKGROUND = '#313338';
const mobileDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = join(mobileDir, '..', 'client', 'public');
const assetsDir = join(mobileDir, 'assets');

// The SVG gives sharper large images; the PNG is the fallback.
const svg = join(publicDir, 'icon.svg');
const source = existsSync(svg) ? svg : join(publicDir, 'icon-512.png');

async function logo(size) {
  return sharp(source, { density: 600 }).resize(size, size).png().toBuffer();
}

// The home-screen icon is the website icon's symbol on its own colour, filling the whole square,
// because the phone cuts its own rounded shape; the website's rounded square inside it would look
// like a box in a box. The colour is read from the icon, so both stay in step.
const svgText = existsSync(svg) ? readFileSync(svg, 'utf8') : '';
const ICON_COLOUR = /<rect[^>]*fill="(#[0-9a-f]{6})"/i.exec(svgText)?.[1] ?? BACKGROUND;
async function symbol(size) {
  if (!svgText) return logo(size);
  return sharp(Buffer.from(svgText.replace(/<rect[^>]*\/>/, '')), { density: 600 }).resize(size, size).png().toBuffer();
}
async function fullIcon(canvas, symbolSize, file, transparent = false) {
  await sharp({ create: { width: canvas, height: canvas, channels: 4, background: transparent ? { r: 0, g: 0, b: 0, alpha: 0 } : ICON_COLOUR } })
    .composite([{ input: await symbol(symbolSize), gravity: 'center' }])
    .png()
    .toFile(join(assetsDir, file));
}

// A square of the dark background with the website icon centred on it.
async function tile(canvas, logoSize, file, transparent = false) {
  await sharp({
    create: {
      width: canvas,
      height: canvas,
      channels: 4,
      background: transparent ? { r: 0, g: 0, b: 0, alpha: 0 } : BACKGROUND,
    },
  })
    .composite([{ input: await logo(logoSize), gravity: 'center' }])
    .png()
    .toFile(join(assetsDir, file));
}

rmSync(assetsDir, { recursive: true, force: true });
mkdirSync(assetsDir);
await fullIcon(1024, 1024, 'icon-only.png');
// Android adaptive icons: the foreground must fit the middle 66% safe zone.
await fullIcon(1024, 760, 'icon-foreground.png', true);
await sharp({ create: { width: 1024, height: 1024, channels: 3, background: ICON_COLOUR } })
  .png()
  .toFile(join(assetsDir, 'icon-background.png'));
await tile(2732, 600, 'splash.png');
await tile(2732, 600, 'splash-dark.png');

execFileSync('npx', ['capacitor-assets', 'generate', '--ios', '--android'], {
  cwd: mobileDir,
  stdio: 'inherit',
});
rmSync(assetsDir, { recursive: true, force: true });
