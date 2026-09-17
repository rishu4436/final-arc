import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const svg = await readFile(join(root, "public", "logo.svg"));

await mkdir(join(root, "public"), { recursive: true });

await sharp(svg, { density: 384 })
  .resize(1024, 1024)
  .png()
  .toFile(join(root, "public", "logo.png"));

await sharp(svg, { density: 192 })
  .resize(192, 192)
  .png()
  .toFile(join(root, "public", "icon-192.png"));

await sharp(svg, { density: 64 })
  .resize(32, 32)
  .png()
  .toFile(join(root, "public", "favicon-32.png"));

console.log("wrote public/logo.png, public/icon-192.png, public/favicon-32.png");
