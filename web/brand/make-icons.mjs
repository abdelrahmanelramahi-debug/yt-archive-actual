// Renders brand/icon.svg into the site's favicon and app icons. Run from web/:  node brand/make-icons.mjs
// - src/app/icon.png        512, rounded corners (browsers, Android home screen, Claude's connector list)
// - src/app/apple-icon.png  180, square edge to edge (iPhone rounds the corners itself)
// - src/app/favicon.ico     16 / 32 / 48; the gold line is drawn at least 1 px wide, and 16 px drops it
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const master = readFileSync(new URL("./icon.svg", import.meta.url), "utf8");
const app = (f) => fileURLToPath(new URL(`../src/app/${f}`, import.meta.url));

function variant(size, { square = false } = {}) {
  let svg = master;
  if (square) svg = svg.replace('rx="130"', 'rx="0"');
  if (size <= 16) svg = svg.replace(/<path id="gold"[^>]*\/>/, "");
  else svg = svg.replace('stroke-width="10"', `stroke-width="${Math.max(10, 600 / size).toFixed(2)}"`);
  return sharp(Buffer.from(svg), { density: (72 * size) / 600 }).resize(size, size);
}

await variant(512).png().toFile(app("icon.png"));
await variant(180, { square: true }).flatten({ background: "#0f6b57" }).png().toFile(app("apple-icon.png"));

// .ico with PNG entries (every current browser reads these)
const sizes = [16, 32, 48];
const pngs = await Promise.all(sizes.map((s) => variant(s).png().toBuffer()));
const head = Buffer.alloc(6 + 16 * sizes.length);
head.writeUInt16LE(0, 0);
head.writeUInt16LE(1, 2);
head.writeUInt16LE(sizes.length, 4);
let offset = head.length;
sizes.forEach((s, i) => {
  const e = 6 + 16 * i;
  head.writeUInt8(s, e);
  head.writeUInt8(s, e + 1);
  head.writeUInt16LE(1, e + 4); // colour planes
  head.writeUInt16LE(32, e + 6); // bits per pixel
  head.writeUInt32LE(pngs[i].length, e + 8);
  head.writeUInt32LE(offset, e + 12);
  offset += pngs[i].length;
});
writeFileSync(app("favicon.ico"), Buffer.concat([head, ...pngs]));
console.log("icons written");
