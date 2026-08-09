/**
 * Relay dei log del browser verso il backend (regola #7).
 *
 * La dashboard gira su un pannello a muro senza tastiera: la console del browser
 * non la apre nessuno. Senza questo relay, un errore JS sul kiosk è invisibile —
 * si vede solo il sintomo (schermo fermo o bianco) e mai la causa.
 *
 * Il server prefissa ogni riga con [BROWSER:LEVEL] e la scrive nello stesso file
 * giornaliero log/YYYY-MM-DD.txt del backend (regola #10), così il backend e il
 * frontend si leggono in ordine cronologico su un unico file.
 */
(function () {
  const ENDPOINT = '/log';

  // Cap client-side: la pagina resta aperta H24 e ogni riga finisce sulla SD card
  // del Raspberry. Il server ha il proprio cap sul body (4 KB → 413); questo evita
  // a monte di generare il traffico. Un loop di errori si auto-limita invece di
  // consumare la scheda.
  const MAX_PER_MINUTE = 60;
  let sent = 0;
  let windowStart = Date.now();

  function send(level, msg) {
    const now = Date.now();
    if (now - windowStart > 60000) { windowStart = now; sent = 0; }
    if (sent >= MAX_PER_MINUTE) { return; }
    sent += 1;
    // Troncato sotto il cap del server (4 KB → 413): meglio una riga tagliata.
    const payload = JSON.stringify({
      level: level,
      msg: String(msg).slice(0, 3500),
      url: location.pathname
    });
    try {
      // sendBeacon per primo: una fetch normale viene **annullata** se la pagina
      // si scarica o naviga prima che la richiesta parta, e si perdono proprio i
      // log del momento più interessante — l'errore che precede un reload.
      // Osservato come ERR_ABORTED sul caricamento della dashboard.
      // Il beacon è affidato al browser, che lo consegna anche a pagina morta.
      // È same-origin, quindi il cookie ef_token (HttpOnly) viaggia comunque; il
      // JS non legge il token, e proprio per questo non può essere esfiltrato.
      if (navigator.sendBeacon) {
        const blob = new Blob([payload], { type: 'application/json' });
        if (navigator.sendBeacon(ENDPOINT, blob)) { return; }
        // false = coda del browser piena: si ripiega sulla fetch qui sotto.
      }
      fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        // keepalive: sopravvive allo scaricamento della pagina. Limite 64 KB,
        // abbondante per un corpo che al massimo è 4 KB.
        keepalive: true,
        body: payload
      }).catch(function () { /* backend giù: la pagina non deve accorgersene */ });
    } catch (e) { /* un log non può mai rompere la dashboard */ }
  }

  function format(args) {
    return Array.prototype.map.call(args, function (a) {
      if (a instanceof Error) { return a.stack || (a.name + ': ' + a.message); }
      if (typeof a === 'object' && a !== null) {
        try { return JSON.stringify(a); } catch (e) { return '[oggetto non serializzabile]'; }
      }
      return String(a);
    }).join(' ');
  }

  // Prima veniva inoltrato solo console.error: warn e log restavano nel browser,
  // e sono proprio quelli che raccontano il contesto PRIMA dell'errore.
  ['error', 'warn', 'log'].forEach(function (level) {
    const original = console[level];
    console[level] = function () {
      send(level, format(arguments));
      original.apply(console, arguments);
    };
  });

  window.onerror = function (msg, url, line, col) {
    send('error', 'Uncaught: ' + msg + ' @ ' + url + ':' + line + ':' + col);
  };

  // Promise rifiutate senza .catch(): prima passavano del tutto inosservate, ed è
  // lì che finiscono i fallimenti delle fetch verso /data e verso il meteo.
  window.addEventListener('unhandledrejection', function (ev) {
    const r = ev.reason;
    send('error', 'UnhandledRejection: ' + ((r && (r.stack || r.message)) || String(r)));
  });
})();
