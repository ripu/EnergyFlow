/* ============================================================================
   EnergyFlow — bus condiviso e formattazione.
   Primo script della catena: crea window.EF, che gli altri popolano.

   Niente `import`: i moduli ES da file:// sono bloccati dalla CORS del
   browser, quindi la pagina non si aprirebbe più con un doppio click.
   `<script defer>` classico si comporta identico da file:// e dal server.
   ========================================================================= */
(function () {
    "use strict";

    var EF = window.EF || (window.EF = {});

    /* ------------------------------------------------------------------
       Bus di eventi minimale. Serve a tenere separati i moduli: app.js
       pubblica "data", charts/flow si iscrivono, e nessuno dei due deve
       conoscere l'altro.
       ------------------------------------------------------------------ */
    var handlers = {};

    EF.on = function (name, fn) {
        (handlers[name] || (handlers[name] = [])).push(fn);
    };

    EF.emit = function (name, payload) {
        var list = handlers[name];
        if (!list) { return; }
        for (var i = 0; i < list.length; i++) {
            try {
                list[i](payload);
            } catch (err) {
                // Un modulo che esplode non deve zittire gli altri: se il
                // grafico fallisce, il diagramma di flusso deve comunque
                // aggiornarsi. L'errore finisce nel log del server via
                // logger.js, quindi resta visibile senza aprire la console.
                console.error("EF.emit(" + name + ") — handler fallito:", err);
            }
        }
    };

    /* ------------------------------------------------------------------
       Accesso al DOM con cache: la pagina resta aperta per giorni e
       renderMetrics gira ogni 5 secondi. Rifare getElementById per ogni
       campo ad ogni ciclo è lavoro inutile su un Raspberry.
       ------------------------------------------------------------------ */
    var domCache = {};

    EF.el = function (id) {
        var hit = domCache[id];
        if (hit && hit.isConnected) { return hit; }
        hit = document.getElementById(id);
        domCache[id] = hit;
        return hit;
    };

    EF.text = function (id, value) {
        var node = EF.el(id);
        if (node && node.textContent !== value) {
            node.textContent = value;
        }
    };

    EF.clamp = function (v, lo, hi) {
        return v < lo ? lo : (v > hi ? hi : v);
    };

    /* Un numero utilizzabile, oppure null. Serve a distinguere "zero" da
       "non lo so": in questo dominio 0 W è un'informazione vera e non deve
       mai essere confusa con un campo assente. */
    EF.num = function (v) {
        if (v === null || v === undefined || v === "") { return null; }
        var n = typeof v === "number" ? v : Number(v);
        return isFinite(n) ? n : null;
    };

    /* ------------------------------------------------------------------
       Formattazione
       ------------------------------------------------------------------ */
    var IT = "it-IT";

    function dec(n, digits) {
        return n.toLocaleString(IT, {
            minimumFractionDigits: digits,
            maximumFractionDigits: digits
        });
    }

    EF.dec = dec;

    /* Potenza: sotto 1000 W resta in watt (la casa consuma "710 W", non
       "0,7 kW"), sopra passa in kW con una o due decimali secondo l'entità.
       Restituisce le parti separate perché l'unità va in un <span> proprio,
       più piccolo del numero. */
    EF.power = function (watt) {
        var w = EF.num(watt);
        if (w === null) { return { value: "--", unit: "kW", abs: null }; }
        var a = Math.abs(w);
        if (a < 1000) {
            return { value: String(Math.round(w)), unit: "W", abs: a };
        }
        var kw = w / 1000;
        return { value: dec(kw, Math.abs(kw) < 10 ? 2 : 1), unit: "kW", abs: a };
    };

    /* Versione a riga singola, per etichette e testo alternativo. */
    EF.powerText = function (watt) {
        var p = EF.power(watt);
        return p.value === "--" ? "non disponibile" : p.value + " " + p.unit;
    };

    EF.energy = function (kwh) {
        var v = EF.num(kwh);
        if (v === null) { return "--"; }
        return dec(v, Math.abs(v) < 10 ? 2 : 1);
    };

    EF.percent = function (v, digits) {
        var n = EF.num(v);
        if (n === null) { return "--"; }
        return dec(n, digits === undefined ? 0 : digits);
    };

    EF.temp = function (v) {
        var n = EF.num(v);
        return n === null ? "--" : dec(n, 1);
    };

    /* Durata in minuti -> "4 h 20 min". Sopra le 48 ore il numero smette di
       essere una stima utile: diventa "oltre 2 giorni". */
    EF.duration = function (minutes) {
        var m = EF.num(minutes);
        if (m === null || m < 0) { return "--"; }
        if (m > 2880) { return "oltre 2 giorni"; }
        var h = Math.floor(m / 60);
        var mm = Math.round(m % 60);
        if (h === 0) { return mm + " min"; }
        if (mm === 0) { return h + " h"; }
        return h + " h " + mm + " min";
    };

    /* Secondi -> "34 s fa". Per il chip di freschezza. */
    EF.age = function (seconds) {
        var s = EF.num(seconds);
        if (s === null) { return "età sconosciuta"; }
        return EF.since(s) + " fa";
    };

    /* Secondi -> "34 s" / "4 min" / "2 h", senza "fa".
       Serve dopo la preposizione "da": "fermi da 4 min fa" non è italiano. */
    EF.since = function (seconds) {
        var s = EF.num(seconds);
        if (s === null) { return "un tempo imprecisato"; }
        if (s < 60) { return Math.round(s) + " s"; }
        if (s < 3600) { return Math.round(s / 60) + " min"; }
        return Math.round(s / 3600) + " h";
    };

    EF.clock = function (date) {
        return date.toLocaleTimeString(IT, { hour: "2-digit", minute: "2-digit" });
    };

    EF.clockSec = function (date) {
        return date.toLocaleTimeString(IT, {
            hour: "2-digit", minute: "2-digit", second: "2-digit"
        });
    };

    EF.dateLong = function (date) {
        return date.toLocaleDateString(IT, {
            weekday: "long", day: "numeric", month: "long"
        });
    };

    EF.isoDay = function (date) {
        var d = date || new Date();
        var m = String(d.getMonth() + 1).padStart(2, "0");
        var day = String(d.getDate()).padStart(2, "0");
        return d.getFullYear() + "-" + m + "-" + day;
    };

    /* Minuti dalla mezzanotte: l'asse x di tutti i grafici della giornata. */
    EF.minutesOfDay = function (date) {
        return date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60;
    };

    EF.hhmmToMinutes = function (hhmm) {
        if (!hhmm || typeof hhmm !== "string") { return null; }
        var parts = hhmm.split(":");
        if (parts.length < 2) { return null; }
        var h = parseInt(parts[0], 10);
        var m = parseInt(parts[1], 10);
        if (!isFinite(h) || !isFinite(m)) { return null; }
        return h * 60 + m;
    };

    /* ------------------------------------------------------------------
       Codici meteo WMO -> icona + descrizione.
       Una sola tabella. Nella pagina vecchia ne esistevano due copie e la
       seconda era codice morto mai chiamato: due fonti di verità di cui
       una silenziosamente sbagliata.
       ------------------------------------------------------------------ */
    var WMO = {
        0: ["☀", "sereno"],
        1: ["🌤", "poco nuvoloso"],
        2: ["⛅", "parzialmente nuvoloso"],
        3: ["☁", "coperto"],
        45: ["🌫", "nebbia"], 48: ["🌫", "nebbia con brina"],
        51: ["🌦", "pioviggine debole"], 53: ["🌦", "pioviggine"], 55: ["🌦", "pioviggine intensa"],
        56: ["🌧", "pioviggine gelata"], 57: ["🌧", "pioviggine gelata intensa"],
        61: ["🌧", "pioggia debole"], 63: ["🌧", "pioggia"], 65: ["🌧", "pioggia forte"],
        66: ["🌧", "pioggia gelata"], 67: ["🌧", "pioggia gelata forte"],
        71: ["🌨", "neve debole"], 73: ["🌨", "neve"], 75: ["🌨", "neve forte"],
        77: ["🌨", "granelli di neve"],
        80: ["🌦", "rovesci deboli"], 81: ["🌦", "rovesci"], 82: ["⛈", "rovesci forti"],
        85: ["🌨", "rovesci di neve"], 86: ["🌨", "rovesci di neve forti"],
        95: ["⛈", "temporale"], 96: ["⛈", "temporale con grandine"],
        99: ["⛈", "temporale forte con grandine"]
    };

    EF.weatherCode = function (code) {
        var hit = WMO[code];
        return {
            icon: hit ? hit[0] : "·",
            label: hit ? hit[1] : "condizioni non note"
        };
    };

    /* ------------------------------------------------------------------
       Throttle su requestAnimationFrame. Usato dal ResizeObserver del
       diagramma: un resize genera decine di eventi al secondo e ricalcolare
       la geometria ad ognuno bloccherebbe il rendering su un Pi.
       ------------------------------------------------------------------ */
    EF.rafThrottle = function (fn) {
        var pending = false;
        var lastArgs = null;
        return function () {
            lastArgs = arguments;
            if (pending) { return; }
            pending = true;
            requestAnimationFrame(function () {
                pending = false;
                fn.apply(null, lastArgs);
            });
        };
    };

    /* Namespace SVG: creare elementi SVG con createElement invece di
       createElementNS produce nodi che il browser non disegna mai. */
    EF.SVGNS = "http://www.w3.org/2000/svg";

    EF.svg = function (tag, attrs) {
        var node = document.createElementNS(EF.SVGNS, tag);
        if (attrs) {
            for (var k in attrs) {
                if (Object.prototype.hasOwnProperty.call(attrs, k) &&
                    attrs[k] !== null && attrs[k] !== undefined) {
                    node.setAttribute(k, attrs[k]);
                }
            }
        }
        return node;
    };
})();
