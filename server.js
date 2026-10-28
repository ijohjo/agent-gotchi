// Agent·Gotchi — serveur local.
// Reçoit les hooks Claude Code (via hook.js), pousse l'état des sessions au jeu (SSE),
// et relaie fouet / friandise / quête vers les sessions.
const http = require('http'), https = require('https'), fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto'), zlib = require('zlib');
const { spawn, execFileSync } = require('child_process');

// Compilé en .exe (Node SEA) : les fichiers sont embarqués et on ouvre la fenêtre du jeu.
let sea = null;
try { sea = require('node:sea'); if (!sea.isSea()) sea = null; } catch { sea = null; }
const asset = n => sea ? sea.getAsset(n, 'utf8') : fs.readFileSync(path.join(__dirname, n), 'utf8');
const APP = !!sea || (process.env.GOTCHI_APP || '').trim() === '1' || process.argv.includes('--app');
// Mise à jour : l'ancien exe renommé pendant qu'il tournait est supprimé au lancement suivant.
if (sea) try { fs.unlinkSync(path.join(path.dirname(process.execPath), 'AgentGotchi.old.exe')); } catch {}

const PORT = +process.env.GOTCHI_PORT || 5178;
// Durée pendant laquelle le hook Stop attend un coup de fouet (seulement si le jeu est ouvert).
const GRACE_MS = (process.env.GOTCHI_GRACE ? +process.env.GOTCHI_GRACE : 20) * 1000;
const HOOK_DIR = process.env.GOTCHI_HOOK_DIR || path.join(os.homedir(), '.claude', 'hooks', 'agent-gotchi');
const TOKEN = crypto.randomBytes(16).toString('hex');
fs.mkdirSync(HOOK_DIR, { recursive: true });
// Le hook installé suit la version du jeu (il est réécrit s'il a changé).
try { const f = path.join(HOOK_DIR, 'hook.js'), h = asset('hook.js'); if (!fs.existsSync(f) || fs.readFileSync(f, 'utf8') !== h) fs.writeFileSync(f, h); } catch {}

// Messages envoyés à Claude, dans la langue choisie dans le jeu (store.lang, envoyé par la page).
const MSGS = {
  fr: {
    whipStop: "[Agent·Gotchi] Ton utilisateur t'a donné un coup de fouet : il estime que tu t'es arrêté trop tôt. Reprends la tâche en cours et termine-la. Si elle est vraiment finie, vérifie ton travail (tests, relecture) puis résume en une ou deux phrases ce qui a été fait.",
    whipWork: "[Agent·Gotchi] Ton utilisateur te donne un coup de fouet : reste concentré sur la tâche, va à l'essentiel, évite les détours.",
    whipIdle: "[Agent·Gotchi] Ton utilisateur t'a donné un coup de fouet pendant ta pause : sois efficace et va au bout de cette demande.",
    treat: t => `[Agent·Gotchi] Ton utilisateur t'a donné une friandise : il est content de ton travail${t ? ` sur « ${t} »` : ''}. Continue comme ça.`,
    quest: t => `[Agent·Gotchi] Nouvelle quête de ton utilisateur : ${t}`,
    say: t => `[Agent·Gotchi] Message de ton utilisateur : ${t}`,
    oral: "Tu es piloté depuis Agent·Gotchi, qui peut lire tes réponses à voix haute. Commence chaque réponse finale par une phrase de synthèse simple et naturelle à l'oral (sans code, chemin ni markdown), puis donne les détails.",
    resume: (title, n, cut, hist) => `[Reprise claude.ai] « ${title} » · ${n} messages\nVoici l'historique d'une conversation que j'ai eue avec Claude sur claude.ai. Reprends-la là où elle s'est arrêtée : résume en deux phrases où on en était, puis attends ma prochaine demande.\n\n=== HISTORIQUE ===\n${cut ? `(début coupé : ${cut} messages plus anciens non inclus)\n` : ''}${hist}`,
    me: 'Moi',
    split: (goal, n) => `Découpe cet objectif de développement en exactement ${n} parties que ${n} développeurs peuvent faire en parallèle dans le même projet, en évitant qu'ils modifient les mêmes fichiers. Réponds UNIQUEMENT par un tableau JSON de ${n} chaînes (une phrase précise chacune), sans rien d'autre.\nObjectif : ${goal}`,
    team: (goal, part, others) => `[Mission d'équipe Agent·Gotchi] Tu fais partie d'une équipe de ${others.length + 1} agents qui travaillent EN MÊME TEMPS dans ce dossier.\nObjectif global : ${goal}\nTA PARTIE (fais seulement celle-ci) : ${part}\nLes autres agents s'occupent de :\n${others.map(o => '- ' + o).join('\n')}\nNe modifie pas les fichiers qui relèvent de leurs parties ; si tu en as besoin, dis-le dans ton résumé. Quand ta partie est finie et vérifiée, termine par un résumé court de ce que tu as fait.`,
  },
  en: {
    whipStop: '[Agent·Gotchi] Your user just cracked the whip: they think you stopped too early. Resume the current task and finish it. If it really is done, check your work (tests, review), then sum up what was done in one or two sentences.',
    whipWork: '[Agent·Gotchi] Your user cracks the whip: stay focused on the task, get to the point, no detours.',
    whipIdle: '[Agent·Gotchi] Your user cracked the whip during your break: be efficient and see this request through.',
    treat: t => `[Agent·Gotchi] Your user gave you a treat: they are happy with your work${t ? ` on "${t}"` : ''}. Keep it up.`,
    quest: t => `[Agent·Gotchi] New quest from your user: ${t}`,
    say: t => `[Agent·Gotchi] Message from your user: ${t}`,
    oral: 'You are driven from Agent·Gotchi, which can read your replies out loud. Start every final reply with one simple, natural spoken summary sentence (no code, paths or markdown), then give the details.',
    resume: (title, n, cut, hist) => `[Reprise claude.ai] "${title}" · ${n} messages\nHere is the history of a conversation I had with Claude on claude.ai. Pick it up where it left off: sum up in two sentences where we were, then wait for my next request.\n\n=== HISTORY ===\n${cut ? `(beginning cut: ${cut} older messages not included)\n` : ''}${hist}`,
    me: 'Me',
    split: (goal, n) => `Split this development goal into exactly ${n} parts that ${n} developers can do in parallel in the same project, avoiding edits to the same files. Reply ONLY with a JSON array of ${n} strings (one precise sentence each), nothing else.\nGoal: ${goal}`,
    team: (goal, part, others) => `[Agent·Gotchi team mission] You are part of a team of ${others.length + 1} agents working AT THE SAME TIME in this folder.\nOverall goal: ${goal}\nYOUR PART (only this one): ${part}\nThe other agents handle:\n${others.map(o => '- ' + o).join('\n')}\nDo not edit files that belong to their parts; if you need to, say so in your summary. When your part is done and checked, end with a short summary of what you did.`,
  },
};
const MSG = new Proxy({}, { get: (_, k) => (MSGS[store.lang] || MSGS.fr)[k] });

const sessions = new Map(), clients = new Set();

