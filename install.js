// Agent·Gotchi — installe (ou retire) les hooks dans ~/.claude/settings.json.
// Usage : node install.js            installe / met à jour
//         node install.js --uninstall retire tout ce qu'Agent·Gotchi a ajouté
// Une copie de sauvegarde de settings.json est faite à chaque fois (settings.json.gotchi-backup-<date>).
const fs = require('fs'), path = require('path'), os = require('os');

const CLAUDE = path.join(os.homedir(), '.claude');
const SETTINGS = path.join(CLAUDE, 'settings.json');
const HOOK_DIR = path.join(CLAUDE, 'hooks', 'agent-gotchi');
const HOOK = path.join(HOOK_DIR, 'hook.js');
const node = process.execPath;
const cmd = extra => `"${node}" "${HOOK}"${extra ? ' ' + extra : ''}`;
const isOurs = h => h && typeof h.command === 'string' && h.command.includes(path.join('agent-gotchi', 'hook.js'));

// Événements suivis par le jeu. Stop a deux hooks : la fenêtre « fouet » (courte) et l'écoute en fond
// qui réveille la session quand tu lui écris depuis le jeu (asyncRewake).
const WANT = {
  SessionStart: { hooks: [{ command: cmd(), timeout: 5 }] },
  UserPromptSubmit: { hooks: [{ command: cmd(), timeout: 5 }] },
  PreToolUse: { matcher: '*', hooks: [{ command: cmd(), timeout: 600 }] },
  PostToolUse: { matcher: '*', hooks: [{ command: cmd(), timeout: 5 }] },
  Notification: { hooks: [{ command: cmd(), timeout: 5 }] },
  Stop: { hooks: [{ command: cmd(), timeout: 180 }, { command: cmd('--listen'), timeout: 43200, asyncRewake: true }] },
  SessionEnd: { hooks: [{ command: cmd(), timeout: 5 }] },
};

const uninstall = process.argv.includes('--uninstall');
let settings = {};
if (fs.existsSync(SETTINGS)) {
  const raw = fs.readFileSync(SETTINGS, 'utf8');
  try { settings = JSON.parse(raw); } catch (e) { console.error('settings.json illisible, rien n\'est modifié :', e.message); process.exit(1); }
  const backup = `${SETTINGS}.gotchi-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.writeFileSync(backup, raw);
  console.log('Sauvegarde :', backup);
}
settings.hooks ||= {};
// On retire d'abord nos anciennes entrées (mise à jour propre), sans toucher aux autres hooks.
for (const [ev, groups] of Object.entries(settings.hooks)) {
  if (!Array.isArray(groups)) continue;
  settings.hooks[ev] = groups.map(g => ({ ...g, hooks: (g.hooks || []).filter(h => !isOurs(h)) })).filter(g => g.hooks.length);
  if (!settings.hooks[ev].length) delete settings.hooks[ev];
}
if (!uninstall) {
  fs.mkdirSync(HOOK_DIR, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'hook.js'), HOOK);
  for (const [ev, g] of Object.entries(WANT)) {
    (settings.hooks[ev] ||= []).push({ ...(g.matcher ? { matcher: g.matcher } : {}), hooks: g.hooks.map(h => ({ type: 'command', ...h })) });
  }
}
if (!Object.keys(settings.hooks).length) delete settings.hooks;
fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2));
console.log(uninstall ? 'Hooks Agent·Gotchi retirés.' : `Hooks Agent·Gotchi installés (${Object.keys(WANT).length} événements). Relance tes sessions Claude pour qu'elles les prennent.`);
