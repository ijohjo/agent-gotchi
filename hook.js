// Agent·Gotchi — hook Claude Code.
// Transmet chaque événement au serveur local du jeu. Ne bloque jamais Claude :
// jeu fermé ou erreur => sortie 0 silencieuse.
//
// Avec --listen (hook Stop lancé en « asyncRewake ») : tourne en fond une fois que Claude a fini
// et attend un message du jeu. S'il en arrive un, il l'écrit sur stderr et sort avec le code 2 :
// Claude Code réveille alors la session avec ce message (terminal comme app de bureau).
const http = require('http'), fs = require('fs'), path = require('path');

const PORT = +process.env.GOTCHI_PORT || 5178;
const LISTEN = process.argv.includes('--listen');
const readToken = () => { try { return fs.readFileSync(path.join(process.env.GOTCHI_HOOK_DIR || __dirname, 'token'), 'utf8').trim(); } catch { return null; } };
function post(route, body, token, timeout, done) {
  const req = http.request({
    host: '127.0.0.1', port: PORT, path: route, method: 'POST', timeout,
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-gotchi-token': token },
  }, res => {
    let out = '';
    res.on('data', d => out += d);
    res.on('end', () => { let o = null; try { o = JSON.parse(out); } catch {} done(res.statusCode === 200 ? o : null, res.statusCode); });
  });
  req.on('error', () => done(null, 0));
  req.on('timeout', () => { req.destroy(); });
  req.end(body);
}

let input = '';
process.stdin.on('data', d => input += d);
process.stdin.on('end', () => {
  let ev;
  try { ev = JSON.parse(input); } catch { process.exit(0); }
  if (LISTEN) return listen(ev);
  const token = readToken();
  if (!token) process.exit(0);
  const body = JSON.stringify(ev);
  // Stop peut attendre un coup de fouet, PreToolUse ta permission (agents de l'appli) :
  // on laisse le temps au serveur de répondre.
  const wait = { Stop: 170000, PreToolUse: 590000 }[ev.hook_event_name] || 1500;
  post('/hook', body, token, wait, o => {
    if (o && Object.keys(o).length) process.stdout.write(JSON.stringify(o));
    process.exit(0);
  });
});

// Écoute longue : le serveur garde la requête ouverte jusqu'à un message (ou ~10 min, puis on relance).
// Jeu fermé : on réessaie un moment (il peut être relancé), puis on abandonne.
function listen(ev) {
  const body = JSON.stringify({ session_id: ev.session_id, cwd: ev.cwd, transcript_path: ev.transcript_path });
  const until = Date.now() + 12 * 3600e3;
  let fails = 0;
  const again = () => {
    if (Date.now() > until) process.exit(0);
    const token = readToken(); // change à chaque lancement du jeu
    if (!token) return setTimeout(again, 30e3);
    post('/listen', body, token, 11 * 60e3, (o, code) => {
      if (o && o.message) { process.stderr.write(o.message); process.exit(2); }
      if (o && o.cancel) process.exit(0); // Claude a repris la main (nouveau message de l'utilisateur…)
      if (code === 0 || code === 403) { if (++fails > 120) process.exit(0); return setTimeout(again, 30e3); }
      fails = 0; again();
    });
  };
  again();
}