// Sauvegarde disque : messages envoyés depuis l'appli + file d'attente pas encore livrée.
const STORE_FILE = path.join(HOOK_DIR, 'chat-log.json');
let store = { log: {}, pending: {}, owned: {}, cwds: [], names: {}, queue: {}, schedules: [], missions: [], hold: null, rules: [], rulesTerminal: false, settings: { autoPause: true, pauseAt: 95 } };
try { store = { ...store, ...JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')) }; } catch {}
function saveStore() {
  const sids = Object.keys(store.log);
  if (sids.length > 60) sids.slice(0, sids.length - 60).forEach(k => delete store.log[k]);
  try { fs.writeFileSync(STORE_FILE, JSON.stringify(store)); } catch {}
}
function logSent(s, text, status) {
  const l = store.log[s.sid] ||= [];
  l.push({ text, ts: Date.now(), status });
  if (l.length > 200) l.shift();
  saveStore();
}
const oneLine = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const send = (res, o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
const broadcast = o => clients.forEach(c => send(c, o));

function nameFor(cwd) {
  const base = path.basename(cwd || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 10) || 'AGENT';
  const taken = new Set([...sessions.values()].map(s => s.name));
  let n = base, i = 2;
  while (taken.has(n)) n = `${base.slice(0, 8)}-${i++}`;
  return n;
}
function getSession(sid, cwd, name) {
  let s = sessions.get(sid);
  if (!s) {
    const own = store.owned[sid];
    s = {
      sid, cwd: own?.cwd || cwd, name: own?.name || store.names?.[sid] || name || nameFor(cwd), state: 'idle', task: null, tool: null, actions: 0, perm: null,
      pending: store.pending[sid] || [], stopWait: null, permWait: null, graceEnd: 0, last: Date.now(), owned: !!own,
      transcript: own?.transcript,
    };
    store.pending[sid] = s.pending;
    // Le nom reste celui de la première rencontre, même si la session change de dossier ensuite.
    if (!own && (store.names ||= {})[sid] !== s.name) {
      store.names[sid] = s.name;
      const k = Object.keys(store.names); if (k.length > 400) k.slice(0, k.length - 400).forEach(x => delete store.names[x]);
      saveStore();
    }
    sessions.set(sid, s);
  }
  return s;
}
const pub = s => ({
  sid: s.sid, name: s.name, cwd: s.cwd, state: s.state, task: s.task, tool: s.tool, actions: s.actions, perm: s.perm,
  graceMs: s.graceEnd ? Math.max(0, s.graceEnd - Date.now()) : 0, owned: s.owned, usage: s.usage, listening: !!s.listen,
  model: store.owned[s.sid]?.model || null, queue: store.queue[s.sid] || [], ...titleOf(s),
  edit: s.edit || null, editTot: s.editTot ? { files: s.editTot.files.size, add: s.editTot.add, del: s.editTot.del } : null,
});
// Titre de la conversation (celui de la barre latérale de Claude, sinon le titre du transcript)
// et d'où elle vient : appli Gotchi, app de bureau Claude ou terminal. Relu au plus toutes les 15 s.
const titleCache = new Map();
function titleOf(s) {
  const hit = titleCache.get(s.sid);
  if (hit && Date.now() - hit.at < 15e3) return hit.v;
  let title = '', src = s.owned ? 'app' : 'cli';
  try {
    const d = desktopSessions().find(x => x.sid === s.sid);
    if (d) { title = d.title || ''; if (!s.owned) src = 'desktop'; }
    if (!title && s.transcript && fs.existsSync(s.transcript)) title = convInfo(s.transcript).title;
  } catch {}
  const v = { title: oneLine(title, 90), src };
  titleCache.set(s.sid, { at: Date.now(), v });
  return v;
}

// ---------- tokens consommés et coût (équivalent tarif API, en $ par million de tokens) ----------
// [entrée, sortie, lecture de cache] ; écriture de cache = 1,25 × entrée.
const PRICES = {
  'claude-fable-5-1': [10, 50, 0.25], 'claude-fable-5': [10, 50, 1], 'claude-mythos-5-1': [10, 50, 0.25],
  'claude-opus-5-5': [4, 20, 0.2], 'claude-opus-5': [5, 25, 0.5], 'claude-opus-4-8': [5, 25, 0.5],
  'claude-opus-4-7': [5, 25, 0.5], 'claude-opus-4-6': [5, 25, 0.5],
  'claude-sonnet-5-5': [2, 10, 0.2], 'claude-sonnet-5': [2, 10, 0.2], 'claude-sonnet-4-6': [3, 15, 0.3],
  'claude-haiku-5-5': [0.1, 0.5, 0.01], 'claude-haiku-4-5': [1, 5, 0.1],
};
const PRICE_KEYS = Object.keys(PRICES).sort((a, b) => b.length - a.length);
function costOf(model = '', u) {
  const k = PRICE_KEYS.find(k => model.startsWith(k));
  if (!k) return 0;
  const [i, o, cr] = PRICES[k];
  return ((u.input_tokens || 0) * i + (u.output_tokens || 0) * o
    + (u.cache_creation_input_tokens || 0) * i * 1.25 + (u.cache_read_input_tokens || 0) * cr) / 1e6;
}
// Lit seulement la fin nouvelle du transcript ; une réponse = un message.id (les blocs répètent l'usage).
function updateUsage(s) {
  const f = s.transcript;
  if (!f) return false;
  let size;
  try { size = fs.statSync(f).size; } catch { return false; }
  if (s.uFile !== f || size < (s.uOff || 0)) { s.uFile = f; s.uOff = 0; s.uMsgs = new Map(); }
  if (size === s.uOff) return false;
  const buf = Buffer.alloc(size - s.uOff), fd = fs.openSync(f, 'r');
  fs.readSync(fd, buf, 0, buf.length, s.uOff); fs.closeSync(fd);
  const nl = buf.lastIndexOf(10);
  if (nl < 0) return false;
  s.uOff += nl + 1;
  for (const l of buf.subarray(0, nl).toString('utf8').split('\n')) {
    if (!l.includes('"usage"')) continue;
    let e;
    try { e = JSON.parse(l); } catch { continue; }
    const m = e.message;
    if (e.type === 'assistant' && m && m.usage) s.uMsgs.set(m.id || e.uuid, { model: m.model, u: m.usage });
  }
  const t = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 };
  for (const { model, u } of s.uMsgs.values()) {
    t.input += u.input_tokens || 0; t.output += u.output_tokens || 0;
    t.cacheWrite += u.cache_creation_input_tokens || 0; t.cacheRead += u.cache_read_input_tokens || 0;
    t.cost += costOf(model, u);
  }
  const changed = !s.usage || s.usage.cost !== t.cost || s.usage.output !== t.output;
  s.usage = t;
  return changed;
}
// En direct : le transcript grossit pendant que l'agent répond.
setInterval(() => {
  if (!clients.size) return;
  for (const s of sessions.values()) if (updateUsage(s)) broadcast({ hook: 'Usage', sid: s.sid, usage: s.usage });
}, 3000);

// ---------- limites d'utilisation (session 5 h / semaine), comme /usage dans Claude Code ----------
// La dernière mesure réussie est gardée (et affichée comme « ancienne ») quand une lecture échoue.
let limits = null, limitsBackoff = 0;
function pollLimits(force) {
  if (!clients.size || (!force && Date.now() < limitsBackoff)) return;
  const last = store.limitsLast || null;
  const done = l => {
    if (l.items && l.items.length) { store.limitsLast = { at: Date.now(), items: l.items }; saveStore(); limits = { at: Date.now(), items: l.items }; }
    else limits = { at: Date.now(), items: last ? last.items : [], staleAt: last ? last.at : null, error: l.error, code: l.code };
    // Presque au plafond : la file de quêtes se met en pause (et repart quand ça redescend).
    if (l.items && l.items.length) {
      const max = Math.max(...l.items.map(i => i.pct || 0)), st = store.settings || {};
      if (st.autoPause && max >= (st.pauseAt || 95) && !store.hold) { store.hold = 'limits'; saveStore(); broadcast({ hook: 'Hold', hold: store.hold, max }); }
      else if (store.hold === 'limits' && (!st.autoPause || max < (st.pauseAt || 95))) { store.hold = null; saveStore(); broadcast({ hook: 'Hold', hold: null, max }); releaseQueues(); }
    }
    broadcast({ hook: 'Limits', limits });
  };
  let cred;
  try { cred = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf8')).claudeAiOauth; }
  catch { return done({ error: "la CLI claude n'est pas connectée (claude auth login)", code: 'nocli' }); }
  if (cred.expiresAt && cred.expiresAt < Date.now()) return done({ error: "connexion de la CLI expirée : elle se renouvelle à la prochaine requête d'un agent, ou avec le bouton RENOUVELER", code: 'expired' });
  https.get('https://api.anthropic.com/api/oauth/usage', {
    headers: { Authorization: `Bearer ${cred.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20' }, timeout: 10000,
  }, res => {
    let b = '';
    res.on('data', d => b += d);
    res.on('end', () => {
      if (res.statusCode === 401) return done({ error: 'connexion de la CLI expirée : bouton RENOUVELER', code: 'expired' });
      if (res.statusCode === 429) { limitsBackoff = Date.now() + 5 * 60e3; return done({ error: 'Claude limite ces lectures pour le moment : nouvel essai dans 5 min', code: 'rate' }); }
      try {
        const j = JSON.parse(b);
        const item = (k, label) => j[k] && { label, pct: j[k].utilization, resets: j[k].resets_at };
        const items = [item('five_hour', 'SESSION 5 H'), item('seven_day', 'SEMAINE'), item('seven_day_opus', 'SEMAINE OPUS'), item('seven_day_sonnet', 'SEMAINE SONNET')].filter(Boolean);
        done(items.length ? { items } : { error: `réponse inattendue de Claude (HTTP ${res.statusCode})`, code: 'odd' });
      } catch { done({ error: `réponse inattendue de Claude (HTTP ${res.statusCode})`, code: 'odd' }); }
    });
  }).on('error', e => done({ error: `pas de connexion à Claude (${e.message})`, code: 'net' }))
    .on('timeout', function () { this.destroy(new Error('délai dépassé')); });
}
// Renouvelle le jeton de la CLI : une micro-requête Haiku, sans conversation sauvegardée ni hooks du jeu.
let refreshing = false;
function refreshAuth() {
  if (refreshing) return { ok: false, error: 'déjà en cours' };
  refreshing = true;
  const env = { ...agentEnv(), GOTCHI_PORT: '1' };
  const p = spawn(CLAUDE, ['-p', 'Réponds juste : ok', '--model', 'haiku', '--no-session-persistence'], { cwd: os.tmpdir(), env, windowsHide: true, stdio: 'ignore' });
  const end = () => { refreshing = false; limitsBackoff = 0; setTimeout(() => pollLimits(true), 500); };
  p.on('exit', end); p.on('error', end);
  setTimeout(() => { if (refreshing) { try { p.kill(); } catch {} } }, 60e3);
  return { ok: true };
}
setInterval(pollLimits, 60e3);

// ---------- agents de l'appli : des sessions claude pilotées par le jeu (stream-json) ----------
// Les requêtes partent comme de vrais messages utilisateur : elles sont sauvegardées dans Claude
// comme n'importe quelle conversation (reprenable avec `claude --resume <id>`).
const CLAUDE = (() => {
  try { return execFileSync('where', ['claude'], { encoding: 'utf8' }).split(/\r?\n/).find(l => /\.exe$/i.test(l.trim())).trim(); }
  catch { return path.join(os.homedir(), '.local', 'bin', 'claude.exe'); }
})();
// Outils en lecture seule : pas besoin de demander la permission.
const SAFE_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'TodoWrite', 'WebSearch', 'Task', 'NotebookRead', 'BashOutput', 'ExitPlanMode']);
const MODELS = ['opus', 'sonnet', 'haiku'];
// Les réponses peuvent être lues à voix haute par le jeu : on demande une première phrase qui se dit bien.

const procs = new Map();

// Lancé depuis une session Claude (app de bureau, terminal claude…), on hérite de ses variables
// d'auth/routage : elles détournent la connexion de la CLI. On les retire pour les agents.
function agentEnv() {
  const env = { ...process.env };
  if (env.CLAUDECODE) {
    for (const k of Object.keys(env)) {
      if (/^CLAUDE/.test(k) || k === 'ANTHROPIC_BASE_URL' || /^USE_(LOCAL|STAGING)_OAUTH$/.test(k)) delete env[k];
    }
  }
  return env;
}
function startProc(s) {
  const own = store.owned[s.sid];
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    own.started ? '--resume' : '--session-id', s.sid, '--append-system-prompt', MSG.oral,
    ...(own.model ? ['--model', own.model] : [])];
  const child = spawn(CLAUDE, args, { cwd: own.cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: agentEnv() });
  own.started = true; saveStore();
  let buf = '', err = '';
  child.stdout.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { onProcLine(s, buf.slice(0, i)); buf = buf.slice(i + 1); }
  });
  child.stderr.on('data', d => { err = (err + d).slice(-2000); });
  child.on('error', e => broadcast({ hook: 'AgentError', sid: s.sid, message: `Impossible de lancer claude : ${e.message}` }));
  child.on('exit', code => {
    if (procs.get(s.sid) === child) procs.delete(s.sid);
    if (code && err.trim()) broadcast({ hook: 'AgentError', sid: s.sid, message: oneLine(err, 200) });
    if (s.state !== 'idle') { s.state = 'idle'; s.tool = null; broadcast({ hook: 'Stop', ...pub(s) }); }
  });
  procs.set(s.sid, child);
  return child;
}
function onProcLine(s, line) {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.type === 'assistant' || m.type === 'user') broadcast({ hook: 'Chat', sid: s.sid });
  if (m.type === 'result') {
    missionTurnDone(s, !m.is_error);
    broadcast({ hook: 'Chat', sid: s.sid });
    if (m.is_error) broadcast({ hook: 'AgentError', sid: s.sid, message: oneLine(m.result || m.subtype, 200) });
    // Fin de tour sans hook Stop (erreur avant le tour, interruption...) : on remet l'agent au repos.
    if (s.state !== 'idle') { s.state = 'idle'; s.tool = null; s.perm = null; broadcast({ hook: 'Stop', ...pub(s) }); }
    // La requête vient de consommer (et a pu renouveler la connexion) : limites à jour tout de suite.
    if (!limits || Date.now() - (limits.at || 0) > 15e3) pollLimits();
    // Changement de modèle demandé pendant le tour : le process repart avec le nouveau à la prochaine requête.
    const own = store.owned[s.sid];
    if (own?.restart) { own.restart = false; procs.get(s.sid)?.kill(); }
    setTimeout(() => dispatchOwned(s), 1500); // quête suivante de la file (après la lecture du Stop)
  }
}
function sendPrompt(s, text) {
  const child = procs.get(s.sid) || startProc(s);
  if (s.state === 'idle' || s.state === 'sleeping') { s.state = 'thinking'; broadcast({ hook: 'Thinking', ...pub(s) }); }
  child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n');
}
function answerPerm(s, allow, always) {
  if (!s.permWait) return;
  clearTimeout(s.permWait.timer);
  const { resolve, tool } = s.permWait;
  s.permWait = null; s.perm = null; s.state = 'working';
  if (allow && always) { const own = store.owned[s.sid]; (own.allow ||= []).includes(tool) || own.allow.push(tool); saveStore(); }
  resolve({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: allow ? 'allow' : 'deny',
      permissionDecisionReason: allow ? 'Autorisé depuis Agent·Gotchi' : "Refusé par ton utilisateur depuis Agent·Gotchi. Demande-lui comment continuer si besoin.",
    },
  });
  broadcast({ hook: 'PermAnswered', ...pub(s) });
}
process.on('exit', () => procs.forEach(p => { try { p.kill(); } catch {} }));
// Les agents de l'appli réapparaissent au lancement (endormis jusqu'à la prochaine requête).
for (const [sid, o] of Object.entries(store.owned)) getSession(sid, o.cwd, o.name);
function toolLabel(name = '', input = {}) {
  const short = name.startsWith('mcp__') ? name.split('__').pop() : name;
  const arg = input.file_path ? path.basename(input.file_path)
    : input.command || input.pattern || input.url || input.query || input.description || '';
  return oneLine(`${short} ${arg}`, 60);
}
// ---------- réveil d'une session au repos (hook Stop « asyncRewake », voir hook.js --listen) ----------
// Après chaque tour, un petit hook reste en fond et attend ici. Lui répondre un message = Claude Code
// réveille la session avec ce message, qu'elle soit dans un terminal ou dans l'app Claude.
function endListen(s, o) {
  const l = s.listen;
  if (!l) return;
  s.listen = null; clearTimeout(l.timer);
  try { json(l.res, 200, o); } catch {}
}
// Seuls un message, une quête ou un coup de fouet réveillent (une friandise attend la prochaine action).
function wake(s, force) {
  if (force) s.wakeMe = true;
  if (!s.wakeMe || !s.listen || s.stopWait || s.owned || !s.pending.length || !['idle', 'sleeping'].includes(s.state)) return false;
  const msg = s.pending.splice(0).join('\n');
  s.wakeMe = false;
  (store.log[s.sid] || []).forEach(m => { if (m.status === 'queued') m.status = 'continued'; });
  saveStore();
  s.state = 'thinking'; s.tool = null;
  endListen(s, { message: msg });
  broadcast({ hook: 'Delivered', sid: s.sid });
  broadcast({ hook: 'Thinking', ...pub(s) });
  return true;
}
function queue(s, msg) {
  s.pending.push(msg);
  if (s.pending.length > 6) s.pending.shift();
  saveStore();
}
function takeContext(s, hookEventName) {
  if (!s.pending.length) return {};
  const ctx = s.pending.splice(0).join('\n');
  s.wakeMe = false;
  (store.log[s.sid] || []).forEach(m => { if (m.status === 'queued') m.status = 'delivered'; });
  saveStore();
  broadcast({ hook: 'Delivered', sid: s.sid });
  return { hookSpecificOutput: { hookEventName, additionalContext: ctx } };
}

// ---------- mini-diff en direct : lignes ajoutées / retirées par l'agent pendant la quête ----------
const lineCount = t => (typeof t === 'string' && t.length ? t.split('\n').length : 0);
function trackEdit(s, tool, input = {}) {
  let add = 0, del = 0;
  if (tool === 'Edit') { add = lineCount(input.new_string); del = lineCount(input.old_string); }
  else if (tool === 'MultiEdit') for (const e of input.edits || []) { add += lineCount(e.new_string); del += lineCount(e.old_string); }
  else if (tool === 'Write') add = lineCount(input.content);
  else if (tool === 'NotebookEdit') add = lineCount(input.new_source);
  else return;
  const file = input.file_path || input.notebook_path || '';
  // Lignes remplacées : comptées à part (~) ; le reste est un ajout (+) ou un retrait (−).
  const same = Math.min(add, del); add -= same; del -= same;
  if (!same && !add && !del) return;
  const t = s.editTot ||= { files: new Set(), add: 0, del: 0 };
  t.files.add(file); t.add += add; t.del += del;
  s.edit = { file: path.basename(file), add, del, changed: same, at: Date.now() };
}

// ---------- file de quêtes : l'agent enchaîne la suivante dès qu'il a fini ----------
// store.queue[sid] = [texte, ...] ; store.hold = null | 'manual' | 'limits' (file en pause).
const queueOf = s => store.queue[s.sid] ||= [];
function queueChanged(s) { saveStore(); broadcast({ hook: 'Queue', sid: s.sid, queue: queueOf(s), hold: store.hold }); }
// Agent de l'appli au repos : on lui envoie la quête suivante. (Session terminal : voir le hook Stop.)
function dispatchOwned(s) {
  if (!s.owned || store.hold || !(s.state === 'idle' || s.state === 'sleeping') || s.permWait) return false;
  const t = queueOf(s).shift();
  if (!t) return false;
  s.task = oneLine(t, 70); s.actions = 0;
  sendPrompt(s, t);
  queueChanged(s);
  broadcast({ hook: 'QueueNext', ...pub(s) });
  return true;
}
function releaseQueues() { for (const s of sessions.values()) dispatchOwned(s); }

// ---------- équipe : un gros objectif découpé en parties, un agent par partie, un tableau de suivi ----------
// store.missions = [{ id, goal, cwd, created, done, members: [{ sid, name, part, done, ok }] }]
// Découpage : une petite requête Haiku à part (sans conversation sauvegardée, sans les hooks du jeu).
function teamSplit(goal, n) {
  if (!goal) return { ok: false, error: 'objectif vide' };
  return new Promise(resolve => {
    const p = spawn(CLAUDE, ['-p', MSG.split(goal, n), '--model', 'haiku', '--no-session-persistence'], { cwd: os.tmpdir(), env: { ...agentEnv(), GOTCHI_PORT: '1' }, windowsHide: true });
    let out = '', err = '';
    p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d);
    const timer = setTimeout(() => { try { p.kill(); } catch {} }, 120e3);
    p.on('error', e => { clearTimeout(timer); resolve({ ok: false, error: e.message }); });
    p.on('exit', () => {
      clearTimeout(timer);
      try {
        const parts = JSON.parse(out.slice(out.indexOf('['), out.lastIndexOf(']') + 1)).map(x => oneLine(x, 300)).filter(Boolean);
        if (parts.length) return resolve({ ok: true, parts: parts.slice(0, n) });
      } catch {}
      resolve({ ok: false, error: oneLine(err || out || 'réponse illisible', 200) });
    });
  });
}
function teamLaunch(a) {
  const goal = oneLine(a.goal, 2000), parts = (Array.isArray(a.parts) ? a.parts : []).map(x => oneLine(x, 400)).filter(Boolean).slice(0, 4);
  if (!goal || parts.length < 2) return { ok: false, error: 'il faut un objectif et au moins 2 parties' };
  const members = [];
  for (const part of parts) {
    const r = onAction({ type: 'create', cwd: a.cwd, model: a.model });
    if (!r.ok) return { ok: false, error: r.error };
    members.push({ sid: r.sid, name: sessions.get(r.sid).name, part, done: false, ok: null });
  }
  const m = { id: crypto.randomUUID().slice(0, 8), goal, cwd: String(a.cwd || ''), created: Date.now(), done: false, members };
  (store.missions ||= []).unshift(m); store.missions.length = Math.min(store.missions.length, 12);
  saveStore();
  members.forEach(x => {
    const s = sessions.get(x.sid);
    s.task = oneLine(x.part, 70);
    sendPrompt(s, MSG.team(goal, x.part, members.filter(o => o !== x).map(o => o.part)));
  });
  broadcast({ hook: 'Missions', missions: store.missions });
  return { ok: true, id: m.id };
}
// Fin du premier tour d'un agent de mission : sa partie est faite ; toutes faites = mission terminée.
function missionTurnDone(s, ok) {
  for (const m of store.missions || []) {
    const x = m.members.find(x => x.sid === s.sid);
    if (!x || x.done) continue;
    x.done = true; x.ok = ok;
    if (!m.done && m.members.every(y => y.done)) { m.done = Date.now(); broadcast({ hook: 'MissionDone', id: m.id, goal: m.goal }); }
    saveStore(); broadcast({ hook: 'Missions', missions: store.missions });
  }
}

// ---------- réveil : le hook d'écoute est-il installé ? (sinon le jeu propose de l'ajouter, sur ton clic) ----------
// Même chose que « node install.js » : ajoute le hook Stop « asyncRewake » dans ~/.claude/settings.json,
// avec une sauvegarde du fichier, sans toucher aux autres hooks.
const SETTINGS_FILE = path.join(os.homedir(), '.claude', 'settings.json');
const isGotchiHook = h => h && typeof h.command === 'string' && h.command.includes(path.join('agent-gotchi', 'hook.js'));
function readSettings() { try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { return null; } }
function wakeReady() {
  const st = readSettings();
  return !!(st && st.hooks && (st.hooks.Stop || []).some(g => (g.hooks || []).some(h => isGotchiHook(h) && h.asyncRewake && /--listen/.test(h.command))));
}
function installWake() {
  const raw = (() => { try { return fs.readFileSync(SETTINGS_FILE, 'utf8'); } catch { return null; } })();
  if (raw === null) return { ok: false, error: 'settings.json introuvable' };
  let st;
  try { st = JSON.parse(raw); } catch (e) { return { ok: false, error: 'settings.json illisible : ' + e.message }; }
  if (wakeReady()) return { ok: true, already: true };
  // Le node déjà utilisé par nos hooks (le jeu compilé n'est pas node lui-même).
  const ours = Object.values(st.hooks || {}).flat().flatMap(g => g.hooks || []).find(isGotchiHook);
  const node = ours ? (ours.command.match(/^"([^"]+)"/) || [])[1] : null;
  if (!node) return { ok: false, error: 'hooks Agent·Gotchi absents : lance d\'abord node install.js' };
  fs.writeFileSync(`${SETTINGS_FILE}.gotchi-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`, raw);
  (st.hooks.Stop ||= []).push({ hooks: [{ type: 'command', command: `"${node}" "${path.join(HOOK_DIR, 'hook.js')}" --listen`, timeout: 43200, asyncRewake: true }] });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(st, null, 2));
  broadcast({ hook: 'WakeReady', ready: true });
  return { ok: true };
}

// ---------- tâches planifiées : « tous les jours à 9 h, lance les tests » ----------
// store.schedules = [{ id, sid, name, text, at: 'HH:MM', days: 'daily' | 'weekdays', last: 'AAAA-MM-JJ' }]
// À l'heure dite, la quête part dans la file de l'agent (il la prend dès qu'il est libre). Le jeu doit tourner.
const today = (d = new Date()) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
function runSchedules() {
  const now = new Date(), hm = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0'), day = today(now);
  for (const j of store.schedules || []) {
    if (j.last === day || hm < j.at) continue;
    if (j.days === 'weekdays' && (now.getDay() === 0 || now.getDay() === 6)) continue;
    j.last = day;
    const sess = sessions.get(j.sid);
    if (!sess) { broadcast({ hook: 'SchedRun', id: j.id, name: j.name, text: j.text, ok: false }); continue; }
    const r = onAction({ type: 'enqueue', sid: j.sid, text: j.text });
    broadcast({ hook: 'SchedRun', id: j.id, sid: j.sid, name: j.name, text: j.text, ok: !!r.ok });
  }
  saveStore();
}
setInterval(runSchedules, 30e3);
const schedPub = () => store.schedules || [];

// ---------- règles d'autorisation : refuser / demander / autoriser sans cliquer ----------
// store.rules = [{ tool: 'Bash' | 'mcp__*' | '*', match: 'rm -rf|.env' (optionnel), decision: 'deny'|'ask'|'allow' }]
// Ordre d'examen : refus d'abord, puis demande, puis autorisation (le plus prudent gagne).
const RULE_ORDER = { deny: 0, ask: 1, allow: 2 };
function ruleFor(tool = '', input = {}) {
  const hay = JSON.stringify(input || {}).toLowerCase();
  const hit = r => {
    const t = String(r.tool || '*');
    const toolOk = t === '*' || (t.endsWith('*') ? tool.startsWith(t.slice(0, -1)) : tool === t);
    if (!toolOk) return false;
    const parts = String(r.match || '').toLowerCase().split('|').map(x => x.trim()).filter(Boolean);
    return !parts.length || parts.some(p => hay.includes(p));
  };
  return [...(store.rules || [])].sort((a, b) => RULE_ORDER[a.decision] - RULE_ORDER[b.decision]).find(hit) || null;
}
const ruleOutput = (allow, r) => ({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse', permissionDecision: allow ? 'allow' : 'deny',
    permissionDecisionReason: allow ? `Autorisé par une règle Agent·Gotchi (${r.tool}${r.match ? ` « ${r.match} »` : ''})`
      : `Refusé par une règle Agent·Gotchi (${r.tool}${r.match ? ` « ${r.match} »` : ''}). Trouve une autre façon de faire ou demande à ton utilisateur.`,
  },
});
function cleanRules(list) {
  return (Array.isArray(list) ? list : []).slice(0, 50).map(r => ({
    tool: oneLine(r.tool, 80) || '*', match: oneLine(r.match, 200),
    decision: ['deny', 'ask', 'allow'].includes(r.decision) ? r.decision : 'ask',
  }));
}

// ---------- historique : toutes tes conversations Claude Code (~/.claude/projects) ----------
const PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const convCache = new Map();
function convInfo(file) {
  const st = fs.statSync(file), hit = convCache.get(file);
  if (hit && hit.mtime === st.mtimeMs) return hit.info;
  const n = Math.min(st.size, 400e3), buf = Buffer.alloc(n), fd = fs.openSync(file, 'r');
  fs.readSync(fd, buf, 0, n, 0); fs.closeSync(fd);
  let cwd = null, summary = null, first = null;
  for (const l of buf.toString('utf8').split('\n')) {
    let e;
    try { e = JSON.parse(l); } catch { continue; }
    if (!cwd && e.cwd) cwd = e.cwd;
    if (e.type === 'summary' && e.summary) summary = e.summary;
    if (!first && e.type === 'user' && !e.isMeta && !e.isSidechain && e.message) {
      const c = e.message.content;
      const t = typeof c === 'string' ? c : Array.isArray(c) ? (c.find(p => p.type === 'text') || {}).text : '';
      // Pas de titre tiré des reprises automatiques (compaction) ni des consignes de session lancée.
      const clean = String(t || '').replace(/<([a-z-]+)>[\s\S]*?<\/\1>/g, '')
        .replace(/^Background \(from the session that started this one\):\s*/i, '').trim();
      if (clean && !clean.startsWith('<') && !clean.includes('[Agent·Gotchi]') && !/^This session is being continued/i.test(clean)) first = clean;
    }
    if (cwd && first && summary) break;
  }
  // Titre donné à la session (renommage ou titre auto) : la dernière entrée *-title, en fin de fichier.
  let named = null;
  const tn = Math.min(st.size, 200e3), tail = Buffer.alloc(tn), fd2 = fs.openSync(file, 'r');
  fs.readSync(fd2, tail, 0, tn, st.size - tn); fs.closeSync(fd2);
  const lines = [...buf.toString('utf8').split('\n'), ...tail.toString('utf8').split('\n')].reverse();
  for (const l of lines) {
    if (!l.includes('-title"')) continue;
    try { const e = JSON.parse(l); named = e.customTitle || e.aiTitle || null; if (named) break; } catch {}
  }
  const info = { sid: path.basename(file, '.jsonl'), file, cwd, title: oneLine(named || summary || first || '', 90), mtime: st.mtimeMs, empty: !first };
  convCache.set(file, { mtime: st.mtimeMs, info });
  return info;
}
function transcriptFiles() {
  const files = new Map();
  let dirs = [];
  try { dirs = fs.readdirSync(PROJECTS, { withFileTypes: true }).filter(d => d.isDirectory()); } catch { return files; }
  for (const d of dirs) {
    const dir = path.join(PROJECTS, d.name);
    let names = [];
    try { names = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')); } catch {}
    for (const f of names) { try { files.set(path.basename(f, '.jsonl'), { file: path.join(dir, f), mtime: fs.statSync(path.join(dir, f)).mtimeMs }); } catch {} }
  }
  return files;
}
// Sessions de l'app de bureau Claude (titres, dossiers, sous-sessions) : lues, jamais modifiées.
const DESKTOP_ROOTS = [
  ...(() => { const b = path.join(process.env.LOCALAPPDATA || '', 'Claude-Data'); try { return fs.readdirSync(b).map(d => path.join(b, d, 'claude-code-sessions')); } catch { return []; } })(),
  path.join(process.env.APPDATA || '', 'Claude', 'claude-code-sessions'),
].filter(p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
const deskCache = new Map();
function desktopSessions() {
  const out = [];
  const ls = p => { try { return fs.readdirSync(p); } catch { return []; } };
  for (const root of DESKTOP_ROOTS) for (const a of ls(root)) for (const b of ls(path.join(root, a))) for (const f of ls(path.join(root, a, b))) {
    if (!/^local_.*\.json$/.test(f)) continue;
    const file = path.join(root, a, b, f);
    try {
      const m = fs.statSync(file).mtimeMs, hit = deskCache.get(file);
      if (hit && hit.m === m) { out.push(hit.d); continue; }
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      const d = {
        id: j.sessionId, sid: j.cliSessionId, title: j.title, cwd: j.originCwd || j.cwd, archived: !!j.isArchived,
        at: +j.lastActivityAt || +j.createdAt || m, parent: j.spawnedFrom && j.spawnedFrom.sessionId,
      };
      deskCache.set(file, { m, d }); out.push(d);
    } catch {}
  }
  return out;
}
const isScratch = cwd => /scratch-workspaces/i.test(cwd || '');
// Liste façon barre latérale de Claude : groupes par dossier, sous-sessions rangées sous leur parente.
function listConvs(limit = 150) {
  const files = transcriptFiles(), out = [], all = desktopSessions();
  // Les sessions archivées dans l'app restent cachées (on ne les remet pas en « terminal »).
  const seen = new Set(all.map(d => d.sid).filter(Boolean));
  const desk = all.filter(d => d.sid && !d.archived && files.has(d.sid));
  const byLocal = new Map(desk.map(d => [d.id, d.sid]));
  for (const d of desk) {
    out.push({ sid: d.sid, file: files.get(d.sid).file, cwd: d.cwd, title: oneLine(d.title || 'Sans titre', 90), mtime: Math.max(d.at, files.get(d.sid).mtime), parent: byLocal.get(d.parent) || null, source: 'desktop' });
  }
  // Ancien transcript d'une session reprise ou déplacée de dossier (même titre qu'une session de l'app) :
  // Claude le masque, nous aussi.
  const deskTitles = new Set(out.map(c => c.title));
  const rest = [...files.entries()].filter(([sid]) => !seen.has(sid)).sort((a, b) => b[1].mtime - a[1].mtime);
  for (const [, f] of rest) {
    if (out.length >= limit) break;
    try {
      const c = convInfo(f.file);
      if (!c.empty && c.cwd && !deskTitles.has(c.title)) out.push({ ...c, parent: null, source: 'cli' });
    } catch {}
  }
  const local = out.map(c => ({ ...c, group: isScratch(c.cwd) ? null : c.cwd }));
  // Conversations claude.ai importées : groupe à part, lecture seule (on peut les continuer dans un agent).
  const ai = loadAi().map(c => ({ sid: 'ai:' + c.id, title: c.title, cwd: '', mtime: c.updated, parent: null, source: 'claudeai', group: '::claude.ai', count: c.messages.length }));
  return [...local, ...ai];
}

// ---------- conversations claude.ai : import de l'export officiel (Paramètres › Confidentialité › Exporter) ----------
const AI_FILE = path.join(HOOK_DIR, 'claudeai.json');
let aiConvs = null;
const loadAi = () => aiConvs || (aiConvs = (() => { try { return JSON.parse(fs.readFileSync(AI_FILE, 'utf8')); } catch { return []; } })());
// Lecteur zip minimal (le zip de l'export contient conversations.json).
function unzipEntry(buf, wanted) {
  let e = buf.length - 22;
  while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error('fichier zip illisible');
  const count = buf.readUInt16LE(e + 10);
  let p = buf.readUInt32LE(e + 16);
  for (let i = 0; i < count && buf.readUInt32LE(p) === 0x02014b50; i++) {
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    if (wanted(name)) {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28), data = buf.subarray(start, start + csize);
      return method === 0 ? data : zlib.inflateRawSync(data);
    }
    p += 46 + nlen + xlen + clen;
  }
  return null;
}
function aiText(m) {
  const parts = Array.isArray(m.content) ? m.content.filter(c => c && c.type === 'text' && c.text).map(c => c.text) : [];
  let t = parts.length ? parts.join('\n') : String(m.text || '');
  const files = [...(m.attachments || []), ...(m.files || [])].map(f => f.file_name || f.name).filter(Boolean);
  if (files.length) t += `\n[pièces jointes : ${files.join(', ')}]`;
  return t.trim();
}
function importClaudeAi(raw) {
  const isZip = raw.readUInt32LE(0) === 0x04034b50;
  const json = JSON.parse((isZip ? unzipEntry(raw, n => /(^|\/)conversations\.json$/i.test(n)) : raw)?.toString('utf8') || 'null');
  if (!json) throw new Error("pas de conversations.json dans l'export");
  const list = (Array.isArray(json) ? json : json.conversations || []).map(c => ({
    id: String(c.uuid || c.id || ''), title: oneLine(c.name || c.title || 'Sans titre', 90),
    created: Date.parse(c.created_at) || 0, updated: Date.parse(c.updated_at) || Date.parse(c.created_at) || 0,
    messages: (c.chat_messages || c.messages || []).map(m => ({
      role: (m.sender || m.role) === 'human' || m.role === 'user' ? 'user' : 'assistant', text: aiText(m), ts: Date.parse(m.created_at) || 0,
    })).filter(m => m.text),
  })).filter(c => c.id && c.messages.length);
  if (!list.length) throw new Error("aucune conversation trouvée dans l'export");
  // Fusion avec un import précédent : la version la plus récente de chaque conversation gagne.
  const all = new Map(loadAi().map(c => [c.id, c]));
  for (const c of list) if (!all.has(c.id) || all.get(c.id).updated <= c.updated) all.set(c.id, c);
  aiConvs = [...all.values()].sort((a, b) => b.updated - a.updated);
  fs.writeFileSync(AI_FILE, JSON.stringify(aiConvs));
  return { ok: true, count: list.length, total: aiConvs.length };
}
// Premier message envoyé à l'agent qui reprend la conversation (historique tronqué au début si trop long).
function aiResumePrompt(c) {
  const lines = c.messages.map(m => `[${m.role === 'user' ? MSG.me : 'Claude'}] ${m.text}`);
  let hist = [], size = 0;
  for (let i = lines.length - 1; i >= 0 && size < 150000; i--) { hist.unshift(lines[i]); size += lines[i].length; }
  return MSG.resume(c.title, c.messages.length, lines.length - hist.length, hist.join('\n\n'));
}

// ---------- chat : relit le transcript JSONL de la session ----------
function readChat(file) {
  if (!file || !file.endsWith('.jsonl') || !fs.existsSync(file)) return [];
  const size = fs.statSync(file).size, start = Math.max(0, size - 3e6);
  const buf = Buffer.alloc(size - start), fd = fs.openSync(file, 'r');
  fs.readSync(fd, buf, 0, buf.length, start); fs.closeSync(fd);
  const lines = buf.toString('utf8').split('\n');
  if (start) lines.shift();
  const out = [];
  const add = (role, text, ts) => out.push({ role, text: text.length > 6000 ? text.slice(0, 6000) + ' […]' : text, ts });
  const user = (t, ts) => {
    const clean = t.replace(/<(system-reminder|local-command-[a-z]+|command-[a-z]+)>[\s\S]*?<\/\1>/g, '').trim();
    // Reprise d'une conversation claude.ai : on n'affiche pas tout l'historique collé, juste la première ligne.
    if (clean.startsWith('[Reprise claude.ai]')) return add('user', '📥 ' + clean.split('\n')[0].replace('[Reprise claude.ai] ', store.lang === 'en' ? 'claude.ai conversation resumed: ' : 'Conversation claude.ai reprise : '), ts);
    // Nos propres injections (relance après Stop) viennent du journal de l'appli, pas d'ici.
    if (clean && !clean.startsWith('<') && !clean.includes('[Agent·Gotchi]')) add('user', clean, ts);
  };
  for (const l of lines) {
    let e;
    try { e = JSON.parse(l); } catch { continue; }
    if (e.isSidechain || e.isMeta || !e.message) continue;
    const c = e.message.content, ts = Date.parse(e.timestamp) || 0;
    if (e.type === 'user') {
      if (typeof c === 'string') user(c, ts);
      else if (Array.isArray(c)) c.forEach(p => p.type === 'text' && user(p.text, ts));
    } else if (e.type === 'assistant' && Array.isArray(c)) {
      for (const p of c) {
        if (p.type === 'text' && p.text.trim()) add('assistant', p.text.trim(), ts);
        else if (p.type === 'tool_use') add('tool', toolLabel(p.name, p.input), ts);
      }
    }
  }
  return out.slice(-300);
}
function endGrace(s, result) {
  if (!s.stopWait) return;
  clearTimeout(s.stopWait.timer);
  const done = s.stopWait.resolve;
  s.stopWait = null; s.graceEnd = 0;
  done(result || {});
  broadcast({ hook: 'GraceEnd', ...pub(s) });
}

async function onHook(h) {
  const ev = h.hook_event_name, sid = h.session_id;
  if (!sid) return {};
  const s = getSession(sid, h.cwd);
  s.last = Date.now();
  if (h.transcript_path && h.transcript_path !== s.transcript) {
    s.transcript = h.transcript_path;
    if (store.owned[sid]) { store.owned[sid].transcript = s.transcript; saveStore(); }
  }
  updateUsage(s);
  if (h.cwd && !store.cwds.includes(h.cwd)) { store.cwds.unshift(h.cwd); store.cwds.length = Math.min(store.cwds.length, 20); saveStore(); }
  let out = {};
  switch (ev) {
    case 'SessionStart':
      s.state = 'idle';
      break;
    case 'UserPromptSubmit':
      endListen(s, { cancel: true });
      endGrace(s, null);
      // Les notifications système (<task-notification>…) ne sont pas une nouvelle quête.
      if (!String(h.prompt || '').trim().startsWith('<')) { s.task = oneLine(h.prompt, 70); s.actions = 0; s.edit = null; s.editTot = null; }
      s.tool = null; s.perm = null; s.state = 'thinking';
      out = takeContext(s, ev);
      break;
    case 'PreToolUse': {
      s.state = 'working'; s.tool = toolLabel(h.tool_name, h.tool_input); s.actions++; s.perm = null;
      const own = store.owned[sid];
      // Règles : pour les agents de l'appli, et pour les sessions terminal si l'option est cochée.
      const rule = (own || store.rulesTerminal) ? ruleFor(h.tool_name, h.tool_input) : null;
      if (rule && rule.decision !== 'ask') {
        broadcast({ hook: 'Rule', sid, name: s.name, tool: s.tool, decision: rule.decision });
        if (rule.decision === 'deny') { broadcast({ hook: ev, ...pub(s) }); return ruleOutput(false, rule); }
        broadcast({ hook: ev, ...pub(s) });
        return ruleOutput(true, rule);
      }
      // « Demander » : le jeu pose la question même pour un outil d'habitude autorisé.
      if (own && (rule || (!SAFE_TOOLS.has(h.tool_name) && !(own.allow || []).includes(h.tool_name)))) {
        // Agent de l'appli : c'est le jeu qui autorise ou refuse (boutons sur sa caméra).
        broadcast({ hook: ev, ...pub(s) });
        s.state = 'waiting'; s.perm = s.tool;
        broadcast({ hook: 'Notification', kind: 'permission_prompt', message: s.tool, ...pub(s) });
        return new Promise(resolve => {
          s.permWait = { resolve, tool: h.tool_name, timer: setTimeout(() => answerPerm(s, false), 10 * 60e3) };
        });
      }
      break;
    }
    case 'PostToolUse':
      if (s.state === 'waiting') s.state = 'working';
      s.perm = null;
      trackEdit(s, h.tool_name, h.tool_input);
      out = takeContext(s, ev);
      break;
    case 'Notification': {
      const m = h.message || '';
      const kind = h.notification_type || (/permission/i.test(m) ? 'permission_prompt' : /waiting for your input|idle/i.test(m) ? 'idle_prompt' : 'other');
      if (kind === 'permission_prompt') { s.state = 'waiting'; s.perm = oneLine(m, 90); }
      else if (kind === 'idle_prompt') s.state = 'idle';
      broadcast({ hook: ev, kind, message: oneLine(m, 90), ...pub(s) });
      return {};
    }
    case 'Stop':
      s.state = 'idle'; s.tool = null; s.perm = null;
      if (!limits || Date.now() - (limits.at || 0) > 15e3) pollLimits();
      // File de quêtes d'une session terminal : on enchaîne tout de suite sur la suivante.
      if (!s.owned && !store.hold && queueOf(s).length) {
        const t = queueOf(s).shift();
        broadcast({ hook: ev, ...pub(s) });
        s.task = oneLine(t, 70); s.actions = 0; s.state = 'thinking';
        queueChanged(s);
        broadcast({ hook: 'QueueNext', sid, task: s.task, ...pub(s) });
        return { decision: 'block', reason: MSG.quest(t) };
      }
      // Agents de l'appli : pas besoin de fenêtre, on peut leur écrire à tout moment.
      if (clients.size && GRACE_MS > 0 && !s.owned) {
        s.graceEnd = Date.now() + GRACE_MS;
        broadcast({ hook: ev, ...pub(s) });
        // Le hook attend : un coup de fouet pendant la fenêtre empêche Claude de s'arrêter.
        return new Promise(resolve => {
          s.stopWait = { resolve, timer: setTimeout(() => endGrace(s, null), GRACE_MS) };
        });
      }
      break;
    case 'SessionEnd':
      endListen(s, { cancel: true });
      // Le process d'un agent de l'appli s'arrête : l'agent reste, il repartira à la prochaine requête.
      if (s.owned) { s.state = 'idle'; s.tool = null; break; }
      endGrace(s, null);
      sessions.delete(sid);
      delete store.pending[sid]; delete store.queue[sid];
      (store.log[sid] || []).forEach(m => { if (m.status === 'queued') m.status = 'expired'; });
      saveStore();
      broadcast({ hook: ev, sid, name: s.name });
      return {};
  }
  broadcast({ hook: ev, ...pub(s) });
  return out;
}

function onAction(a) {
  if (a.type === 'refreshAuth') return refreshAuth();
  if (a.type === 'rename') {
    const r = sessions.get(a.sid), n = oneLine(a.name, 10).toUpperCase().replace(/[^A-Z0-9_-]/g, '');
    if (!r || !n) return { ok: false, error: 'nom invalide' };
    r.name = n; (store.names ||= {})[r.sid] = n; if (store.owned[r.sid]) store.owned[r.sid].name = n;
    saveStore(); broadcast({ hook: 'Renamed', ...pub(r) });
    return { ok: true, name: n };
  }
  if (a.type === 'installWake') return installWake();
  if (a.type === 'teamSplit') return teamSplit(String(a.goal || '').trim().slice(0, 2000), Math.min(4, Math.max(2, +a.n || 2)));
  if (a.type === 'teamLaunch') return teamLaunch(a);
  if (a.type === 'teamForget') { store.missions = (store.missions || []).filter(m => m.id !== a.id); saveStore(); broadcast({ hook: 'Missions', missions: store.missions }); return { ok: true }; }
  if (a.type === 'lang') { store.lang = a.lang === 'en' ? 'en' : 'fr'; saveStore(); return { ok: true }; }
  if (a.type === 'pollLimits') { pollLimits(true); return { ok: true }; }
  if (a.type === 'hold') {
    store.hold = a.on ? 'manual' : null; saveStore();
    broadcast({ hook: 'Hold', hold: store.hold });
    if (!store.hold) releaseQueues();
    return { ok: true };
  }
  if (a.type === 'rules') {
    store.rules = cleanRules(a.rules); store.rulesTerminal = !!a.terminal; saveStore();
    broadcast({ hook: 'Rules', rules: store.rules, terminal: store.rulesTerminal });
    return { ok: true };
  }
  if (a.type === 'settings') {
    store.settings = { autoPause: !!a.autoPause, pauseAt: Math.min(100, Math.max(50, +a.pauseAt || 95)) }; saveStore();
    if (!store.settings.autoPause && store.hold === 'limits') { store.hold = null; broadcast({ hook: 'Hold', hold: null }); releaseQueues(); }
    return { ok: true };
  }
  if (a.type === 'hotkey') { setHotkey(a.vk); return { ok: true }; }
  if (a.type === 'schedAdd') {
    const sess = sessions.get(a.sid), text = String(a.text || '').trim().slice(0, 2000), at = /^\d\d:\d\d$/.test(a.at) ? a.at : null;
    if (!sess || !text || !at) return { ok: false, error: 'incomplet' };
    if ((store.schedules ||= []).length >= 40) return { ok: false, error: 'trop de tâches' };
    // Déjà passée aujourd'hui : elle commence demain (sinon elle partirait tout de suite).
    const now = new Date(), hm = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
    store.schedules.push({ id: crypto.randomUUID().slice(0, 8), sid: sess.sid, name: sess.name, text, at, days: a.days === 'weekdays' ? 'weekdays' : 'daily', last: hm >= at ? today() : null });
    saveStore(); broadcast({ hook: 'Schedules', schedules: schedPub() });
    return { ok: true };
  }
  if (a.type === 'schedDel') {
    store.schedules = (store.schedules || []).filter(j => j.id !== a.id);
    saveStore(); broadcast({ hook: 'Schedules', schedules: schedPub() });
    return { ok: true };
  }
  if (a.type === 'revert') return revertFile(a.sid, a.file);
  if (a.type === 'create' || a.type === 'continueAi') {
    const c = a.type === 'continueAi' && loadAi().find(x => x.id === String(a.id || '').replace(/^ai:/, ''));
    if (a.type === 'continueAi' && !c) return { ok: false, error: 'conversation claude.ai introuvable' };
    const cwd = String(a.cwd || '').trim().replace(/^"|"$/g, '');
    try { if (!fs.statSync(cwd).isDirectory()) throw 0; } catch { return { ok: false, error: 'dossier introuvable' }; }
    const sid = crypto.randomUUID();
    const name = oneLine(a.name, 10).toUpperCase().replace(/[^A-Z0-9_-]/g, '') || nameFor(cwd);
    store.owned[sid] = { cwd, name, started: false, allow: [], model: MODELS.includes(a.model) ? a.model : null };
    if (!store.cwds.includes(cwd)) store.cwds.unshift(cwd);
    saveStore();
    const s = getSession(sid, cwd, name);
    broadcast({ hook: 'SessionStart', ...pub(s) });
    if (c) sendPrompt(s, aiResumePrompt(c)); // l'agent reçoit l'historique et reprend
    return { ok: true, sid };
  }
  if (a.type === 'adopt') {
    // Reprendre une conversation existante dans l'appli (elle continue la même session Claude).
    const c = listConvs(1000).find(x => x.sid === a.sid);
    if (!c) return { ok: false, error: 'conversation introuvable' };
    if (store.owned[c.sid]) return { ok: true, sid: c.sid };
    const old = sessions.get(c.sid);
    if (old) { if (old.permWait) answerPerm(old, false); endGrace(old, null); sessions.delete(c.sid); broadcast({ hook: 'SessionEnd', sid: c.sid, name: old.name }); }
    store.owned[c.sid] = { cwd: c.cwd, name: nameFor(c.cwd), started: true, allow: [], model: null, transcript: c.file };
    saveStore();
    const s = getSession(c.sid, c.cwd);
    updateUsage(s);
    broadcast({ hook: 'SessionStart', ...pub(s) });
    return { ok: true, sid: c.sid };
  }
  const s = sessions.get(a.sid);
  if (!s) return { ok: false, error: 'session inconnue' };
  if (a.type === 'enqueue') {
    const t = String(a.text || '').trim().slice(0, 4000);
    if (!t) return { ok: false, error: 'quête vide' };
    const q = queueOf(s);
    if (q.length >= 20) return { ok: false, error: 'file pleine' };
    q.push(t); queueChanged(s);
    // Déjà disponible ? Il la prend tout de suite.
    if (s.owned) dispatchOwned(s);
    else if (s.stopWait && !store.hold) {
      q.shift(); queueChanged(s);
      s.task = oneLine(t, 70); s.actions = 0; s.state = 'thinking';
      endGrace(s, { decision: 'block', reason: MSG.quest(t) });
      broadcast({ hook: 'QueueNext', sid: s.sid, task: s.task, ...pub(s) });
    } else if (s.listen && !store.hold && ['idle', 'sleeping'].includes(s.state)) {
      q.shift(); queueChanged(s);
      s.pending.push(MSG.quest(t));
      s.task = oneLine(t, 70); s.actions = 0;
      wake(s, true);
      broadcast({ hook: 'QueueNext', sid: s.sid, task: s.task, ...pub(s) });
    }
    return { ok: true, queue: queueOf(s) };
  }
  if (a.type === 'dequeue') {
    const q = queueOf(s);
    if (a.index >= 0 && a.index < q.length) q.splice(a.index, 1);
    else if (a.clear) q.length = 0;
    queueChanged(s);
    return { ok: true, queue: q };
  }
  if (s.owned) {
    if (a.type === 'prompt' || a.type === 'quest') {
      const t = String(a.text || '').trim().slice(0, 20000);
      if (!t) return { ok: false, error: 'message vide' };
      sendPrompt(s, t);
      return { ok: true, effect: 'sent' };
    }
    if (a.type === 'perm') { answerPerm(s, !!a.allow, !!a.always); return { ok: true }; }
    if (a.type === 'model') {
      const own = store.owned[s.sid];
      own.model = MODELS.includes(a.model) ? a.model : null;
      saveStore();
      // Le modèle se choisit au lancement du process : on le relance (tout de suite s'il est au repos).
      const p = procs.get(s.sid);
      if (p) { if (s.state === 'idle' || s.state === 'sleeping') p.kill(); else own.restart = true; }
      broadcast({ hook: 'Model', ...pub(s) });
      return { ok: true };
    }
    if (a.type === 'interrupt') {
      const p = procs.get(s.sid);
      if (!p) return { ok: false, error: 'rien en cours' };
      p.stdin.write(JSON.stringify({ type: 'control_request', request_id: crypto.randomUUID(), request: { subtype: 'interrupt' } }) + '\n');
      if (s.permWait) answerPerm(s, false);
      setTimeout(() => { if (s.state !== 'idle' && procs.get(s.sid) === p) p.kill(); }, 4000);
      return { ok: true };
    }
    if (a.type === 'dismiss') {
      procs.get(s.sid)?.kill();
      if (s.permWait) answerPerm(s, false);
      delete store.owned[s.sid]; delete store.pending[s.sid]; delete store.queue[s.sid]; saveStore();
      sessions.delete(s.sid);
      broadcast({ hook: 'SessionEnd', sid: s.sid, name: s.name });
      return { ok: true };
    }
    if (a.type === 'whip' && s.state === 'idle' && s.task) {
      sendPrompt(s, MSG.whipStop);
      return { ok: true, effect: 'continued' };
    }
  }
  if (a.type === 'whip') {
    if (s.stopWait) {
      s.state = 'working';
      endGrace(s, { decision: 'block', reason: MSG.whipStop });
      return { ok: true, effect: 'continued' };
    }
    queue(s, s.state === 'idle' ? (s.task ? MSG.whipStop : MSG.whipIdle) : MSG.whipWork);
    if (s.task && wake(s, true)) return { ok: true, effect: 'continued' };
    return { ok: true, effect: 'queued' };
  }
  if (a.type === 'treat') {
    queue(s, MSG.treat(s.task));
    if (s.stopWait) { endGrace(s, null); return { ok: true, effect: 'released' }; }
    return { ok: true, effect: 'queued' };
  }
  if (a.type === 'say') {
    const t = String(a.text || '').trim().slice(0, 4000);
    if (!t) return { ok: false, error: 'message vide' };
    if (s.stopWait) {
      s.state = 'thinking';
      logSent(s, t, 'continued');
      endGrace(s, { decision: 'block', reason: MSG.say(t) });
      return { ok: true, effect: 'continued' };
    }
    logSent(s, t, 'queued');
    queue(s, MSG.say(t));
    if (wake(s, true)) return { ok: true, effect: 'continued' };
    return { ok: true, effect: 'queued' };
  }
  if (a.type === 'quest') {
    const t = oneLine(a.text, 300);
    if (!t) return { ok: false, error: 'quête vide' };
    if (!s.stopWait) {
      if (!s.listen || !['idle', 'sleeping'].includes(s.state)) return { ok: false, error: 'fenêtre fermée' };
      s.pending.push(MSG.quest(t)); s.task = oneLine(t, 70); s.actions = 0;
      wake(s, true);
      return { ok: true, effect: 'continued' };
    }
    s.task = oneLine(t, 70); s.actions = 0; s.state = 'thinking';
    endGrace(s, { decision: 'block', reason: MSG.quest(t) });
    return { ok: true, effect: 'continued' };
  }
  return { ok: false, error: 'action inconnue' };
}

// ---------- changements d'un agent : fichiers qu'il a touchés + état git de son dossier ----------
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const runGit = (cwd, args, max = 8e6) => {
  try { return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: max, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 }); }
  catch { return null; }
};
// Lit un transcript en entier (ou ses 40 derniers Mo) et appelle fn(entrée) pour chaque ligne JSON.
function eachEntry(file, fn, filter) {
  let size;
  try { size = fs.statSync(file).size; } catch { return; }
  const start = Math.max(0, size - 40e6), buf = Buffer.alloc(size - start), fd = fs.openSync(file, 'r');
  fs.readSync(fd, buf, 0, buf.length, start); fs.closeSync(fd);
  const lines = buf.toString('utf8').split('\n');
  if (start) lines.shift();
  for (const l of lines) {
    if (filter && !l.includes(filter)) continue;
    let e;
    try { e = JSON.parse(l); } catch { continue; }
    fn(e);
  }
}
function touchedFiles(file) {
  const out = new Map();
  if (!file) return [];
  eachEntry(file, e => {
    if (e.type !== 'assistant' || e.isSidechain || !Array.isArray(e.message?.content)) return;
    for (const p of e.message.content) {
      if (p.type !== 'tool_use' || !EDIT_TOOLS.has(p.name)) continue;
      const f = p.input?.file_path || p.input?.notebook_path;
      if (!f) continue;
      const o = out.get(f) || { path: f, edits: 0, ts: 0 };
      o.edits++; o.ts = Date.parse(e.timestamp) || o.ts; out.set(f, o);
    }
  }, '"tool_use"');
  return [...out.values()].sort((a, b) => b.ts - a.ts).slice(0, 200);
}
// git status -z : « XY chemin\0 » (renommage : un second chemin, l'ancien, juste après).
function gitStatus(root) {
  const raw = runGit(root, ['status', '--porcelain=v1', '-z', '-uall']);
  if (raw === null) return null;
  const parts = raw.split('\0'), files = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p) continue;
    const x = p.slice(0, 2);
    files.push({ x, path: p.slice(3) });
    if (x[0] === 'R' || x[0] === 'C') i++;
  }
  const num = runGit(root, ['diff', 'HEAD', '--numstat', '-z']) || '';
  const stat = new Map();
  for (const p of num.split('\0')) { const m = p.match(/^(\d+|-)\t(\d+|-)\t(.+)$/); if (m) stat.set(m[3], [m[1], m[2]]); }
  files.forEach(f => { const s = stat.get(f.path); if (s) { f.add = s[0]; f.del = s[1]; } });
  return files.slice(0, 400);
}
function changesFor(sid) {
  const s = sessions.get(sid);
  if (!s) return { ok: false, error: 'session inconnue' };
  const root = s.cwd && (runGit(s.cwd, ['rev-parse', '--show-toplevel']) || '').trim();
  const touched = touchedFiles(s.transcript);
  if (!root) return { ok: true, cwd: s.cwd, root: null, files: [], touched };
  return { ok: true, cwd: s.cwd, root: path.normalize(root), branch: (runGit(root, ['rev-parse', '--abbrev-ref', 'HEAD']) || '').trim(), files: gitStatus(root) || [], touched };
}
// Seuls les chemins listés par git status sont acceptés (rien d'autre n'est lu ni modifié).
function statusEntry(sid, file) {
  const c = changesFor(sid);
  if (!c.ok || !c.root) return { c, f: null };
  return { c, f: c.files.find(f => f.path === file) || null };
}
function diffFor(sid, file) {
  const { c, f } = statusEntry(sid, file);
  if (!f) return { ok: false, error: 'fichier hors de la liste' };
  if (f.x === '??') {
    try {
      const b = fs.readFileSync(path.join(c.root, f.path));
      if (b.includes(0)) return { ok: true, diff: '(fichier binaire)' };
      const t = b.toString('utf8').slice(0, 200e3);
      return { ok: true, diff: `+++ ${f.path} (nouveau fichier)\n` + t.split('\n').map(l => '+' + l).join('\n') };
    } catch { return { ok: false, error: 'illisible' }; }
  }
  const d = runGit(c.root, ['diff', 'HEAD', '--no-color', '--', f.path]) ?? runGit(c.root, ['diff', '--no-color', '--', f.path]) ?? '';
  return { ok: true, diff: d.length > 300e3 ? d.slice(0, 300e3) + '\n[…]' : d };
}
// Annule les modifications d'un fichier suivi par git (retour à la version du dernier commit).
function revertFile(sid, file) {
  const { c, f } = statusEntry(sid, String(file || ''));
  if (!f) return { ok: false, error: 'fichier hors de la liste' };
  if (f.x === '??' || f.x[0] === 'A') return { ok: false, error: 'fichier nouveau : rien à restaurer' };
  const r = runGit(c.root, ['restore', '--source=HEAD', '--staged', '--worktree', '--', f.path]);
  if (r === null) return { ok: false, error: 'git restore a échoué' };
  broadcast({ hook: 'Reverted', sid, file: f.path });
  return { ok: true };
}

// ---------- recherche dans le contenu de toutes les conversations (pas seulement les titres) ----------
// Lit les 8 derniers Mo de chaque transcript (les 300 plus récents) ; seules les lignes qui contiennent
// le texte cherché sont décodées. Résultat : un extrait autour du mot trouvé.
function searchConvs(q) {
  q = String(q || '').trim().toLowerCase();
  if (q.length < 3) return { ok: true, results: [] };
  const t0 = Date.now(), titles = new Map(listConvs(2000).map(c => [c.sid, c])), out = [];
  const files = [...transcriptFiles().entries()].sort((a, b) => b[1].mtime - a[1].mtime).slice(0, 300);
  const textOf = c => typeof c === 'string' ? c : Array.isArray(c) ? c.filter(p => p.type === 'text').map(p => p.text).join(' ') : '';
  for (const [sid, { file, mtime }] of files) {
    if (Date.now() - t0 > 6000 || out.length >= 40) break;
    let buf;
    try { const size = fs.statSync(file).size, start = Math.max(0, size - 8e6); buf = Buffer.alloc(size - start); const fd = fs.openSync(file, 'r'); fs.readSync(fd, buf, 0, buf.length, start); fs.closeSync(fd); } catch { continue; }
    const raw = buf.toString('utf8'), low = raw.toLowerCase();
    if (!low.includes(q)) continue;
    let hits = 0, snippet = '', role = '';
    for (let i = low.indexOf(q); i >= 0 && hits < 50; i = low.indexOf(q, i + q.length)) {
      const a = raw.lastIndexOf('\n', i) + 1, b = raw.indexOf('\n', i);
      let e; try { e = JSON.parse(raw.slice(a, b < 0 ? undefined : b)); } catch { continue; }
      if (e.isSidechain || e.isMeta || !e.message || !['user', 'assistant'].includes(e.type)) { i = b < 0 ? raw.length : b; continue; }
      const txt = textOf(e.message.content).replace(/<([a-z-]+)>[\s\S]*?<\/\1>/g, ' ').replace(/\s+/g, ' ');
      const k = txt.toLowerCase().indexOf(q);
      i = b < 0 ? raw.length : b;
      if (k < 0) continue;
      hits++;
      if (!snippet) { snippet = (k > 50 ? '…' : '') + txt.slice(Math.max(0, k - 50), k + q.length + 70) + '…'; role = e.type; }
    }
    if (!hits) continue;
    const c = titles.get(sid);
    out.push({ sid, title: c?.title || path.basename(file, '.jsonl'), cwd: c?.cwd || '', mtime, hits, snippet, role, inQG: sessions.has(sid), owned: !!store.owned[sid], source: c?.source || 'cli', recent: Date.now() - mtime < 120e3 });
  }
  return { ok: true, results: out, ms: Date.now() - t0 };
}

// ---------- bilan du jour : ce que chaque session a fait (prompts, tokens, coût, fichiers) ----------
const reportCache = new Map();
function reportFor(day) {
  const d0 = new Date(day + 'T00:00:00'), t0 = +d0, t1 = t0 + 864e5;
  if (!(t0 > 0)) return { ok: false, error: 'date' };
  const titles = new Map(listConvs(2000).map(c => [c.sid, c]));
  const out = [];
  for (const [sid, { file, mtime }] of transcriptFiles()) {
    if (mtime < t0) continue;
    const key = file + '|' + day, size = (() => { try { return fs.statSync(file).size; } catch { return 0; } })();
    let r = reportCache.get(key);
    if (!r || r.size !== size) {
      const msgs = new Map(), files = new Set();
      let prompts = 0, tools = 0, first = 0, lastTs = 0, cwd = null;
      eachEntry(file, e => {
        const ts = Date.parse(e.timestamp) || 0;
        if (ts < t0 || ts >= t1 || e.isSidechain) return;
        if (!cwd && e.cwd) cwd = e.cwd;
        first = first || ts; lastTs = ts;
        const m = e.message;
        if (e.type === 'user' && !e.isMeta && m) {
          const c = m.content, t = typeof c === 'string' ? c : Array.isArray(c) ? (c.find(p => p.type === 'text') || {}).text || '' : '';
          if (t.trim() && !t.trim().startsWith('<') && !(Array.isArray(c) && c.some(p => p.type === 'tool_result'))) prompts++;
        }
        if (e.type === 'assistant' && m) {
          if (m.usage) msgs.set(m.id || e.uuid, { model: m.model, u: m.usage });
          if (Array.isArray(m.content)) for (const p of m.content) if (p.type === 'tool_use') {
            tools++;
            if (EDIT_TOOLS.has(p.name) && (p.input?.file_path || p.input?.notebook_path)) files.add(p.input.file_path || p.input.notebook_path);
          }
        }
      });
      const u = { tokens: 0, output: 0, cost: 0 };
      for (const { model, u: x } of msgs.values()) {
        u.tokens += (x.input_tokens || 0) + (x.output_tokens || 0) + (x.cache_creation_input_tokens || 0) + (x.cache_read_input_tokens || 0);
        u.output += x.output_tokens || 0; u.cost += costOf(model, x);
      }
      r = { size, data: first ? { prompts, tools, files: [...files].slice(0, 60), nFiles: files.size, replies: msgs.size, first, last: lastTs, cwd, ...u } : null };
      reportCache.set(key, r);
    }
    if (!r.data) continue;
    const c = titles.get(sid);
    out.push({ sid, title: c?.title || '', cwd: r.data.cwd || c?.cwd || '', name: sessions.get(sid)?.name || null, ...r.data });
  }
  out.sort((a, b) => b.cost - a.cost || b.last - a.last);
  return { ok: true, day, sessions: out };
}

// ---------- touche de dictée globale : marche même quand la fenêtre du jeu n'est pas au premier plan ----------
// Petit PowerShell qui surveille l'état de la touche (GetAsyncKeyState) et écrit D/U ; il s'arrête avec le jeu.
const HOTKEY_SCRIPT = [
  "Add-Type -Namespace Gotchi -Name Keys -MemberDefinition '[DllImport(\"user32.dll\")] public static extern short GetAsyncKeyState(int k);'",
  '$vk = [int]$env:GOTCHI_VK; $down = $false; $n = 0',
  'while ($true) {',
  '  $p = ([Gotchi.Keys]::GetAsyncKeyState($vk) -band 0x8000) -ne 0',
  '  if ($p -ne $down) { $down = $p; if ($p) { [Console]::WriteLine("D") } else { [Console]::WriteLine("U") } }',
  '  if (++$n % 80 -eq 0 -and -not (Get-Process -Id ([int]$env:GOTCHI_PPID) -ErrorAction SilentlyContinue)) { exit }',
  '  Start-Sleep -Milliseconds 25',
  '}',
].join('\n');
let hotkeyProc = null, hotkeyVk = 0;
function setHotkey(vk) {
  vk = Math.floor(+vk) || 0;
  if (vk === hotkeyVk && (hotkeyProc || !vk)) return;
  if (hotkeyProc) { try { hotkeyProc.kill(); } catch {} hotkeyProc = null; }
  hotkeyVk = vk;
  if (!vk || vk > 254) return;
  const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', HOTKEY_SCRIPT], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GOTCHI_VK: String(vk), GOTCHI_PPID: String(process.pid) },
  });
  let buf = '';
  p.stdout.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l === 'D' || l === 'U') broadcast({ hook: 'Hotkey', down: l === 'D' }); }
  });
  p.on('exit', () => { if (hotkeyProc === p) { hotkeyProc = null; hotkeyVk = 0; } });
  hotkeyProc = p;
}
process.on('exit', () => { try { hotkeyProc?.kill(); } catch {} });

// ---------- dictée : le jeu envoie un WAV, la reconnaissance vocale de Windows (hors ligne) le transcrit ----------
// (La dictée d'Edge passe par un service en ligne Microsoft qui échoue dans la fenêtre du jeu.)
// Script passé en -Command (pas de fichier .ps1, donc rien à changer côté sécurité PowerShell) ;
// le chemin du WAV arrive par une variable d'environnement.
const STT_SCRIPT = [
  'Add-Type -AssemblyName System.Speech',
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
  '$e = New-Object System.Speech.Recognition.SpeechRecognitionEngine (New-Object System.Globalization.CultureInfo $env:GOTCHI_LANG)',
  '$e.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))',
  '$e.SetInputToWaveFile($env:GOTCHI_WAV)',
  '$out = @(); while ($r = $e.Recognize()) { $out += $r.Text }',
  '$e.Dispose(); $out -join " "',
].join('; ');
// ---------- Whisper (whisper.cpp, local) : la dictée de qualité ; Windows reste en secours ----------
const WHISPER_DIR = path.join(HOOK_DIR, 'whisper');
const WHISPER_PORT = PORT + 2;
// Oriente le vocabulaire vers ce qu'on dit à un agent de code.
// (« Gotchi » : le mot de réveil du mode mains libres, pour que Whisper l'écrive bien.)
const WHISPER_PROMPT = "Gotchi, conversation en français avec un agent de code : bug, commit, fichier, composant, React, API, déploiement, test, refactor.";
const findExe = dir => {
  const walk = d => { for (const f of (() => { try { return fs.readdirSync(d, { withFileTypes: true }); } catch { return []; } })()) {
    const p = path.join(d, f.name);
    if (f.isDirectory()) { const r = walk(p); if (r) return r; } else if (f.name === 'whisper-server.exe') return p;
  } };
  return walk(dir);
};
const model = n => path.join(WHISPER_DIR, 'models', n);
// Par ordre de préférence : carte graphique NVIDIA (modèle q8_0, le plus précis), puis processeur.
const whisperVariants = () => [
  { label: 'GPU', exe: findExe(path.join(WHISPER_DIR, 'bin-cuda')), model: [model('ggml-large-v3-turbo-q8_0.bin'), model('ggml-large-v3-turbo-q5_0.bin')].find(f => fs.existsSync(f)) },
  { label: 'CPU', exe: findExe(path.join(WHISPER_DIR, 'bin')), model: [model('ggml-large-v3-turbo-q5_0.bin'), model('ggml-large-v3-turbo-q8_0.bin')].find(f => fs.existsSync(f)) },
].filter(v => v.exe && v.model);
let whisper = null, whisperReady = null, whisperLabel = null, whisperWarm = null;
const hasWhisper = () => whisperVariants().length > 0;
function launchWhisper(v) {
  return new Promise(resolve => {
    let log = '';
    const p = spawn(v.exe, ['-m', v.model, '--host', '127.0.0.1', '--port', String(WHISPER_PORT),
      '-l', 'auto', '-t', String(Math.max(4, Math.min(8, os.cpus().length))), '-nt'], { cwd: path.dirname(v.exe), windowsHide: true });
    p.stdout.on('data', d => { log = (log + d).slice(-4000); }); p.stderr.on('data', d => { log = (log + d).slice(-4000); });
    let dead = false;
    p.on('exit', () => { dead = true; if (whisper === p) { whisper = null; whisperReady = null; } });
    (async () => {
      for (let i = 0; i < 90; i++) { // jusqu'à 45 s pour charger le modèle
        if (dead) return resolve(null);
        try { const r = await fetch(`http://127.0.0.1:${WHISPER_PORT}/`); if (r.ok || r.status === 404) return resolve({ p, log: () => log }); } catch {}
        await new Promise(r => setTimeout(r, 500));
      }
      try { p.kill(); } catch {} resolve(null);
    })();
  });
}
function startWhisper() {
  if (whisperReady) return whisperReady;
  whisperReady = (async () => {
    for (const v of whisperVariants()) {
      const r = await launchWhisper(v);
      if (!r) { console.log(`Whisper ${v.label} ne démarre pas, essai suivant.`); continue; }
      // Version GPU : on vérifie qu'elle a vraiment trouvé la carte, sinon elle tourne en fait sur le processeur.
      const gpu = v.label === 'GPU' && /CUDA|cuda/.test(r.log()) && !/no CUDA devices|CUDA error|failed to initialize CUDA/i.test(r.log());
      whisper = r.p; whisperLabel = v.label === 'GPU' ? (gpu ? 'GPU' : 'CPU (version GPU sans carte détectée)') : 'CPU';
      console.log('Whisper prêt :', whisperLabel);
      // Échauffement : la 1re passe sur une carte récente compile ses calculs (~20 s). On la fait tout de suite,
      // sur 1 s de silence, pour que ta première vraie dictée soit instantanée.
      const silence = Buffer.alloc(44 + 32000); silence.write('RIFF', 0); silence.writeUInt32LE(36 + 32000, 4); silence.write('WAVEfmt ', 8);
      silence.writeUInt32LE(16, 16); silence.writeUInt16LE(1, 20); silence.writeUInt16LE(1, 22); silence.writeUInt32LE(16000, 24);
      silence.writeUInt32LE(32000, 28); silence.writeUInt16LE(2, 32); silence.writeUInt16LE(16, 34); silence.write('data', 36); silence.writeUInt32LE(32000, 40);
      whisperWarm = whisperTranscribe(silence, true).catch(() => {});
      return true;
    }
    whisperReady = null; return false;
  })();
  return whisperReady;
}
process.on('exit', () => { try { whisper?.kill(); } catch {} });
async function whisperTranscribe(wav, warmup) {
  if (!warmup && !(await startWhisper())) throw new Error('Whisper ne démarre pas');
  if (!warmup && whisperWarm) await whisperWarm; // laisse finir l'échauffement
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'dictee.wav');
  form.append('response_format', 'json'); form.append('language', store.lang === 'en' ? 'en' : 'fr'); form.append('temperature', '0');
  form.append('prompt', WHISPER_PROMPT);
  const r = await fetch(`http://127.0.0.1:${WHISPER_PORT}/inference`, { method: 'POST', body: form, signal: AbortSignal.timeout(60e3) });
  if (!r.ok) throw new Error(`Whisper HTTP ${r.status}`);
  const j = await r.json();
  // Whisper note le silence ou les bruits entre crochets/parenthèses : on les retire.
  let t = String(j.text || '').replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  // La même phrase peut aussi se coller à la fin d'une vraie dictée (le silence après avoir parlé).
  for (let prev; prev !== t;) { prev = t; t = t.replace(WHISPER_GHOST_TAIL, '').trim(); }
  return WHISPER_GHOSTS.test(t) ? '' : t;
}
// Phrases que Whisper invente sur du silence ou du bruit (génériques de sous-titres vus à l'entraînement).
const WHISPER_GHOSTS = /^(sous-titr(age|es|é)[^.]*|.*amara\.org.*|merci d'avoir regardé.*|thanks? (you )?for watching.*|subtitles by.*|♪+|\.+)$/i;
const WHISPER_GHOST_TAIL = /[\s.,…]*(sous-titr(age|es|é)s?\b[^.!?]*(radio-canada|amara\.org|st'? ?\d+|par [^.!?]*)|merci d'avoir regardé[^.!?]*|thanks? (you )?for watching[^.!?]*|subtitles by [^.!?]*)[.!?]*\s*$/i;
async function transcribe(wav) {
  if (hasWhisper()) {
    try { return { ok: true, text: await whisperTranscribe(wav), engine: 'whisper', where: whisperLabel }; }
    catch (e) { console.log('Whisper en échec, secours Windows :', e.message); }
  }
  return windowsTranscribe(wav);
}
function windowsTranscribe(wav) {
  return new Promise(resolve => {
    const file = path.join(os.tmpdir(), `gotchi-${crypto.randomBytes(6).toString('hex')}.wav`);
    fs.writeFileSync(file, wav);
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', STT_SCRIPT],
      { windowsHide: true, env: { ...process.env, GOTCHI_WAV: file, GOTCHI_LANG: store.lang === 'en' ? 'en-US' : 'fr-FR' } });
    let out = '', err = '';
    p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d);
    const end = r => { try { fs.unlinkSync(file); } catch {} resolve(r); };
    p.on('exit', code => end(code === 0 ? { ok: true, text: out.trim(), engine: 'windows' } : { ok: false, error: oneLine(err || `code ${code}`, 200) }));
    p.on('error', e => end({ ok: false, error: e.message }));
    setTimeout(() => { try { p.kill(); } catch {} }, 30e3);
  });
}
const readRaw = (req, max) => new Promise((resolve, reject) => {
  const parts = []; let n = 0;
  req.on('data', d => { n += d.length; if (n > max) { req.destroy(); reject(new Error('trop gros')); } else parts.push(d); });
  req.on('end', () => resolve(Buffer.concat(parts)));
  req.on('error', reject);
});

