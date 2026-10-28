// Outil de dev : recopie tools/en.js dans index.html (entre les marqueurs EN:BEGIN / EN:END).
// Usage : node tools/i18n-inject.js   (signale les clés du jeu encore sans traduction)
const fs = require('fs'), path = require('path');
const FILE = path.join(__dirname, '..', 'index.html');
const EN = require('./en.js');
let html = fs.readFileSync(FILE, 'utf8');
const body = Object.entries(EN).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`).join('\n');
const block = `const EN = { // EN:BEGIN (généré par tools/i18n-inject.js depuis tools/en.js)\n${body}\n}; // EN:END`;
const re = /const EN = \{[^\n]*(?:EN:BEGIN[\s\S]*?EN:END|\}; \/\/ rempli plus bas \(dictionnaire\))/;
if (!re.test(html)) throw new Error('marqueur EN introuvable');
html = html.replace(re, () => block);
fs.writeFileSync(FILE, html);
const keys = fs.existsSync(path.join(__dirname, 'i18n-keys.json')) ? require('./i18n-keys.json') : [];
const missing = keys.filter(k => !(k in EN) && /[a-zà-ÿ]{3}/i.test(k));
console.log(Object.keys(EN).length, 'traductions ·', missing.length, 'clés sans traduction');
missing.forEach(k => console.log('  -', k.slice(0, 90)));
