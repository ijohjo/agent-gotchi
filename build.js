// Agent·Gotchi — fabrique AgentGotchi.exe (Node SEA : node.exe + server.js + index.html + hook.js).
// Usage : node build.js [dossier de sortie]
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const { execFileSync } = require('child_process');

const ROOT = __dirname, BUILD = path.join(ROOT, 'build');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'dist'));
const EXE = path.join(OUT, 'AgentGotchi.exe');
fs.mkdirSync(BUILD, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' });
// Outils de build (rcedit : icône/infos de l'exe, postject : injection du blob), installés dans build/.
const MODS = path.join(BUILD, 'node_modules');
if (!fs.existsSync(path.join(MODS, 'postject')) || !fs.existsSync(path.join(MODS, 'rcedit'))) {
  execFileSync('npm', ['install', '--prefix', BUILD, '--no-save', '--no-audit', '--no-fund', 'rcedit@4.0.1', 'postject@1.0.0-alpha.6'], { stdio: 'inherit', shell: true });
}

// ---------- icône : le petit perso orange, en PNG dans un .ico ----------
const BODY = [
  '..oo........oo..', '.opbo......obpo.', '.obbboooooobbbo.', 'obbbbbbbbbbbbbbo', 'obllbbbbbbbbbbbo',
  'oblbbbbbbbbbbbbo', 'obbbbbbbbbbbbbbo', 'obbbbbbbbbbbbbbo', 'obbbbbbbbbbbbbbo', 'obbbbbbbbbbbbbbo',
  'obbbbbbbbbbbbbbo', 'obbbbbbbbbbbbbbo', 'odbbbbbbbbbbbbdo', '.oddbbbbbbbbddo.', '..oooooooooooo..', '................',
];
const COL = { o: [26, 20, 35], b: [232, 131, 90], l: [241, 177, 150], d: [162, 92, 63], p: [255, 158, 184], k: [26, 20, 35], w: [255, 255, 255], c: [255, 143, 163] };
const face = BODY.map(r => [...r]);
[[4, 6], [5, 6], [4, 7], [5, 7], [4, 8], [5, 8]].forEach(([x, y]) => { face[y][x] = 'k'; face[y][15 - x] = 'k'; });
face[6][4] = 'w'; face[6][10] = 'w';
[[2, 9], [3, 9]].forEach(([x, y]) => { face[y][x] = 'c'; face[y][15 - x] = 'c'; });
[[6, 10], [9, 10], [7, 11], [8, 11]].forEach(([x, y]) => { face[y][x] = 'k'; });

const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = b => { let c = -1; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size) {
  const s = size / 16, raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const k = face[Math.floor(y / s)][Math.floor(x / s)], i = y * (size * 4 + 1) + 1 + x * 4;
    if (k !== '.') { raw.set(COL[k], i); raw[i + 3] = 255; }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function ico(sizes) {
  const imgs = sizes.map(png), head = Buffer.alloc(6 + 16 * sizes.length);
  head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
  let off = head.length;
  sizes.forEach((sz, i) => {
    const e = 6 + i * 16;
    head[e] = sz % 256; head[e + 1] = sz % 256; head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(imgs[i].length, e + 8); head.writeUInt32LE(off, e + 12); off += imgs[i].length;
  });
  return Buffer.concat([head, ...imgs]);
}
const ICON = path.join(BUILD, 'icon.ico');
fs.writeFileSync(ICON, ico([16, 32, 48, 64, 128, 256]));
// Même perso en PNG pour la fenêtre du jeu (onglet et barre des tâches) ; servi par server.js.
const ICON_PNG = path.join(BUILD, 'icon.png');
fs.writeFileSync(ICON_PNG, png(256));
console.log('icône OK');

// ---------- blob SEA ----------
// Chemins relatifs, lancés depuis le dossier du projet : le nom du script gardé dans l'exe
// (pour les traces d'erreur) ne contient alors pas le chemin de ta machine.
const BLOB = path.join(BUILD, 'sea-prep.blob');
fs.writeFileSync(path.join(BUILD, 'sea-config.json'), JSON.stringify({
  main: 'server.js',
  output: 'build/sea-prep.blob',
  disableExperimentalSEAWarning: true,
  assets: { 'index.html': 'index.html', 'hook.js': 'hook.js', 'icon.png': 'build/icon.png' },
}, null, 2));
execFileSync(process.execPath, ['--experimental-sea-config', path.join('build', 'sea-config.json')], { stdio: 'inherit', cwd: ROOT });

// ---------- exe : copie de node.exe + icône + blob ----------
fs.copyFileSync(process.execPath, EXE);
run(path.join(MODS, 'rcedit', 'bin', 'rcedit-x64.exe'), [EXE, '--set-icon', ICON,
  '--set-version-string', 'ProductName', 'Agent Gotchi',
  '--set-version-string', 'FileDescription', 'Agent Gotchi',
  '--set-version-string', 'CompanyName', 'Agent Gotchi',
  '--set-version-string', 'OriginalFilename', 'AgentGotchi.exe',
  '--set-version-string', 'InternalName', 'AgentGotchi',
  '--set-file-version', '1.0.0', '--set-product-version', '1.0.0']);
run(process.execPath, [path.join(MODS, 'postject', 'dist', 'cli.js'), EXE, 'NODE_SEA_BLOB', BLOB,
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2', '--overwrite']);

// Sous-système GUI : pas de fenêtre console noire au lancement.
const buf = fs.readFileSync(EXE), pe = buf.readUInt32LE(0x3c);
buf.writeUInt16LE(2, pe + 24 + 68);
fs.writeFileSync(EXE, buf);
console.log('OK ->', EXE, (buf.length / 1e6).toFixed(0) + ' Mo');