// ---------- HTTP ----------
const okHost = h => h === `127.0.0.1:${PORT}` || h === `localhost:${PORT}`;
const page = () => asset('index.html')
  .replace('</head>', `<script>window.GOTCHI=${JSON.stringify({ token: TOKEN })}</script></head>`);
const readBody = req => new Promise((resolve, reject) => {
  let b = '';
  req.on('data', d => { b += d; if (b.length > 1e6) req.destroy(); });
  req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (e) { reject(e); } });
  req.on('error', reject);
});
function json(res, code, o) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(o));
}

http.createServer(async (req, res) => {
  // Refuse tout ce qui ne vient pas de cette machine sous ce nom (anti DNS-rebinding).
  if (!okHost(req.headers.host)) return json(res, 403, { error: 'host' });
  const url = req.url.split('?')[0];
  try {
    if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(page());
    }
    if (req.method === 'GET' && url === '/icon.png') {
      // Icône de la fenêtre (onglet, barre des tâches) : embarquée dans l'exe, sinon générée par build.js.
      let b = null;
      try { b = sea ? Buffer.from(sea.getAsset('icon.png')) : fs.readFileSync(path.join(__dirname, 'build', 'icon.png')); } catch {}
      if (!b) return json(res, 404, {});
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=86400' });
      return res.end(b);
    }
    if (req.method === 'GET' && url === '/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      clients.add(res); hadClient = true; watchClients();
      sessions.forEach(updateUsage);
      send(res, { hook: 'snapshot', sessions: [...sessions.values()].map(pub), limits, hold: store.hold, rules: store.rules, rulesTerminal: store.rulesTerminal, settings: store.settings, schedules: schedPub(), missions: store.missions || [], wakeReady: wakeReady() });
      if (!limits || Date.now() - (limits.at || 0) > 30e3) pollLimits();
      req.on('close', () => { clients.delete(res); watchClients(); });
      return;
    }
    if (req.method === 'POST' && url === '/import') {
      if (req.headers['x-gotchi-token'] !== TOKEN) return json(res, 403, {});
      try { return json(res, 200, importClaudeAi(await readRaw(req, 800e6))); }
      catch (e) { return json(res, 200, { ok: false, error: e.message }); }
    }
    if (req.method === 'GET' && url === '/claudeai') {
      if (req.headers['x-gotchi-token'] !== TOKEN) return json(res, 403, {});
      const id = new URL(req.url, 'http://x').searchParams.get('id').replace(/^ai:/, '');
      return json(res, 200, { conv: loadAi().find(c => c.id === id) || null });
    }
    if (req.method === 'POST' && url === '/clientlog') {
      // Journal de la page (voix, erreurs) : utile pour diagnostiquer chez l'utilisateur.
      if (req.headers['x-gotchi-token'] !== TOKEN) return json(res, 403, {});
      const line = String(await readRaw(req, 4e3)).replace(/[\r\n]+/g, ' ').slice(0, 2000);
      const f = path.join(HOOK_DIR, 'client.log');
      try {
        if (fs.existsSync(f) && fs.statSync(f).size > 512e3) fs.renameSync(f, f + '.old');
        fs.appendFileSync(f, new Date().toISOString() + ' ' + line + '\n');
      } catch {}
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url === '/stt') {
      if (req.headers['x-gotchi-token'] !== TOKEN) return json(res, 403, {});
      return json(res, 200, await transcribe(await readRaw(req, 15e6)));
    }
    if (req.method === 'GET' && (url === '/changes' || url === '/diff' || url === '/report' || url === '/search')) {
      if (req.headers['x-gotchi-token'] !== TOKEN) return json(res, 403, {});
      const q = new URL(req.url, 'http://x').searchParams;
      if (url === '/changes') return json(res, 200, changesFor(q.get('sid')));
      if (url === '/diff') return json(res, 200, diffFor(q.get('sid'), q.get('file')));
      if (url === '/search') return json(res, 200, searchConvs(q.get('q')));
      return json(res, 200, reportFor(String(q.get('day') || '').slice(0, 10)));
    }
    if (req.method === 'GET' && url === '/folders') {
      if (req.headers['x-gotchi-token'] !== TOKEN) return json(res, 403, {});
      return json(res, 200, { folders: store.cwds.filter(d => { try { return fs.statSync(d).isDirectory(); } catch { return false; } }) });
    }
    if (req.method === 'GET' && url === '/convs') {
      if (req.headers['x-gotchi-token'] !== TOKEN) return json(res, 403, {});
      return json(res, 200, {
        convs: listConvs().map(({ file, ...c }) => ({
          ...c, inQG: sessions.has(c.sid), owned: !!store.owned[c.sid],
          recent: Date.now() - c.mtime < 120e3,
        })),
      });
    }
    if (req.method === 'GET' && url === '/chat') {
      if (req.headers['x-gotchi-token'] !== TOKEN) return json(res, 403, {});
      const s = sessions.get(new URL(req.url, 'http://x').searchParams.get('sid'));
      if (!s) return json(res, 200, { messages: [] });
      const sent = (store.log[s.sid] || []).map(m => ({ role: 'user', text: m.text, ts: m.ts, status: m.status }));
      return json(res, 200, { messages: [...readChat(s.transcript), ...sent].sort((a, b) => a.ts - b.ts) });
    }
    if (req.method === 'POST' && url === '/listen') {
      // Le hook d'écoute (en fond, après un tour) attend ici qu'on ait quelque chose à dire à Claude.
      if (req.headers.origin || req.headers['x-gotchi-token'] !== TOKEN) return json(res, 403, {});
      const b = await readBody(req), sid = b.session_id;
      if (!sid) return json(res, 200, { cancel: true });
      const s = getSession(sid, b.cwd);
      if (s.owned) return json(res, 200, { cancel: true }); // les agents de l'appli reçoivent leurs messages directement
      if (b.transcript_path && !s.transcript) s.transcript = b.transcript_path;
      endListen(s, { again: true });
      s.listen = { res, timer: setTimeout(() => endListen(s, { again: true }), 10 * 60e3) };
      req.on('close', () => { if (s.listen && s.listen.res === res) { clearTimeout(s.listen.timer); s.listen = null; broadcast({ hook: 'Listen', sid, on: false }); } });
      broadcast({ hook: 'Listen', sid, on: true });
      // Des messages attendaient déjà (envoyés avant que l'écoute démarre) : livraison tout de suite.
      setTimeout(() => wake(s), 300);
      return;
    }
    if (req.method === 'POST' && url === '/hook') {
      // Les hooks viennent de node (pas de header Origin) et connaissent le jeton.
      if (req.headers.origin || req.headers['x-gotchi-token'] !== TOKEN) return json(res, 403, {});
      return json(res, 200, await onHook(await readBody(req)));
    }
    if (req.method === 'POST' && url === '/action') {
      const origin = (req.headers.origin || '').replace(/^https?:\/\//, '');
      if (req.headers['x-gotchi-token'] !== TOKEN || (origin && !okHost(origin))) return json(res, 403, {});
      return json(res, 200, await onAction(await readBody(req))); // (certaines actions sont asynchrones)
    }
    json(res, 404, {});
  } catch (e) {
    json(res, 400, { error: String(e.message || e) });
  }
}).on('error', e => {
  // Déjà lancé : on rouvre juste une fenêtre sur l'instance existante.
  if (e.code === 'EADDRINUSE' && APP) { openWindow(); setTimeout(() => process.exit(0), 1500); }
  else throw e;
}).listen(PORT, '127.0.0.1', () => {
  fs.writeFileSync(path.join(HOOK_DIR, 'token'), TOKEN);
  console.log(`Agent·Gotchi : http://localhost:${PORT}  (fenêtre fouet : ${GRACE_MS / 1000}s)`);
  if (APP) { openWindow(); watchClients(); }
  if (hasWhisper()) startWhisper(); // chargé d'avance : la première dictée est déjà rapide
});

