'use strict';
// Format conversion only: preserve the generated icon's composition and alpha.
const { app, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
app.whenReady().then(() => {
  const iconPath = path.join(__dirname, '../ui/assets/peregrine-icon.png');
  const source = nativeImage.createFromPath(iconPath);
  if (source.isEmpty()) throw new Error('Icon PNG cannot be read.');
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const pngs = sizes.map(size => source.resize({ width: size, height: size, quality: 'best' }).toPNG());
  const header = Buffer.alloc(6 + sizes.length * 16);
  header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  for (let i = 0; i < sizes.length; i++) {
    const entry = 6 + i * 16;
    header[entry] = sizes[i] === 256 ? 0 : sizes[i]; header[entry + 1] = header[entry];
    header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(pngs[i].length, entry + 8); header.writeUInt32LE(offset, entry + 12);
    offset += pngs[i].length;
  }
  fs.writeFileSync(path.join(__dirname, '../ui/assets/peregrine.ico'), Buffer.concat([header, ...pngs]));
  console.log('Generated Windows ICO with 16, 24, 32, 48, 64, 128 and 256 pixel entries.');
  app.exit(0);
}).catch(error => { console.error(error.message); app.exit(1); });
