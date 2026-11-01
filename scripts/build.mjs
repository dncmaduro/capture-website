import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "dist");
const distIcons = resolve(dist, "icons");
const iconSizes = [16, 32, 48, 128];

await mkdir(dist, { recursive: true });
await cp(resolve(root, "manifest.json"), resolve(dist, "manifest.json"));
await cp(resolve(root, "offscreen.html"), resolve(dist, "offscreen.html"));
await rm(distIcons, { recursive: true, force: true });
await mkdir(distIcons, { recursive: true });

for (const size of iconSizes) {
  await cp(
    resolve(root, "icons", `icon${size}.png`),
    resolve(distIcons, `icon${size}.png`),
  );
}

console.log(`Built unpacked extension at ${dist}`);