// ---------- mode appli : fenêtre Edge dédiée, arrêt quand on la ferme ----------
let hadClient = false, idleTimer = null;
function watchClients() {
  if (!APP) return;
  clearTimeout(idleTimer);
  if (!clients.size) idleTimer = setTimeout(() => process.exit(0), hadClient ? 8000 : 60000);
}
function openWindow() {
  const url = `http://localhost:${PORT}`;
  const edge = ['ProgramFiles(x86)', 'ProgramFiles'].map(k => process.env[k] && path.join(process.env[k], 'Microsoft', 'Edge', 'Application', 'msedge.exe')).find(p => p && fs.existsSync(p));
  const profile = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'AgentGotchi', 'window');
  const child = edge
    ? spawn(edge, [`--app=${url}`, `--user-data-dir=${profile}`, '--window-size=1400,950', '--no-first-run', '--no-default-browser-check',
      // Fenêtre en arrière-plan : la dictée (touche globale) et la voix doivent continuer à tourner.
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'], { detached: true, stdio: 'ignore' })
    : spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
}

setInterval(() => clients.forEach(c => c.write(': ping\n\n')), 20000);
// Sessions fermées sans SessionEnd (terminal tué...) : on les retire après 3 h sans nouvelles.
setInterval(() => {
  for (const s of sessions.values()) {
    if (!s.stopWait && Date.now() - s.last > 3 * 3600e3) {
      sessions.delete(s.sid);
      broadcast({ hook: 'SessionEnd', sid: s.sid, name: s.name });
    }
  }
}, 60e3);
