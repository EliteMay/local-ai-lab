import sharp from "sharp";
import pngToIco from "png-to-ico";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");
const source = join(projectRoot, "desktop", "assets", "icon.svg");
const outputDir = join(projectRoot, "desktop", "assets", "generated");
const sizes = [16, 24, 32, 48, 64, 128, 256, 512];

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });

const pngPaths = [];
for (const size of sizes) {
  const target = join(outputDir, `icon-${size}.png`);
  await sharp(source, { density: 384 })
    .resize(size, size, { fit: "fill" })
    .png({ compressionLevel: 9 })
    .toFile(target);
  pngPaths.push({ size, target });
}

await sharp(source, { density: 384 })
  .resize(512, 512, { fit: "fill" })
  .png({ compressionLevel: 9 })
  .toFile(join(outputDir, "icon.png"));

const icoInputs = pngPaths
  .filter(({ size }) => size <= 256)
  .map(({ target }) => target);

const ico = await pngToIco(icoInputs);
await writeFile(join(outputDir, "icon.ico"), ico);

console.log(`Generated app icon: ${sizes.join(", ")} px + icon.ico`);
