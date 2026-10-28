// Outil de dev : entoure de tr(...) les textes français du script de index.html, puis liste les clés à traduire.
// Usage : node tools/i18n-wrap.js [--dry]   (écrit tools/i18n-keys.json)
const fs = require('fs'), path = require('path');
const acorn = require('./node_modules/acorn');
const walk = require('./node_modules/acorn-walk');

const FILE = path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(FILE, 'utf8');
const s0 = html.indexOf('<script>') + 8, s1 = html.lastIndexOf('</script>');
const src = html.slice(s0, s1);
const ast = acorn.parse(src, { ecmaVersion: 'latest', ranges: true });

const FR = /[àâçéèêëîïôûùüÿœ]|\b(le|la|les|un|une|des|du|de|et|est|pas|pour|avec|sur|dans|ton|ta|tes|ses|il|je|tu|moi|toi|plus|bien|tout|fois|chef|quête|pièces?)\b/i;
const looksCode = t => /^[#.\[]|var\(--|=>|^\/|^[a-z]+:[a-z]|\{\s*$|^\s*$|^[\w.-]+$/.test(t) && !/\s/.test(t.trim());
// Textes d'interface sans accent ni petit mot français : listés à la main.
const EXTRA = new Set(['CHAT', 'SLIME', 'ROBOT', 'CHAMPI', 'DINO', 'TOAST', 'JUNIOR', 'PRO', 'CHAMPION', 'CHAPEAU COWBOY', 'TOQUE DE CHEF',
  'FLEUR', 'CORNES DE DIABLOTIN', 'COURONNE', 'LUNETTES DE STAR', 'MOUSTACHE', 'MONOCLE', 'NEZ DE CLOWN', 'CHAMBRE COSY', 'STATION SPATIALE',
  'PAILLOTE PLAGE', 'SOUS-MARIN', 'IGLOO', 'Il fait beau dehors', 'Un bon livre...', "Quelqu'un a des cookies ?", "Je m'ennuie un peu",
  'Encore 5 minutes', 'Personne regarde ?', 'Je boude.', 'Pas envie.', 'Corriger le bug du login', 'Refactor du module paiement',
  'Migrer vers TypeScript', 'Refactor du module auth', 'EN TRAVAIL', 'ATTEND TON OK', 'GLANDE', 'DORT', 'APPLI', 'TERMINAL', 'Salut le boss !',
  'Je peux ?', 'Pardon pardon !', 'Mais euh !', 'Petite pause...', 'Ok, autre approche...', 'LEVEL UP !', 'NOUVELLE FORME !', 'Ah ouais ?!',
  'AAAAH !!', 'Au secours !!', 'Cadeau !', 'BOUM !', 'Merci boss !', 'CLAC !', 'Miam ! Merci !', 'Trop bon !', 'Encore ?!', 'Hihi !', 'BOUDE',
  'MANGE', 'PARLE', 'CARESSER', 'FOUET', 'FRIANDISE', 'GRENADE', 'SERVEUR INJOIGNABLE', 'ENVOI...', 'NOUVEL AGENT', 'CONTINUER', 'RECRUTER',
  'DOSSIER INTROUVABLE', 'ESPACE', 'CLIC MOLETTE', 'SOURIS AVANT', 'VERR. MAJ', 'CTRL DROIT', 'MAJ DROITE', 'Cet ordinateur',
  'Sessions sans dossier', 'IMPORT EN COURS...', 'IMPORT IMPOSSIBLE', 'EN DIRECT', 'RECONNEXION...', 'Ronron...', 'Flemme...', 'Hmpf.',
  'Pardon', 'Style !', 'Trop classe !', 'Je suis beau, hein ?', 'Nouveau moi !', 'Transformation !', "J'adore !", 'OK', 'Bye !']);
const isFrench = t => EXTRA.has(t) || (t.trim().length >= 2 && FR.test(t) && !looksCode(t) && !/^(https?:|data:|#|\.\/)/.test(t));

const edits = [];
const skip = new Set();
// Contextes à ne pas toucher : clés d'objet, comparaisons, regex, appels déjà traduits, cases de switch.
// Déjà traduit (et ses variables) : relevé avant, car fullAncestor visite les enfants d'abord.
walk.simple(ast, { CallExpression(node) { if (node.callee.type === 'Identifier' && node.callee.name === 'tr') node.arguments.forEach(a => skip.add(a)); } });
walk.fullAncestor(ast, (node, state, anc) => {
  const parent = anc[anc.length - 2];
  if (node.type === 'Literal' && typeof node.value === 'string' || node.type === 'TemplateLiteral') {
    if (anc.some(a => skip.has(a) || (a.type === 'VariableDeclarator' && /^(EN|LIM_ERR_EN)$/.test(a.id.name)))) return; // dictionnaires
    if (parent && parent.type === 'Property' && parent.key === node) return;
    if (parent && parent.type === 'BinaryExpression' && /^[!=]==?$/.test(parent.operator)) return;
    if (parent && parent.type === 'SwitchCase') return;
    if (parent && parent.type === 'NewExpression' && parent.callee.name === 'RegExp') return;
    if (parent && parent.type === 'TaggedTemplateExpression') return;
    if (parent && parent.type === 'MemberExpression' && parent.property === node) return;
    if (node.type === 'Literal') {
      if (!isFrench(node.value)) return;
      edits.push({ start: node.start, end: node.end, key: node.value, repl: `tr(${JSON.stringify(node.value)})` });
    } else {
      const text = node.quasis.map(q => q.value.cooked).join('{}');
      if (!isFrench(text)) return;
      if (text.includes('class="cam-head"')) return; // gabarit de carte : traduit après construction (translateDom)
      // Un gabarit qui en contient un autre : on le laisse (à traiter à la main).
      if (src.slice(node.start + 1, node.end - 1).includes('`')) { console.log('à la main :', src.slice(node.start, node.start + 70).replace(/\n/g, ' ')); return; }
      let key = '', vars = [];
      node.quasis.forEach((q, i) => {
        key += q.value.cooked;
        if (i < node.expressions.length) { key += `{${i}}`; vars.push(src.slice(node.expressions[i].start, node.expressions[i].end)); }
      });
      edits.push({ start: node.start, end: node.end, key, repl: vars.length ? `tr(${JSON.stringify(key)}, [${vars.join(', ')}])` : `tr(${JSON.stringify(key)})` });
    }
  }
});
// Applique de la fin vers le début (les positions restent justes) ; ignore les textes imbriqués.
edits.sort((a, b) => b.start - a.start);
let out = src, lastStart = Infinity;
const keys = new Set();
for (const e of edits) {
  if (e.end > lastStart) continue;
  out = out.slice(0, e.start) + e.repl + out.slice(e.end);
  lastStart = e.start; keys.add(e.key);
}
// Clés déjà écrites en tr('...') à la main (hors commentaires)
for (const m of out.replace(/\/\/.*$/gm, '').matchAll(/\btr\(("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g)) {
  try { keys.add(m[1][0] === '"' ? JSON.parse(m[1]) : JSON.parse('"' + m[1].slice(1, -1).replace(/"/g, '\\"').replace(/\\'/g, "'") + '"')); } catch {}
}
console.log(edits.length, 'textes entourés ·', keys.size, 'clés');
fs.writeFileSync(path.join(__dirname, 'i18n-keys.json'), JSON.stringify([...keys].sort(), null, 1));
if (!process.argv.includes('--dry')) fs.writeFileSync(FILE, html.slice(0, s0) + out + html.slice(s1));
