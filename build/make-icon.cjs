'use strict';
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
(async () => {
  const out = path.join(__dirname, 'launcher', 'winres');
  const source = path.join(__dirname, 'assets', 'launcher.png');
  // Preserve the supplied art and transparency; only square padding and resizing.
  const square = await sharp(source).resize(512, 512, { fit: 'contain', background: '#00000000' }).png().toBuffer();
  fs.writeFileSync(path.join(out, 'icon512.png'), square);
  const sizes = [16, 24, 32, 48, 64, 128, 256], images = [];
  for (const size of sizes) images.push(await sharp(square).resize(size, size).png().toBuffer());
  const header = Buffer.alloc(6 + 16 * images.length); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach((image, i) => {
    const entry = 6 + 16 * i; header[entry] = header[entry + 1] = sizes[i] === 256 ? 0 : sizes[i];
    header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(image.length, entry + 8); header.writeUInt32LE(offset, entry + 12); offset += image.length;
  });
  fs.writeFileSync(path.join(out, 'icon.ico'), Buffer.concat([header, ...images]));
})().catch(error => { console.error(error); process.exitCode = 1; });
