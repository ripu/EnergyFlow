/* ============================================================================
   EnergyFlow — nucleo dell'applicazione.
   Ultimo script della catena: quando parte, format/charts/flow/keys hanno già
   pubblicato le loro API su window.EF.
   ========================================================================= */
(function () {
    "use strict";

    var EF = window.EF;
    var root = document.documentElement;

    /* ==================================================================
       COSTANTI DI ESERCIZIO
       ================================================================== */
    var POLL_MS = 5000;           // cadenza normale
    var FETCH_TIMEOUT_MS = 8000;  // vedi fetchJSON: una fetch appesa non rigetta mai
    var AGE_WARN_S = 15;          // oltre: banner ambra
    var AGE_DEAD_S = 60;          // oltre: i numeri spariscono
    var WEATHER_MS = 15 * 60 * 1000;
    var SUMMARY_MS = 30 * 1000;   // cadenza della regione aria-live
    var SAMPLE_MS = 60 * 1000;    // un punto al minuto nella curva del giorno
    var MAX_SAMPLES = 1500;
    /* Risincronizzazione della curva col file sul server. Il backend scrive un
       punto al minuto su log/energy/YYYY-MM-DD.csv: quello è il dato che
       sopravvive ai riavvii, e su un pannello acceso per giorni è la versione
       giusta se il browser ha perso qualche minuto (schermo spento, tab in
       background, wifi caduto). Un giro ogni 15 minuti costa una richiesta. */
    var HISTORY_SYNC_MS = 15 * 60 * 1000;

    var LS_THEME = "ef.theme";
    var LS_MODE = "ef.mode";
    var LS_DAY = "ef.day.";

    /* ==================================================================
       STATO
       ================================================================== */
    var S = {
        data: null,        // ultimo payload valido
        lastOkMs: 0,       // quando è arrivato (orologio del client)
        lastError: null,
        fetching: false,
        autoOn: true,
        pollTimer: null,   // vedi startAuto/stopAuto
        uiConfig: null,
        weather: null,
        samples: [],
        lastSampleMs: 0,
        peakW: 0,          // picco osservato: fondoscala degli archi (vedi scaleW)
        historyAvailable: false,  // deciso da bootstrapHistory() all'avvio
        samplesSource: "local",   // "local" (localStorage) | "server" (log/energy)
        histResolutionS: 60,      // risoluzione dichiarata dall'ultima risposta
        histRetentionDays: 90,    // dichiarata dal backend: retention dei minuti
        /* Stato della sezione Storico.
           `anchor` è un giorno QUALSIASI dentro il periodo mostrato, sempre
           normalizzato al primo giorno del periodo (lunedì / 1° del mese /
           1° gennaio): così scorrere avanti e indietro non deriva mai — da
           un 31 gennaio, "+1 mese" ripetuto sul giorno grezzo finirebbe il
           3 marzo. `detailFrom` è il primo giorno per cui esiste il dettaglio
           al minuto: NON è una costante scritta a mano, la scopre probe(). */
        hist: {
            period: "week",
            anchor: null,
            detailFrom: null,
            probe: "idle"   // idle | running | done
        },
        phase: "init"      // init | ok | warn | stale | dead
    };

    /* ==================================================================
       MODALITÀ (kiosk / compatta)
       Priorità: ?mode=... > localStorage > media query.
       L'URL vince su tutto: è il modo di forzare una vista per una prova
       senza sporcare lo stato persistito del pannello (regola #4).
       ================================================================== */
    var kioskMQ = window.matchMedia("(orientation: portrait) and (min-height: 1400px)");

    function urlParam(name) {
        try {
            return new URLSearchParams(window.location.search).get(name);
        } catch (e) { return null; }
    }

    function resolveMode() {
        var forced = urlParam("mode");
        if (forced === "kiosk" || forced === "compact") { return forced; }
        var saved = null;
        try { saved = localStorage.getItem(LS_MODE); } catch (e) { saved = null; }
        if (saved === "kiosk" || saved === "compact") { return saved; }
        return kioskMQ.matches ? "kiosk" : "compact";
    }

    function applyMode(mode) {
        if (root.getAttribute("data-mode") === mode) { return; }
        root.setAttribute("data-mode", mode);
        var btn = EF.el("btnKiosk");
        if (btn) { btn.setAttribute("aria-pressed", mode === "kiosk" ? "true" : "false"); }
        /* La modalità cambia la dimensione dei dischi e dei font via CSS: il
           diagramma e i grafici devono rimisurarsi, ma il ResizeObserver del
           contenitore non scatta se il contenitore non cambia dimensione. */
        EF.emit("layout");
        /* force: passando da kiosk a compatta la sezione Storico torna
           visibile dopo essere stata saltata del tutto, quindi il suo
           contenuto va ricostruito anche se i dati non sono cambiati. */
        renderCharts(true);
    }

    function toggleMode() {
        var next = root.getAttribute("data-mode") === "kiosk" ? "compact" : "kiosk";
        try { localStorage.setItem(LS_MODE, next); } catch (e) { /* modalità privata */ }
        applyMode(next);
    }

    /* ==================================================================
       TEMA — chiaro di giorno, scuro dopo il tramonto.
       Un pannello bianco a muro, di notte, in salotto, è una lampada.
       Il tasto `t` cicla auto -> chiaro -> scuro -> auto: senza il ritorno
       ad "auto" un override notturno resterebbe incollato per sempre e la
       mattina dopo il pannello sarebbe nero in pieno sole.
       ================================================================== */
    function savedTheme() {
        try { return localStorage.getItem(LS_THEME); } catch (e) { return null; }
    }

    function isNightNow() {
        var now = new Date();
        var mins = EF.minutesOfDay(now);
        var sr = S.weather && S.weather.sunriseMin;
        var ss = S.weather && S.weather.sunsetMin;
        if (sr === null || sr === undefined || ss === null || ss === undefined) {
            // Nessun dato di alba/tramonto: ripiego onesto su orari fissi.
            return mins < 7 * 60 || mins >= 20 * 60;
        }
        return mins < sr || mins >= ss;
    }

    function applyTheme() {
        var manual = savedTheme();
        if (manual === "light" || manual === "dark") {
            root.setAttribute("data-theme", manual);
        } else {
            root.setAttribute("data-theme", isNightNow() ? "dark" : "light");
        }
        // Il colore della barra di sistema segue il tema effettivo.
        var meta = document.querySelector('meta[name="theme-color"]');
        if (meta) {
            meta.setAttribute("content",
                root.getAttribute("data-theme") === "dark" ? "#0d1117" : "#e9eef5");
        }
    }

    function cycleTheme() {
        var cur = savedTheme();
        var next = cur === null ? "light" : (cur === "light" ? "dark" : null);
        try {
            if (next === null) { localStorage.removeItem(LS_THEME); }
            else { localStorage.setItem(LS_THEME, next); }
        } catch (e) { /* ignora */ }
        applyTheme();
        renderCharts();
    }

    /* ==================================================================
       RETE
       ================================================================== */
    /* AbortController con timeout esplicito.
       Senza, una fetch verso un backend che accetta la connessione e poi non
       risponde più resta appesa PER SEMPRE: la promise non rigetta, il
       catch non scatta, e il polling si ferma senza che nessuno se ne
       accorga. È il motivo per cui esiste anche il watchdog indipendente. */
    function fetchJSON(url, timeoutMs) {
        var ctrl = typeof AbortController === "function" ? new AbortController() : null;
        var timer = setTimeout(function () {
            if (ctrl) { ctrl.abort(); }
        }, timeoutMs || FETCH_TIMEOUT_MS);

        return fetch(url, {
            credentials: "same-origin",
            cache: "no-store",
            signal: ctrl ? ctrl.signal : undefined
        }).then(function (res) {
            clearTimeout(timer);
            return res.json().catch(function () { return null; }).then(function (body) {
                return { ok: res.ok, status: res.status, body: body };
            });
        }, function (err) {
            clearTimeout(timer);
            throw err;
        });
    }

    function pull() {
        if (S.fetching) { return Promise.resolve(); }
        S.fetching = true;

        return fetchJSON("/data").then(function (r) {
            S.fetching = false;

            if (!r.ok) {
                // 503 = poller in avvio o inverter irraggiungibile: il corpo
                // porta il motivo, e va mostrato invece di un generico errore.
                S.lastError = (r.body && (r.body.error || r.body.last_error)) ||
                    ("errore HTTP " + r.status);
                console.warn("[data] " + r.status + " — " + S.lastError);
                evaluate();
                return;
            }
            if (!r.body || !r.body.derived) {
                S.lastError = "risposta senza campo `derived`";
                console.warn("[data] payload inatteso");
                evaluate();
                return;
            }

            S.data = r.body;
            S.lastOkMs = Date.now();
            S.lastError = (r.body.meta && r.body.meta.last_error) || null;
            sample(r.body);
            render();
            evaluate();
        }, function (err) {
            S.fetching = false;
            S.lastError = (err && err.name === "AbortError")
                ? "nessuna risposta entro " + Math.round(FETCH_TIMEOUT_MS / 1000) + " s"
                : "backend irraggiungibile";
            console.warn("[data] fetch fallita: " + S.lastError);
            evaluate();
        });
    }

    /* ---- Polling idempotente ----------------------------------------
       Il vecchio toggleAuto() creava un setInterval SENZA fermare quello
       precedente, e il bootstrap ne aveva già creato uno: premere "Auto"
       due volte raddoppiava la frequenza di interrogazione dell'inverter,
       tre volte la triplicava. Con start/stop idempotenti il timer attivo
       è sempre al massimo uno. */
    function startAuto() {
        stopAuto();
        S.autoOn = true;
        S.pollTimer = setInterval(pull, POLL_MS);
        syncAutoButton();
    }

    function stopAuto() {
        if (S.pollTimer !== null) {
            clearInterval(S.pollTimer);
            S.pollTimer = null;
        }
        S.autoOn = false;
        syncAutoButton();
    }

    function toggleAuto() {
        if (S.pollTimer !== null) { stopAuto(); } else { startAuto(); }
    }

    function syncAutoButton() {
        var b = EF.el("btnAuto");
        if (b) { b.setAttribute("aria-pressed", S.pollTimer !== null ? "true" : "false"); }
    }

    /* ==================================================================
       WATCHDOG — indipendente dal ciclo di fetch.
       Gira ogni secondo e guarda l'orologio, non le promise. Se il fetch
       smette del tutto di tornare (rete morta, tab sospesa, promise appesa)
       è l'unica cosa che se ne accorge: il polling non produce più eventi,
       quindi non può denunciare se stesso.
       ================================================================== */
    /* Due età diverse, e la distinzione conta:
         clientAge — da quanto NOI non riceviamo una risposta riuscita
         serverAge — quanto è vecchio il dato che il backend ci ha dato

       Non vanno fuse in un massimo, come faceva la prima stesura: un backend
       vivo che serve dalla cache un dato fermo da 4 minuti finiva
       classificato "BACKEND OFFLINE", che è falso e manda a cercare il
       guasto nel posto sbagliato. Il backend risponde benissimo — è il
       poller Modbus che è morto. Sono due guasti diversi e vanno detti
       diversamente. */
    function ages() {
        return {
            client: S.lastOkMs ? (Date.now() - S.lastOkMs) / 1000 : null,
            server: S.data && S.data.meta ? EF.num(S.data.meta.age_s) : null
        };
    }

    function effectiveAgeS() {
        var a = ages();
        if (a.client === null) { return null; }
        return a.server === null ? a.client : Math.max(a.client, a.server);
    }

    function evaluate() {
        var a = ages();
        var age = effectiveAgeS();
        var serverStale = !!(S.data && S.data.meta && S.data.meta.stale);
        var phase;

        if (a.client === null) {
            // Nessuna risposta riuscita dall'avvio.
            phase = S.lastError ? "dead" : "init";
        } else if (a.client > AGE_DEAD_S) {
            // Il backend non risponde più a NOI: questo sì è offline.
            phase = "dead";
        } else if (serverStale || (a.server !== null && a.server > AGE_DEAD_S)) {
            // Risponde, ma il dato è congelato: poller giù, non backend giù.
            phase = "stale";
        } else if (age > AGE_WARN_S) {
            phase = "warn";
        } else {
            phase = "ok";
        }

        S.phase = phase;
        root.setAttribute("data-stale", (phase === "stale" || phase === "dead") ? "true" : "false");
        root.setAttribute("data-offline", phase === "dead" ? "true" : "false");

        renderFreshness(phase, age);
    }

    function renderFreshness(phase, age) {
        var chip = EF.el("freshness");
        var staleBanner = EF.el("staleBanner");
        var errBanner = EF.el("errorBanner");
        var offline = EF.el("offlineHero");
        if (!chip) { return; }

        var label, chipState;

        if (phase === "init") {
            label = "in attesa dei dati…";
            chipState = "init";
        } else if (phase === "ok") {
            label = "in diretta";
            chipState = "ok";
        } else if (phase === "warn") {
            label = "aggiornati " + EF.age(age);
            chipState = "warn";
        } else if (phase === "stale") {
            label = "fermi da " + EF.since(age);
            chipState = "error";
        } else {
            label = "nessun dato";
            chipState = "error";
        }

        chip.setAttribute("data-state", chipState);
        EF.text("freshnessText", label);

        // Banner ambra: 15-60 s.
        if (staleBanner) {
            var showWarn = (phase === "warn" || phase === "stale");
            staleBanner.hidden = !showWarn;
            if (showWarn) {
                EF.text("staleBannerText", phase === "stale"
                    ? "Dati fermi da " + EF.since(age) + ": il backend risponde ma non li aggiorna"
                    : "Dati vecchi di " + Math.round(age) + " s");
            }
        }

        // 503 o meta.last_error: il testo dell'errore, non un generico "ops".
        if (errBanner) {
            var showErr = !!S.lastError && phase !== "dead";
            errBanner.hidden = !showErr;
            if (showErr) { EF.text("errorBannerText", String(S.lastError)); }
        }

        // Eroe rosso: i valori spariscono del tutto.
        if (offline) {
            offline.hidden = phase !== "dead";
            if (phase === "dead") {
                var detail = S.lastOkMs
                    ? "ultimo dato valido: " + EF.clockSec(new Date(S.lastOkMs))
                    : "nessun dato ricevuto dall'avvio";
                if (S.lastError) { detail += " — " + S.lastError; }
                EF.text("offlineDetail", detail);
            }
        }
    }

    /* ==================================================================
       LETTURA DEL PAYLOAD
       Il client NON ricalcola le grandezze: si fida di `derived`.
       La vecchia deriveMetrics() rifaceva i conti del backend a partire dai
       registri grezzi, e per giunta era divergente — leggeva il registro 21
       e il 38, che il backend non usa più. Due formule per lo stesso numero
       significa che prima o poi mostrano cose diverse, e nessuno sa quale
       delle due creda.
       ================================================================== */
    function D(key) {
        if (!S.data || !S.data.derived) { return null; }
        return EF.num(S.data.derived[key]);
    }

    function M(key) {
        if (!S.data || !S.data.measured) { return null; }
        return EF.num(S.data.measured[key]);
    }

    function Q(field) {
        if (!S.data || !S.data.quality) { return null; }
        return S.data.quality[field] || null;
    }

    /* Preferire un campo MISURATO all'equivalente derivato non è ricalcolare:
       è scegliere la fonte migliore fra quelle che il backend dichiara. */
    function solarW() {
        var total = M("pv_total_power_w");
        if (total !== null) { return total; }
        /* Somma delle stringhe: il backend espone pv1/pv2 come `measured`,
           mentre solar_power_w è `derived` (ricavato dal bilancio
           casa/batteria/rete). A parità di risultato vale di più la misura,
           e la somma di due misure resta una misura — non è un ricalcolo
           della logica del backend. */
        var a = M("pv1_power_w"), b = M("pv2_power_w");
        if (a !== null && b !== null) { return a + b; }
        return D("solar_power_w");
    }

    /* Capacità della batteria. Prima era 12000 Wh scritti nel codice, e la
       configurazione dell'impianto veniva ignorata: su una batteria da 5 kWh
       l'autonomia stimata era più del doppio del vero. */
    function batteryCapacityWh() {
        // Il backend la chiama battery_nominal_capacity_wh; il nome più corto
        // resta accettato per non dipendere da una singola chiave.
        var measured = M("battery_nominal_capacity_wh");
        if (measured === null) { measured = M("battery_capacity_wh"); }
        if (measured !== null && measured > 0) { return measured; }
        var cfg = S.uiConfig && S.uiConfig.battery ? EF.num(S.uiConfig.battery.capacity_kwh) : null;
        if (cfg !== null && cfg > 0) { return cfg * 1000; }
        return null; // niente valore inventato: l'autonomia mostrerà "--"
    }

    function minSoc() {
        var cfg = S.uiConfig && S.uiConfig.battery ? EF.num(S.uiConfig.battery.min_soc) : null;
        return cfg === null ? 10 : cfg;
    }

    /* Fondoscala degli archi del diagramma (solo spessore e velocità, mai un
       numero mostrato). Se la potenza nominale dell'impianto è configurata la
       si usa; altrimenti — ed è il caso reale, `capacity_kwp` è null nella
       configurazione dell'utente — NON si inventa una targa da 6 kW: si usa
       il picco effettivamente osservato oggi, con un minimo di 2 kW perché a
       impianto fermo non diventi tutto spesso uguale. Così le proporzioni
       raccontano questo impianto, non uno immaginario. */
    function scaleW() {
        var kwp = S.uiConfig && S.uiConfig.solar ? EF.num(S.uiConfig.solar.capacity_kwp) : null;
        if (kwp !== null && kwp > 0) { return kwp * 1000; }
        return Math.max(2000, S.peakW);
    }

    function notePeak() {
        [solarW(), D("home_load_w"), D("battery_power_w"), D("grid_flow_w")]
            .forEach(function (v) {
                var n = EF.num(v);
                if (n !== null && Math.abs(n) > S.peakW) { S.peakW = Math.abs(n); }
            });
        S.samples.forEach(function (p) {
            if (p.pv > S.peakW) { S.peakW = p.pv; }
            if (p.home > S.peakW) { S.peakW = p.home; }
        });
    }

    /* ==================================================================
       RESA
       ================================================================== */
    function setValue(id, parts, quality) {
        var node = EF.el(id);
        if (!node) { return; }
        node.textContent = parts.value;
        node.classList.toggle("skeleton", parts.value === "--");
        var suspect = quality === "suspect";
        node.classList.toggle("suspect", suspect);
        if (suspect) {
            node.title = "Valore sospetto: il backend lo segnala come non attendibile.";
        } else if (node.title) {
            node.removeAttribute("title");
        }
    }

    function render() {
        if (!S.data) { return; }
        notePeak();

        var solar = solarW();
        var home = D("home_load_w");
        var batt = D("battery_power_w");
        var grid = D("grid_flow_w");
        var soc = D("battery_percent");

        // ---- eroe ----
        var ps = EF.power(solar);
        setValue("heroSolar", ps, Q("pv_total_power_w") || Q("solar_power_w"));
        EF.text("heroSolarUnit", ps.unit);
        /* Forma compatta: per esteso ("stringa 1 2,38 kW - stringa 2 1,80 kW")
           a 28px andava a capo lasciando un "kW" orfano sulla seconda riga. */
        var pv1 = M("pv1_power_w"), pv2 = M("pv2_power_w");
        EF.text("heroSolarSub", (pv1 !== null && pv2 !== null)
            ? "stringhe " + EF.power(pv1).value + " + " + EF.powerText(pv2)
            : (D("daily_energy_kwh") !== null
                ? "oggi " + EF.energy(D("daily_energy_kwh")) + " kWh"
                : " "));

        var ph = EF.power(home);
        setValue("heroHome", ph, Q("home_load_w"));
        EF.text("heroHomeUnit", ph.unit);
        /* Sotto "Casa" ci va una frase SU CASA.
           Prima ci finiva gridPhrase(), cioè lo stato della rete: sotto un
           consumo di 2,55 kW si leggeva "in equilibrio", che non vuol dire
           niente riferito alla casa e per giunta duplicava l'informazione
           già presente sul nodo Rete del diagramma. */
        EF.text("heroHomeSub", homePhrase(home, grid));

        // ---- nodi del diagramma ----
        EF.text("nodePv", EF.powerText(solar));
        EF.text("nodeHome", EF.powerText(home));
        EF.text("nodeBattery", EF.powerText(batt === null ? null : Math.abs(batt)));
        EF.text("nodeGrid", EF.powerText(grid === null ? null : Math.abs(grid)));

        var inv = M("inverter_power_signed_w");
        if (inv === null) { inv = D("inverter_power_w"); }
        EF.text("nodeInverter", EF.powerText(inv === null ? null : Math.abs(inv)));

        EF.text("nodeBatteryNote", batteryPhrase(batt, soc));
        EF.text("nodeGridNote", gridPhrase(grid));
        EF.text("nodePvNote", D("daily_energy_kwh") !== null
            ? EF.energy(D("daily_energy_kwh")) + " kWh oggi" : "");
        EF.text("nodeHomeNote", "");
        EF.text("nodeInverterNote", M("run_mode") !== null ? "modo " + M("run_mode") : "");

        // Nodi spenti: il disco si smorza ma resta al suo posto.
        markIdle("pv", solar);
        markIdle("home", home);
        markIdle("battery", batt);
        markIdle("grid", grid);
        markIdle("inverter", inv);

        EF.flow.update({
            solar: solar, home: home, battery: batt, grid: grid, scaleW: scaleW()
        });

        renderBattery(soc, batt);
        renderAlt(solar, home, batt, grid, soc);
        renderTech();
        renderCharts();
    }

    function markIdle(node, value) {
        var el = document.querySelector('[data-node="' + node + '"]');
        if (!el) { return; }
        var v = EF.num(value);
        el.setAttribute("data-idle", (v === null || Math.abs(v) < 20) ? "true" : "false");
    }

    function gridPhrase(grid) {
        var g = EF.num(grid);
        if (g === null) { return " "; }
        if (Math.abs(g) < 20) { return "in equilibrio"; }
        return g > 0 ? "preleva dalla rete" : "immette in rete";
    }

    /* Quanta parte del consumo di adesso è coperta dall'impianto (solare +
       batteria) invece che dalla rete. È la domanda che si fa davvero chi
       guarda il consumo di casa: non "quanto consumo", che è già il numero
       grande sopra, ma "lo sto pagando?". */
    function homePhrase(home, grid) {
        var h = EF.num(home);
        var g = EF.num(grid);
        if (h === null) { return " "; }
        if (h < 20) { return "casa ferma"; }
        if (g === null) { return " "; }

        var fromGrid = Math.max(0, g);
        var share = EF.clamp((1 - fromGrid / h) * 100, 0, 100);
        if (share >= 99.5) { return "tutta dall'impianto"; }
        if (share <= 0.5) { return "tutta dalla rete"; }
        return "coperta al " + EF.percent(share) + "% dall'impianto";
    }

    function batteryPhrase(batt, soc) {
        var b = EF.num(batt);
        var status = S.data && S.data.status ? S.data.status.battery : null;
        if (status === "charging") { return "in carica"; }
        if (status === "discharging") { return "in scarica"; }
        if (status === "idle") { return "a riposo"; }
        if (b === null) { return ""; }
        if (Math.abs(b) < 20) { return "a riposo"; }
        return b > 0 ? "in carica" : "in scarica";
    }

    function renderBattery(soc, batt) {
        var pct = EF.num(soc);
        var fill = EF.el("socFill");
        var meter = EF.el("socMeter");
        var floor = EF.el("socFloor");

        if (fill) {
            fill.style.width = (pct === null ? 0 : EF.clamp(pct, 0, 100)) + "%";
            var lvl = pct === null ? "" : (pct <= minSoc() + 5 ? "critical" : (pct < 35 ? "low" : "ok"));
            fill.setAttribute("data-level", lvl);
        }
        if (meter && pct !== null) {
            meter.setAttribute("aria-valuenow", String(Math.round(pct)));
            meter.setAttribute("aria-valuetext", Math.round(pct) + " per cento");
        }
        if (floor) {
            var ms = minSoc();
            floor.hidden = !(ms > 0);
            floor.style.left = EF.clamp(ms, 0, 100) + "%";
            floor.setAttribute("data-label", "min " + Math.round(ms) + "%");
        }

        setValue("socValue", { value: EF.percent(pct) }, Q("battery_percent"));
        var socEl = EF.el("socValue");
        if (socEl && pct !== null) {
            socEl.innerHTML = "";
            socEl.appendChild(document.createTextNode(EF.percent(pct)));
            var sm = document.createElement("small");
            sm.textContent = "%";
            socEl.appendChild(sm);
        }

        withUnit("sohValue", M("battery_soh_pct"), "%", 0);
        withUnit("battTemp", M("battery_temp_c"), "°C", 1);
        withUnit("invTemp", M("inverter_temp_c"), "°C", 1);

        EF.text("batteryStatus", batteryPhrase(batt, soc) +
            (M("battery_voltage_v") !== null || D("battery_voltage_v") !== null
                ? " · " + EF.dec(M("battery_voltage_v") !== null
                    ? M("battery_voltage_v") : D("battery_voltage_v"), 1) + " V"
                : ""));

        renderRuntime(pct, batt);
    }

    function withUnit(id, value, unit, digits) {
        var node = EF.el(id);
        if (!node) { return; }
        node.innerHTML = "";
        var v = EF.num(value);
        node.appendChild(document.createTextNode(v === null ? "--" : EF.dec(v, digits)));
        var sm = document.createElement("small");
        sm.textContent = unit;
        node.appendChild(sm);
    }

    /* Autonomia: bullet chart con il marker dell'alba.
       La domanda vera non è "quante ore restano" ma "arrivo all'alba?".
       Un marker rende la risposta una lettura di posizione invece che una
       sottrazione a mente. */
    function renderRuntime(soc, batt) {
        var fill = EF.el("runtimeFill");
        var marker = EF.el("runtimeSunrise");
        var capacity = batteryCapacityWh();
        var b = EF.num(batt);
        var pct = EF.num(soc);

        var minutes = null;
        if (capacity !== null && pct !== null && b !== null && b < -20) {
            var usableWh = capacity * Math.max(0, pct - minSoc()) / 100;
            minutes = (usableWh / Math.abs(b)) * 60;
        }

        EF.text("runtimeValue", minutes === null
            ? (b !== null && b > 20 ? "in carica" : "--")
            : EF.duration(minutes));

        // Minuti mancanti all'alba, per il marker.
        var toSunrise = null;
        if (S.weather && S.weather.sunriseMin !== null && S.weather.sunriseMin !== undefined) {
            var now = EF.minutesOfDay(new Date());
            toSunrise = S.weather.sunriseMin - now;
            if (toSunrise < 0) { toSunrise += 1440; }
        }

        // Fondoscala: deve contenere sia l'autonomia sia l'alba, altrimenti
        // uno dei due esce dal grafico e il confronto sparisce.
        var span = Math.max(minutes || 0, toSunrise || 0, 60) * 1.15;

        if (fill) {
            fill.style.width = minutes === null ? "0%"
                : EF.clamp((minutes / span) * 100, 0, 100).toFixed(1) + "%";
        }
        if (marker) {
            marker.hidden = toSunrise === null;
            if (toSunrise !== null) {
                marker.style.left = EF.clamp((toSunrise / span) * 100, 0, 100).toFixed(1) + "%";
            }
        }
    }

    /* Equivalente testuale del diagramma: stessi numeri, per chi non vede
       le curve. Non è una versione ridotta — è la stessa informazione. */
    function renderAlt(solar, home, batt, grid, soc) {
        EF.text("flowAltText",
            "Solare " + EF.powerText(solar) + ", casa " + EF.powerText(home) +
            ", batteria al " + EF.percent(soc) + " per cento, " +
            gridPhrase(grid) + ".");

        var body = EF.el("flowAltTable");
        if (!body) { return; }
        body.innerHTML = "";
        [
            ["Fotovoltaico", solar, "produzione"],
            ["Casa", home, "consumo"],
            ["Batteria", batt, batteryPhrase(batt, soc)],
            ["Rete", grid, gridPhrase(grid)]
        ].forEach(function (row) {
            var tr = document.createElement("tr");
            [row[0], EF.powerText(row[1] === null ? null : Math.abs(row[1])), row[2]]
                .forEach(function (cell) {
                    var td = document.createElement("td");
                    td.textContent = cell;
                    tr.appendChild(td);
                });
            body.appendChild(tr);
        });
    }

    /* ==================================================================
       PANNELLO TECNICO — registri, valori e origine del dato
       ================================================================== */
    function renderTech() {
        var panel = EF.el("techPanel");
        if (!panel || panel.hidden) { return; }
        var body = EF.el("techBody");
        if (!body || !S.data) { return; }

        var rows = [];
        function push(group, obj) {
            if (!obj) { return; }
            Object.keys(obj).sort().forEach(function (k) {
                rows.push([k, obj[k], (S.data.quality && S.data.quality[k]) || group]);
            });
        }
        push("derived", S.data.derived);
        push("measured", S.data.measured);

        body.innerHTML = "";
        rows.forEach(function (r) {
            var tr = document.createElement("tr");

            var name = document.createElement("td");
            name.textContent = r[0];
            tr.appendChild(name);

            var val = document.createElement("td");
            val.className = "num tnum";
            var n = EF.num(r[1]);
            val.textContent = n === null ? String(r[1]) : EF.dec(n, Math.abs(n) < 100 ? 2 : 0);
            if (r[2] === "suspect") { val.className += " suspect"; }
            tr.appendChild(val);

            var q = document.createElement("td");
            var badge = document.createElement("span");
            badge.className = "q-badge";
            badge.setAttribute("data-q", r[2]);
            badge.textContent = r[2];
            q.appendChild(badge);
            tr.appendChild(q);

            body.appendChild(tr);
        });

        var meta = S.data.meta || {};
        EF.text("techMeta", [
            meta.source ? "sorgente " + meta.source : null,
            meta.map_version ? "mappa " + meta.map_version : null,
            meta.device && meta.device.model ? meta.device.model : null,
            "letture " + (meta.count || "?")
        ].filter(Boolean).join(" · "));
    }

    /* ==================================================================
       CURVA DELLA GIORNATA
       Due sorgenti, in quest'ordine di fiducia:

       1. il server — GET /history/day/<oggi>, che legge il file al minuto
          scritto dal poller. È la sorgente vera: sopravvive al riavvio del
          Raspberry e alla ricarica della pagina, quindi la curva è già
          completa nell'istante in cui il pannello si accende.
       2. localStorage — il vecchio buffer, un punto al minuto accumulato dal
          browser. Non è stato tolto: resta la rete di sicurezza per quando
          l'endpoint non risponde (storico disabilitato in config, disco pieno,
          versione del backend più vecchia della pagina). Meglio una curva
          parziale che una card vuota.

       Fra un minuto consolidato e il successivo la curva viene comunque
       estesa dal polling live, così l'ultimo tratto non resta indietro di un
       minuto rispetto ai numeri grandi in alto.
       ================================================================== */
    function dayKey(date) { return LS_DAY + EF.isoDay(date || new Date()); }

    function loadSamples() {
        try {
            var raw = localStorage.getItem(dayKey());
            S.samples = raw ? JSON.parse(raw) : [];
            if (!Array.isArray(S.samples)) { S.samples = []; }
        } catch (e) { S.samples = []; }
        pruneOldDays();
    }

    /* Un pannello acceso per mesi accumulerebbe una chiave al giorno finché
       localStorage non esplode (e allora ogni setItem lancia, silenziosamente
       rompendo anche il salvataggio del tema). Si tengono 7 giorni. */
    function pruneOldDays() {
        try {
            var keep = {};
            for (var d = 0; d < 7; d++) {
                keep[LS_DAY + EF.isoDay(new Date(Date.now() - d * 86400000))] = true;
            }
            var doomed = [];
            for (var i = 0; i < localStorage.length; i++) {
                var k = localStorage.key(i);
                if (k && k.indexOf(LS_DAY) === 0 && !keep[k]) { doomed.push(k); }
            }
            doomed.forEach(function (k) { localStorage.removeItem(k); });
        } catch (e) { /* localStorage non disponibile: si prosegue senza */ }
    }

    function sample(payload) {
        var now = Date.now();
        if (now - S.lastSampleMs < SAMPLE_MS && S.samples.length) { return; }
        S.lastSampleMs = now;

        var d = payload.derived || {};
        var m = payload.measured || {};
        var pv = EF.num(m.pv_total_power_w);
        if (pv === null) { pv = EF.num(d.solar_power_w); }

        var t = Math.round(EF.minutesOfDay(new Date()));
        var last = S.samples.length ? S.samples[S.samples.length - 1] : null;

        /* Mezzanotte: l'asse x riparte da zero. Senza questo controllo la curva
           di ieri e quella di oggi finivano nello stesso array e il tracciato
           tornava indietro, disegnando un ghirigoro sopra la giornata. */
        if (last && t < last.t) {
            S.samples = [];
            S.samplesSource = "local";
            last = null;
            syncDayFromServer();
        }
        /* Punto già coperto da un minuto consolidato dal server: non si
           duplica. Succede subito dopo l'adozione dei dati del backend. */
        if (last && t <= last.t) { return; }

        S.samples.push({
            t: t,
            pv: pv === null ? 0 : Math.round(pv),
            home: Math.round(EF.num(d.home_load_w) || 0),
            soc: Math.round(EF.num(d.battery_percent) || 0)
        });
        if (S.samples.length > MAX_SAMPLES) {
            S.samples.splice(0, S.samples.length - MAX_SAMPLES);
        }
        try { localStorage.setItem(dayKey(), JSON.stringify(S.samples)); } catch (e) { /* pieno */ }
    }

    /* I punti del backend hanno più campi di quelli che servono ai grafici
       (grid, batt): si normalizza qui, una volta, invece di far conoscere ai
       grafici due formati diversi. */
    function normalizeServerSamples(list) {
        if (!Array.isArray(list)) { return []; }
        var out = [];
        list.forEach(function (p) {
            var t = EF.num(p && p.t);
            if (t === null) { return; }
            out.push({
                t: t,
                pv: Math.round(EF.num(p.pv) || 0),
                home: Math.round(EF.num(p.home) || 0),
                soc: Math.round(EF.num(p.soc) || 0)
            });
        });
        return out;
    }

    /* Adotta la curva del server tenendo in coda i punti locali più recenti
       dell'ultimo minuto consolidato: il file arriva fino al minuto scorso,
       il polling ha già i secondi successivi, e buttarli farebbe arretrare la
       curva ad ogni risincronizzazione. */
    function adoptServerSamples(list) {
        var pts = normalizeServerSamples(list);
        if (!pts.length) { return false; }
        var lastT = pts[pts.length - 1].t;
        var tail = S.samples.filter(function (p) { return p.t > lastT; });
        S.samples = pts.concat(tail);
        S.samplesSource = "server";
        return true;
    }

    function syncDayFromServer() {
        if (!S.historyAvailable) { return Promise.resolve(false); }
        return fetchJSON("/history/day/" + EF.isoDay(new Date())).then(function (r) {
            if (!r.ok || !r.body) { return false; }
            S.histResolutionS = r.body.resolution_s || 60;
            var adopted = adoptServerSamples(r.body.samples);
            if (adopted) { renderCharts(); }
            return adopted;
        }, function () { return false; });
    }

    function renderCharts(force) {
        /* Il messaggio di vuoto deve dire la verità su QUALE vuoto è: senza
           storico sul server la curva dipende davvero dalla pagina aperta, con
           lo storico attivo si tratta solo del primo minuto ancora da
           consolidare. Due situazioni diverse, due attese diverse. */
        var detail = null;
        if (S.samples.length < 2) {
            detail = S.historyAvailable
                ? "Il server tiene un punto al minuto: la prima riga del giorno arriva entro un minuto."
                : "La curva si costruisce mentre la pagina resta aperta: un punto al minuto.";
        }

        var today = todayEnergyModel();
        EF.charts.renderDay(EF.el("dayChart"), S.samples, { emptyDetail: detail });
        EF.charts.renderSoc(EF.el("socChart"), S.samples);
        EF.charts.renderEnergy(EF.el("energyBars"), today);
        EF.charts.renderMeters(EF.el("meters"), today ? today.indices : null);
        renderHistory(force === true);
    }

    /* ==================================================================
       MODELLO DELL'ENERGIA — una sola decomposizione, due consumatori
       ==================================================================
       Le barre impilate e i due indici (autosufficienza, autoconsumo)
       leggevano gli stessi numeri con due formule scritte in due file
       diversi: due fonti di verità per la stessa grandezza, cioè nessuna.
       Qui la decomposizione sta UNA volta e serve sia la giornata sia un
       periodo di 229 giorni — è il motivo per cui la vista storica non ha
       dovuto riscrivere gli indici, li chiama.

       Due interi VERI, mai una somma di grandezze scorrelate:
         Produzione = autoconsumata + esportata
         Consumo    = dall'impianto + dalla rete (+ EPS)

       Il consumo si può DIRE (un contatore che lo misura, come home_kwh
       negli aggregati giornalieri) oppure RICAVARE (autoconsumo + prelievo,
       come per la giornata in corso, dove un contatore di casa non esiste).
       Nei due casi cambia la sorgente, non la formula: `fromPlant` resta
       "quel che non è venuto dalla rete", quindi i segmenti sommano sempre
       esattamente all'intero dichiarato in testa alla barra.
       ================================================================== */
    function energyModel(spec) {
        var production = EF.num(spec.production);
        if (production === null) { return null; }

        var exported = Math.max(0, EF.num(spec.exported) || 0);
        var imported = Math.max(0, EF.num(spec.imported) || 0);
        var eps = Math.max(0, EF.num(spec.eps) || 0);
        var selfUsed = Math.max(0, production - exported);

        var consumption = EF.num(spec.consumption);
        if (consumption === null) { consumption = selfUsed + imported + eps; }
        var fromPlant = Math.max(0, consumption - imported - eps);

        var m = {
            production: production,
            exported: exported,
            imported: imported,
            eps: eps,
            selfUsed: selfUsed,
            consumption: consumption,
            fromPlant: fromPlant,
            charge: Math.max(0, EF.num(spec.charge) || 0),
            discharge: Math.max(0, EF.num(spec.discharge) || 0),
            producedLabel: spec.producedLabel || "Prodotta",
            consumedLabel: spec.consumedLabel || "Consumata",
            productionNote: spec.productionNote || null,
            consumptionNote: null,
            indices: []
        };

        m.consumptionNote = "batteria +" + EF.energy(m.charge) +
            " / −" + EF.energy(m.discharge) + " kWh";

        if (consumption > 0) {
            m.indices.push({
                label: "Autosufficienza",
                value: EF.clamp((1 - imported / consumption) * 100, 0, 100),
                role: "battery"
            });
        }
        if (production > 0) {
            m.indices.push({
                label: "Autoconsumo del prodotto",
                value: EF.clamp((selfUsed / production) * 100, 0, 100),
                role: "solar"
            });
        }
        if (!m.indices.length) { m.indices = null; }
        return m;
    }

    /* La giornata in corso: `yield_kwh` è l'uscita AC dell'inverter,
       `solar_kwh` la resa DC dei pannelli. Sono due punti di misura della
       stessa energia, non due addendi — sommarli conterebbe due volte lo
       stesso sole — quindi la produzione è la sola AC e la DC va nella nota. */
    function todayEnergyModel() {
        var t = S.data && S.data.energy && S.data.energy.today ? S.data.energy.today : null;
        if (!t) { return null; }
        var dc = EF.num(t.solar_kwh);
        return energyModel({
            production: t.yield_kwh,
            exported: t.grid_export_kwh,
            imported: t.grid_import_kwh,
            eps: t.eps_kwh,
            charge: t.battery_charge_kwh,
            discharge: t.battery_discharge_kwh,
            productionNote: dc !== null ? EF.energy(dc) + " kWh dai pannelli (DC)" : null
        });
    }

    /* ==================================================================
       STORICO — DUE LIVELLI DI DATO, UNA SOLA SEZIONE
       ==================================================================
       Il backend espone lo storico a due risoluzioni, con COPERTURE DIVERSE,
       ed è tutta qui la difficoltà di questa sezione:

         /history/day/<data>      punti al minuto. Li scrive il pannello di
                                  casa, quindi esistono solo da quando quella
                                  persistenza è accesa (pochi giorni).
         /history/range/<a>/<b>   un aggregato per giorno. Arriva anche
                                  dall'importazione dal portale del
                                  costruttore: 229 giorni, otto mesi.

       Prima la sezione navigava SOLO giorno per giorno su /history/day: ogni
       data precedente all'inizio della registrazione locale rispondeva 404 e
       la card diceva "nessun dato" — con otto mesi di storia sul disco, a due
       centimetri di distanza, che nessuna schermata mostrava.

       La regola che tiene insieme i due livelli è una sola: **"nessun dato" si
       dice solo quando non c'è NIENTE.** Se di un giorno manca il minuto ma
       esiste l'aggregato, si mostra l'aggregato e si dice che è un riepilogo
       e perché il dettaglio non c'è. Un buco vero e un dettaglio mancante
       sono due fatti diversi e non possono avere lo stesso messaggio.
       ================================================================== */

    /* ---- Calendario -------------------------------------------------
       Tutte le date vivono a MEZZOGIORNO. Con la mezzanotte, la notte del
       cambio d'ora la differenza fra due date vale 23 o 25 ore e
       l'arrotondamento sbaglia di un giorno: un bug che si manifesta due
       volte l'anno e che nessuno riesce a riprodurre a marzo. */
    function noon(d) {
        var x = new Date(d.getTime());
        x.setHours(12, 0, 0, 0);
        return x;
    }

    function todayNoon() { return noon(new Date()); }

    function addDays(d, n) {
        var x = new Date(d.getTime());
        x.setDate(x.getDate() + n);
        return noon(x);
    }

    function parseDay(iso) {
        if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) { return null; }
        var d = new Date(iso + "T12:00:00");
        return isNaN(d.getTime()) ? null : d;
    }

    function dayDiff(a, b) {
        return Math.round((a.getTime() - b.getTime()) / 86400000);
    }

    function pad2(n) { return String(n).padStart(2, "0"); }

    function monthKey(d) { return d.getFullYear() + "-" + pad2(d.getMonth() + 1); }

    /* ---- Periodi ----------------------------------------------------
       L'ancora è SEMPRE il primo giorno del periodo (lunedì, 1° del mese,
       1° gennaio). Normalizzarla non è cosmetica: sommare mesi a un giorno
       grezzo fa derivare la navigazione (dal 31 gennaio, "+1 mese" cade il
       3 marzo, e da lì in poi si salta un mese ogni tanto). */
    function normalizeAnchor(period, anchor) {
        var a = noon(anchor);
        if (period === "week") {
            var dow = (a.getDay() + 6) % 7;   // lunedì = 0
            return addDays(a, -dow);
        }
        if (period === "month") { return noon(new Date(a.getFullYear(), a.getMonth(), 1)); }
        if (period === "year") { return noon(new Date(a.getFullYear(), 0, 1)); }
        return a;
    }

    function periodRange(period, anchor) {
        var a = normalizeAnchor(period, anchor);
        if (period === "week") { return { from: a, to: addDays(a, 6) }; }
        if (period === "month") {
            return { from: a, to: noon(new Date(a.getFullYear(), a.getMonth() + 1, 0)) };
        }
        if (period === "year") {
            return { from: a, to: noon(new Date(a.getFullYear(), 11, 31)) };
        }
        return { from: a, to: a };
    }

    function shiftAnchor(period, anchor, dir) {
        var a = normalizeAnchor(period, anchor);
        if (period === "week") { return addDays(a, 7 * dir); }
        if (period === "month") { return noon(new Date(a.getFullYear(), a.getMonth() + dir, 1)); }
        if (period === "year") { return noon(new Date(a.getFullYear() + dir, 0, 1)); }
        return addDays(a, dir);
    }

    var PERIOD_WORD = { day: "Giorno", week: "Settimana", month: "Mese", year: "Anno" };
    var PERIOD_ORDER = ["day", "week", "month", "year"];

    function fmtDate(d, opts) { return d.toLocaleDateString("it-IT", opts); }

    function rangeLabel(period, range) {
        if (period === "day") {
            return EF.isoDay(range.from) +
                (dayDiff(range.from, todayNoon()) === 0 ? " · oggi" : "");
        }
        if (period === "year") { return String(range.from.getFullYear()); }
        if (period === "month") { return fmtDate(range.from, { month: "long", year: "numeric" }); }
        // Settimana: due estremi, e il mese si ripete solo se cambia davvero.
        var sameMonth = range.from.getMonth() === range.to.getMonth();
        return sameMonth
            ? range.from.getDate() + "–" + fmtDate(range.to, { day: "numeric", month: "short", year: "numeric" })
            : fmtDate(range.from, { day: "numeric", month: "short" }) + " – " +
            fmtDate(range.to, { day: "numeric", month: "short", year: "numeric" });
    }

    /* ==================================================================
       ARCHIVIO DEGLI AGGREGATI GIORNALIERI
       ==================================================================
       Una mappa data → riga, con la finestra già interrogata. Serve perché
       renderHistory() gira ad ogni poll: senza, la sezione chiederebbe lo
       stesso mese dodici volte al minuto.

       Gli ESTREMI della navigazione escono da qui, non da una costante: il
       primo giorno è quello che l'archivio dichiara restituendo la sua riga
       più vecchia, e finché non lo sappiamo il pulsante "precedente" resta
       acceso e la prossima richiesta allarga la finestra all'indietro.
       ================================================================== */
    var DAILY_MAX_SPAN = 366;    // limite dichiarato da /history/range
    var DAILY_BOOT_DAYS = 366;   // finestra della prima richiesta

    var daily = {
        rows: {},        // "YYYY-MM-DD" -> {pv_kwh, home_kwh, ...}
        from: null,      // Date: estremo inferiore della finestra interrogata
        to: null,        // Date: estremo superiore
        firstDay: null,  // "YYYY-MM-DD": primo giorno dell'archivio, quando è noto
        version: 0,      // cambia ad ogni merge: firma per il ridisegno
        pending: false
    };

    function fetchDaily(from, to) {
        var url = "/history/range/" + EF.isoDay(from) + "/" + EF.isoDay(to);
        return fetchJSON(url).then(function (r) {
            if (!r.ok || !r.body || !Array.isArray(r.body.days)) {
                console.warn("[storico] range " + url + " → " + r.status);
                return false;
            }
            var days = r.body.days;
            days.forEach(function (row) {
                if (row && row.date) { daily.rows[row.date] = row; }
            });
            daily.version++;

            /* Il primo giorno dell'archivio si DEDUCE: se abbiamo chiesto da
               `from` e la riga più vecchia che torna è più recente, in mezzo
               non c'è niente — quindi l'archivio comincia lì e il pulsante
               "precedente" ha un fondo. Se invece la prima riga coincide con
               `from`, potrebbe esserci altro prima e non si conclude nulla. */
            if (days.length) {
                if (days[0].date > EF.isoDay(from)) { daily.firstDay = days[0].date; }
            } else if (Object.keys(daily.rows).length) {
                daily.firstDay = Object.keys(daily.rows).sort()[0];
            }
            console.log("[storico] aggregati " + EF.isoDay(from) + " → " + EF.isoDay(to) +
                ": " + days.length + " giorni" +
                (daily.firstDay ? " (archivio dal " + daily.firstDay + ")" : ""));
            return true;
        }, function (err) {
            console.warn("[storico] range fallito: " + (err && err.message ? err.message : err));
            return false;
        });
    }

    /* Estende la finestra interrogata fino a coprire [from, to]. Le richieste
       restano sotto il tetto dei 366 giorni imposto dall'endpoint. */
    function ensureDaily(from, to) {
        if (!S.historyAvailable) { return Promise.resolve(false); }
        /* Il controllo sta QUI, prima di toccare daily.from/daily.to.
           Più in basso — dopo aver già allargato la finestra e messo in coda
           il lavoro — una seconda chiamata durante una richiesta in volo
           marcava come "coperto" un intervallo che nessuno aveva chiesto, e
           quel buco non si sarebbe più richiuso: la finestra risultava
           interrogata, quindi nessuno ci sarebbe più tornato. */
        if (daily.pending) { return Promise.resolve(false); }
        var today = todayNoon();
        if (to > today) { to = today; }
        if (from > to) { from = to; }

        var jobs = [];
        if (daily.from === null) {
            jobs.push([clampSpan(from, to), to]);
            daily.from = from;
            daily.to = to;
        } else {
            if (from < daily.from) {
                // Niente richieste inutili sotto il primo giorno noto.
                var floor = daily.firstDay ? parseDay(daily.firstDay) : null;
                var wanted = (floor && from < floor) ? floor : from;
                if (wanted < daily.from) {
                    var end = addDays(daily.from, -1);
                    jobs.push([clampSpan(wanted, end), end]);
                    daily.from = wanted;
                }
            }
            if (to > daily.to) {
                var start = addDays(daily.to, 1);
                jobs.push([start, to]);
                daily.to = to;
            }
        }

        if (!jobs.length) { return Promise.resolve(false); }
        daily.pending = true;
        return Promise.all(jobs.map(function (j) { return fetchDaily(j[0], j[1]); }))
            .then(function (res) {
                daily.pending = false;
                var got = res.some(Boolean);
                if (got) { renderHistory(true); }
                return got;
            }, function () {
                daily.pending = false;
                return false;
            });
    }

    function clampSpan(from, to) {
        return dayDiff(to, from) + 1 > DAILY_MAX_SPAN ? addDays(to, -(DAILY_MAX_SPAN - 1)) : from;
    }

    /* La giornata IN CORSO non è ancora in daily.csv: il consolidamento
       avviene a fine giornata. Senza una riga per oggi la vista "settimana"
       mostrerebbe sempre un buco proprio sul giorno che si guarda per primo.

       La si ricava dai contatori giornalieri dell'inverter — che coprono
       tutta la giornata, non solo i minuti registrati dal pannello — usando
       per la produzione lo STESSO campo che il rollup di mezzanotte
       scriverà (`solar_kwh`), così la colonna di oggi non cambia natura
       quando domani diventa una riga vera. È marcata `partial`: il tooltip
       lo dice, e la nota sotto il grafico anche. */
    function todayAggregate() {
        var iso = EF.isoDay(new Date());
        var t = S.data && S.data.energy && S.data.energy.today ? S.data.energy.today : null;
        if (!t) { return daily.rows[iso] || null; }

        var m = todayEnergyModel();
        var pv = EF.num(t.solar_kwh);
        if (pv === null) { pv = D("daily_energy_kwh"); }
        if (pv === null && m) { pv = m.production; }
        if (pv === null) { return daily.rows[iso] || null; }

        return {
            date: iso,
            pv_kwh: pv,
            home_kwh: m ? m.consumption : null,
            import_kwh: EF.num(t.grid_import_kwh) || 0,
            export_kwh: EF.num(t.grid_export_kwh) || 0,
            charge_kwh: EF.num(t.battery_charge_kwh) || 0,
            discharge_kwh: EF.num(t.battery_discharge_kwh) || 0,
            peak_pv_w: null,
            min_soc: null,
            partial: true
        };
    }

    function rowFor(iso) {
        if (iso === EF.isoDay(new Date())) { return todayAggregate(); }
        return daily.rows[iso] || null;
    }

    /* ---- Bande ------------------------------------------------------
       Una banda è una colonna del grafico, una riga della tabella nascosta
       e una lettura del tooltip: un solo posto in cui un pezzo di calendario
       diventa numeri. Per l'anno le bande sono i mesi, sommati qui sul
       client — l'endpoint dà i giorni e non serve chiedergli altro. */
    function bandFromRow(row) {
        return {
            pv: EF.num(row.pv_kwh) || 0,
            home: EF.num(row.home_kwh) || 0,
            imp: EF.num(row.import_kwh) || 0,
            exp: EF.num(row.export_kwh) || 0,
            chg: EF.num(row.charge_kwh) || 0,
            dis: EF.num(row.discharge_kwh) || 0
        };
    }

    function emptyBand() { return { pv: 0, home: 0, imp: 0, exp: 0, chg: 0, dis: 0 }; }

    function buildBands(period, range) {
        var today = todayNoon();
        var last = range.to > today ? today : range.to;
        var bands = [];

        if (period === "year") {
            var year = range.from.getFullYear();
            var lastMonth = (year === today.getFullYear()) ? today.getMonth() : 11;
            for (var mi = 0; mi <= lastMonth; mi++) {
                var first = noon(new Date(year, mi, 1));
                var stop = noon(new Date(year, mi + 1, 0));
                if (stop > last) { stop = last; }
                var acc = emptyBand();
                var covered = 0;
                for (var d = first; d <= stop; d = addDays(d, 1)) {
                    var row = rowFor(EF.isoDay(d));
                    if (!row) { continue; }
                    var b = bandFromRow(row);
                    acc.pv += b.pv; acc.home += b.home; acc.imp += b.imp;
                    acc.exp += b.exp; acc.chg += b.chg; acc.dis += b.dis;
                    covered++;
                }
                bands.push({
                    key: year + "-" + pad2(mi + 1),
                    tick: fmtDate(first, { month: "short" }),
                    label: fmtDate(first, { month: "long", year: "numeric" }),
                    pv: acc.pv, home: acc.home, imp: acc.imp,
                    exp: acc.exp, chg: acc.chg, dis: acc.dis,
                    days: covered,
                    missing: covered === 0,
                    partial: mi === today.getMonth() && year === today.getFullYear()
                });
            }
            return bands;
        }

        for (var day = range.from; day <= last; day = addDays(day, 1)) {
            var iso = EF.isoDay(day);
            var r = rowFor(iso);
            var v = r ? bandFromRow(r) : emptyBand();
            bands.push({
                key: iso,
                tick: period === "month"
                    ? String(day.getDate())
                    : fmtDate(day, { weekday: "short", day: "numeric" }),
                label: fmtDate(day, { weekday: "long", day: "numeric", month: "long" }),
                pv: v.pv, home: v.home, imp: v.imp, exp: v.exp, chg: v.chg, dis: v.dis,
                days: r ? 1 : 0,
                missing: !r,
                partial: !!(r && r.partial)
            });
        }
        return bands;
    }

    function sumBands(bands) {
        var acc = emptyBand();
        var covered = 0, partial = false;
        bands.forEach(function (b) {
            if (b.missing) { return; }
            acc.pv += b.pv; acc.home += b.home; acc.imp += b.imp;
            acc.exp += b.exp; acc.chg += b.chg; acc.dis += b.dis;
            covered += (b.days || 1);
            if (b.partial) { partial = true; }
        });
        acc.days = covered;
        acc.partial = partial;
        return acc;
    }

    /* ==================================================================
       DETTAGLIO AL MINUTO — cache di un giorno
       ==================================================================
       Un giorno pieno sono ~288 punti (~24 kB). renderHistory() gira ad ogni
       poll: senza cache sarebbero 290 kB al minuto per un grafico che cambia
       una volta ogni sessanta secondi. Il giorno corrente si rinfresca al più
       una volta al minuto — la cadenza con cui il backend consolida una riga
       — i giorni passati non cambiano più.
       ================================================================== */
    var histCache = { iso: null, pts: [], status: 0, note: null, fetchedMs: 0, pending: false };
    var HIST_REFRESH_MS = 60 * 1000;

    function loadHistoryDay(iso) {
        if (histCache.pending) { return; }
        histCache.pending = true;
        fetchJSON("/history/day/" + iso).then(function (r) {
            var pts = (r.ok && r.body) ? normalizeServerSamples(r.body.samples) : [];
            histCache = {
                iso: iso, pts: pts, status: r.status,
                note: r.body && r.body.note ? r.body.note : null,
                fetchedMs: Date.now(), pending: false
            };
            if (pts.length > 1) { noteDetailDay(iso); }
            renderHistory(true);
        }, function () {
            histCache = { iso: iso, pts: [], status: 0, note: null, fetchedMs: Date.now(), pending: false };
            renderHistory(true);
        });
    }

    function noteDetailDay(iso) {
        if (!S.hist.detailFrom || iso < S.hist.detailFrom) { S.hist.detailFrom = iso; }
    }

    /* Da quando esiste il dettaglio al minuto?
       Non è una costante da scrivere nel codice — dipende da quando il
       pannello di casa ha cominciato a registrare — e il backend non espone
       l'elenco dei file. Si misura: si scende all'indietro a passo
       raddoppiato finché una data non risponde 404, poi si dimezza fra
       l'ultimo giorno con dettaglio e il primo senza.

       Costa una sola richiesta nel caso normale (il dettaglio comincia da
       poco, quindi il primo tentativo — ieri — è già un 404) e al massimo una
       dozzina nel caso peggiore, una volta per sessione e solo quando serve
       davvero dirlo all'utente. */
    function probeDetailStart() {
        if (S.hist.probe !== "idle" || !S.historyAvailable) { return; }
        S.hist.probe = "running";

        var today = todayNoon();
        var limit = Math.max(1, S.histRetentionDays);
        var lo = today;     // il più vecchio giorno NOTO con dettaglio
        var hi = null;      // il più recente giorno NOTO senza dettaglio

        function has(d) {
            return fetchJSON("/history/day/" + EF.isoDay(d)).then(function (r) {
                return !!(r.ok && r.body && (r.body.count > 0 || r.body.raw_count > 0));
            }, function () { return null; });   // null = non concludere niente
        }

        function down(step) {
            var d = addDays(today, -step);
            if (step > limit) { hi = d; return refine(); }
            return has(d).then(function (ok) {
                if (ok === null) { return give(); }
                if (ok) { lo = d; return down(step * 2); }
                hi = d;
                return refine();
            });
        }

        function refine() {
            if (hi === null) { return give(); }
            if (dayDiff(lo, hi) <= 1) { return settle(); }
            var mid = addDays(hi, Math.floor(dayDiff(lo, hi) / 2));
            return has(mid).then(function (ok) {
                if (ok === null) { return give(); }
                if (ok) { lo = mid; } else { hi = mid; }
                return refine();
            });
        }

        function settle() {
            S.hist.detailFrom = EF.isoDay(lo);
            S.hist.probe = "done";
            console.log("[storico] dettaglio al minuto disponibile dal " + S.hist.detailFrom);
            renderHistory(true);
        }

        function give() {
            // Sonda interrotta: meglio non dire niente che dire una data falsa.
            S.hist.probe = "done";
        }

        down(1);
    }

    /* ==================================================================
       RESA DELLA SEZIONE
       ================================================================== */
    var histSig = null;   // firma dell'ultima resa: evita il ridisegno inutile

    function histEls() {
        return {
            chart: EF.el("historyChart"),
            soc: EF.el("historySoc"),
            flows: EF.el("historyFlows"),
            note: EF.el("histNote"),
            summary: EF.el("histSummary"),
            bars: EF.el("histBars"),
            meters: EF.el("histMeters"),
            facts: EF.el("histFacts"),
            legend: EF.el("histLegend")
        };
    }

    function renderHistory(force) {
        if (!S.historyAvailable) { return; }
        /* Sul pannello a muro la sezione non esiste (data-kiosk-hidden): non
           si disegna dentro un contenitore a display:none, dove clientWidth
           è 0 e ogni misura verrebbe sbagliata. */
        if (root.getAttribute("data-mode") === "kiosk") { return; }
        var el = histEls();
        if (!el.chart) { return; }

        var period = S.hist.period;
        if (!S.hist.anchor) { S.hist.anchor = todayNoon(); }
        var anchor = normalizeAnchor(period, S.hist.anchor);
        S.hist.anchor = anchor;
        var range = periodRange(period, anchor);

        syncTabs(period);
        syncNav(period, anchor, range);
        syncHistoryUrl(period, anchor);

        if (period === "day") { renderHistoryDay(el, range.from, force); }
        else { renderHistoryRange(el, period, range, force); }
    }

    function syncTabs(period) {
        var tabs = document.querySelectorAll("#histTabs .tab");
        var panel = EF.el("histPanel");
        for (var i = 0; i < tabs.length; i++) {
            var on = tabs[i].getAttribute("data-period") === period;
            tabs[i].setAttribute("aria-selected", on ? "true" : "false");
            // Roving tabindex: dentro un tablist si tabula UNA volta, poi si
            // cambia scheda con le frecce.
            tabs[i].setAttribute("tabindex", on ? "0" : "-1");
            if (on && panel) { panel.setAttribute("aria-labelledby", tabs[i].id); }
        }
    }

    /* Navigazione ONESTA: i pulsanti si spengono quando non porterebbero da
       nessuna parte. Gli estremi vengono dai dati — oggi da un lato, la riga
       più vecchia dell'archivio dall'altro — mai da una costante. */
    function syncNav(period, anchor, range) {
        EF.text("histDate", rangeLabel(period, range));
        /* Solo la parola del periodo: il "prec./succ." è markup statico, e
           sotto i 560px questa parola sparisce mentre l'aria-label — che la
           contiene per esteso — resta. */
        EF.text("histPrevLabel", PERIOD_WORD[period]);
        EF.text("histNextLabel", PERIOD_WORD[period]);

        var prev = EF.el("histPrev");
        var next = EF.el("histNext");
        var today = todayNoon();

        if (next) {
            next.disabled = range.to >= today;
            next.setAttribute("aria-label", PERIOD_WORD[period].toLowerCase() + " successivo");
        }
        if (prev) {
            var floor = daily.firstDay ? parseDay(daily.firstDay) : null;
            var before = periodRange(period, shiftAnchor(period, anchor, -1));
            prev.disabled = !!(floor && before.to < floor);
            prev.setAttribute("aria-label", PERIOD_WORD[period].toLowerCase() + " precedente");
        }
    }

    function setLegend(items) {
        var host = EF.el("histLegend");
        if (!host) { return; }
        host.innerHTML = "";
        items.forEach(function (it) {
            var span = document.createElement("span");
            span.className = "legend__item";
            span.setAttribute("data-role", it.role);
            var mark = document.createElement("span");
            mark.className = it.line ? "legend__line" : "swatch";
            mark.setAttribute("aria-hidden", "true");
            span.appendChild(mark);
            span.appendChild(document.createTextNode(it.label));
            host.appendChild(span);
        });
    }

    function show(node, on) { if (node) { node.hidden = !on; } }

    function setNote(node, text) {
        if (!node) { return; }
        node.textContent = text || "";
        node.hidden = !text;
    }

    /* ---- Vista GIORNO ------------------------------------------------
       Tre esiti, tre messaggi diversi:
         1. c'è il dettaglio al minuto  → la curva;
         2. c'è solo l'aggregato        → il riepilogo, DICENDO che è un
                                          riepilogo e perché manca il minuto;
         3. non c'è niente              → e solo qui si dice "nessun dato".
       ------------------------------------------------------------------ */
    function renderHistoryDay(el, day, force) {
        var iso = EF.isoDay(day);
        var isToday = dayDiff(day, todayNoon()) === 0;

        // L'aggregato di quel giorno serve anche solo per sapere se esiste.
        ensureDaily(day, day);

        var fresh = histCache.iso === iso &&
            (!isToday || Date.now() - histCache.fetchedMs < HIST_REFRESH_MS);
        if (!fresh) { loadHistoryDay(iso); }

        var pts = histCache.iso === iso ? histCache.pts : [];
        var row = rowFor(iso);

        var sig = ["day", iso, pts.length, row ? daily.version : "-",
            S.hist.detailFrom, histCache.status].join("|");
        if (!force && sig === histSig) { return; }
        histSig = sig;

        // 1. Dettaglio al minuto: la curva, come sempre.
        if (pts.length > 1) {
            setLegend([
                { label: "Solare", role: "solar", line: true },
                { label: "Casa", role: "home", line: true }
            ]);
            EF.charts.renderDay(el.chart, pts);
            // Carica batteria del giorno mostrato, come in «Andamento di oggi»:
            // il dato `soc` sta in ogni riga dei file al minuto, sia in quelli
            // raccolti dal pannello sia in quelli importati dal portale, quindi
            // la striscia si può disegnare per qualunque giorno con il dettaglio.
            // Senza, guardando un giorno passato mancava proprio la grandezza che
            // spiega perché la casa ha preso dalla rete invece che dal sole.
            show(el.soc, true);
            EF.charts.renderSoc(el.soc, pts);
            show(el.flows, false);
            show(el.summary, false);
            show(el.facts, false);
            setNote(el.note, "Dettaglio al minuto" +
                (S.histResolutionS > 60 ? " (medie a " + Math.round(S.histResolutionS / 60) + " minuti)" : "") +
                " · " + pts.length + " punti registrati dal pannello di casa.");
            describeCurve(iso, pts);
            return;
        }

        // 2. Solo l'aggregato: si mostra QUELLO, e si dice che lo è.
        if (row) {
            var model = dayModel(row);
            setLegend([
                { label: "Solare", role: "solar" },
                { label: "Batteria", role: "battery" },
                { label: "Rete", role: "grid" }
            ]);
            EF.charts.empty(el.chart, "Riepilogo del " + iso,
                detailMissingReason(iso, isToday), "info");
            show(el.soc, false);   // c'è solo l'aggregato: nessun SOC al minuto
            show(el.flows, false);
            EF.charts.renderEnergy(el.bars, model);
            EF.charts.renderMeters(el.meters, model.indices);
            show(el.summary, true);
            renderFacts(el.facts, [row], 1);
            setNote(el.note, null);
            renderHistTable([{
                key: iso, label: fmtDate(day, { weekday: "long", day: "numeric", month: "long", year: "numeric" }),
                pv: model.production, home: model.consumption,
                imp: model.imported, exp: model.exported,
                chg: model.charge, dis: model.discharge, missing: false
            }], "Riepilogo del " + iso, iso);
            return;
        }

        // 3. Qui davvero non c'è niente — ed è l'unico caso in cui si dice.
        setLegend([]);
        show(el.soc, false);
        show(el.flows, false);
        show(el.summary, false);
        show(el.facts, false);
        setNote(el.note, null);
        EF.charts.empty(el.chart, "Nessun dato per questo giorno", noDataReason(iso, isToday));
        renderHistTable([], "Nessun dato per il " + iso, iso);
    }

    function detailMissingReason(iso, isToday) {
        probeDetailStart();
        var from = S.hist.detailFrom;
        var why = from
            ? "Il dettaglio al minuto lo registra il pannello di casa e il più vecchio disponibile è il " +
            from + ": di questo giorno resta il riepilogo importato, non la curva."
            : "Di questo giorno c'è il riepilogo giornaliero, non il dettaglio al minuto.";
        if (isToday) {
            why = "La giornata è appena cominciata: nessun minuto è ancora consolidato, " +
                "quindi qui c'è il riepilogo dai contatori dell'inverter.";
        }
        return why;
    }

    function noDataReason(iso, isToday) {
        if (isToday) {
            return "Il backend non ha ancora nessun contatore per oggi.";
        }
        if (daily.firstDay && iso < daily.firstDay) {
            return "L'archivio comincia il " + daily.firstDay + ": prima di quella data non è stato registrato niente.";
        }
        return "Né il dettaglio al minuto né il riepilogo giornaliero esistono per il " + iso +
            ": o il sistema era spento, o quel giorno non è mai stato importato.";
    }

    /* Modello di un singolo giorno di archivio. `home_kwh` è misurato
       (integrale del carico di casa), quindi si passa come consumo dichiarato
       invece di ricavarlo: la stessa funzione, la sorgente migliore. */
    function dayModel(row) {
        return energyModel({
            production: row.pv_kwh,
            exported: row.export_kwh,
            imported: row.import_kwh,
            consumption: row.home_kwh,
            charge: row.charge_kwh,
            discharge: row.discharge_kwh,
            productionNote: row.partial
                ? "giornata in corso · contatori dell'inverter"
                : "contatore giornaliero dell'inverter"
        });
    }

    /* ---- Vista SETTIMANA / MESE / ANNO -------------------------------- */
    function renderHistoryRange(el, period, range, force) {
        ensureDaily(range.from, range.to);

        var bands = buildBands(period, range);
        var totals = sumBands(bands);
        var todaySig = totals.partial ? [totals.pv, totals.home, totals.imp, totals.exp].join(",") : "";
        var sig = [period, EF.isoDay(range.from), daily.version, bands.length, todaySig].join("|");
        if (!force && sig === histSig) { return; }
        histSig = sig;

        setLegend([
            { label: "Produzione", role: "solar" },
            { label: "Consumo", role: "home" },
            { label: "Rete", role: "grid" },
            { label: "Batteria", role: "battery" }
        ]);

        var unit = period === "year" ? "mese" : "giorno";
        EF.charts.renderColumns(el.chart, bands, {
            ariaLabel: "Produzione e consumo per " + unit + " — " + rangeLabel(period, range),
            emptyDetail: "L'archivio non copre queste date."
        });
        EF.charts.renderFlows(el.flows, bands, {
            ariaLabel: "Energia presa e data, per " + unit + " — " + rangeLabel(period, range)
        });
        // Il SOC ha senso solo sull'asse dei minuti di una giornata: su una
        // settimana o un mese non esiste un "livello di carica del periodo".
        show(el.soc, false);
        show(el.flows, true);

        var model = energyModel({
            production: totals.pv,
            exported: totals.exp,
            imported: totals.imp,
            consumption: totals.home,
            charge: totals.chg,
            discharge: totals.dis,
            producedLabel: "Prodotta nel periodo",
            consumedLabel: "Consumata nel periodo",
            productionNote: totals.days
                ? "somma di " + totals.days + (totals.days === 1 ? " giorno" : " giorni")
                : null
        });

        if (model && totals.days) {
            EF.charts.renderEnergy(el.bars, model);
            EF.charts.renderMeters(el.meters, model.indices);
            show(el.summary, true);
            renderAverages(el.facts, totals);
        } else {
            show(el.summary, false);
            show(el.facts, false);
        }

        setNote(el.note, rangeNote(period, range, bands, totals));
        renderHistTable(bands, "Storico · " + rangeLabel(period, range), rangeLabel(period, range));
    }

    function rangeNote(period, range, bands, totals) {
        var parts = [];
        var gaps = bands.filter(function (b) { return b.missing; }).length;
        if (!totals.days) {
            parts.push("Nessun giorno consolidato in questo periodo.");
            if (daily.firstDay) { parts.push("L'archivio comincia il " + daily.firstDay + "."); }
            return parts.join(" ");
        }
        if (gaps) {
            parts.push(gaps + (gaps === 1 ? " giorno senza dati" : " giorni senza dati") +
                ": non sono disegnati a zero, semplicemente non hanno colonna.");
        }
        if (totals.partial) {
            parts.push("L'ultima colonna è la giornata in corso: viene dai contatori " +
                "dell'inverter, il consolidamento avviene a fine giornata.");
        }
        return parts.join(" ");
    }

    function renderAverages(host, totals) {
        if (!host || !totals.days) { show(host, false); return; }
        host.innerHTML = "";
        [
            ["Giorni con dati", String(totals.days)],
            ["Media prodotta", EF.energy(totals.pv / totals.days) + " kWh/g"],
            ["Media consumata", EF.energy(totals.home / totals.days) + " kWh/g"]
        ].forEach(function (pair) {
            var span = document.createElement("span");
            span.appendChild(document.createTextNode(pair[0] + " "));
            var b = document.createElement("b");
            b.className = "tnum";
            b.textContent = pair[1];
            span.appendChild(b);
            host.appendChild(span);
        });
        show(host, true);
    }

    /* Picco solare e SOC minimo esistono solo per i giorni consolidati in
       locale: i 229 importati dal portale non li hanno, perché il portale non
       li espone su base giornaliera. Si scrive "non disponibile" — MAI zero,
       che sarebbe un numero falso e per giunta plausibile. */
    function renderFacts(host, rows, days) {
        if (!host) { return; }
        host.innerHTML = "";
        var peak = null, minSoc = null;
        rows.forEach(function (r) {
            var p = EF.num(r.peak_pv_w);
            if (p !== null && (peak === null || p > peak)) { peak = p; }
            var s = EF.num(r.min_soc);
            if (s !== null && (minSoc === null || s < minSoc)) { minSoc = s; }
        });
        [
            ["Picco solare", peak === null ? "non disponibile" : EF.powerText(peak)],
            ["Carica minima", minSoc === null ? "non disponibile" : EF.percent(minSoc) + "%"]
        ].forEach(function (pair) {
            var span = document.createElement("span");
            span.appendChild(document.createTextNode(pair[0] + " "));
            var b = document.createElement("b");
            b.textContent = pair[1];
            span.appendChild(b);
            host.appendChild(span);
        });
        show(host, true);
    }

    /* Gemello tabellare: gli stessi valori del grafico, raggiungibili senza
       puntatore. Un tooltip non deve MAI essere l'unica via a un numero. */
    function renderHistTable(bands, caption, altSubject) {
        var head = EF.el("histTableHead");
        var body = EF.el("histTableBody");
        var cap = EF.el("histTableCaption");
        if (cap) { cap.textContent = caption; }
        if (!head || !body) { return; }

        head.innerHTML = "";
        ["Periodo", "Prodotta kWh", "Consumata kWh", "Prelevata kWh",
            "Immessa kWh", "Carica kWh", "Scarica kWh"].forEach(function (h) {
                var th = document.createElement("th");
                th.textContent = h;
                head.appendChild(th);
            });

        body.innerHTML = "";
        bands.forEach(function (b) {
            var tr = document.createElement("tr");
            var cells = b.missing
                ? [b.label, "nessun dato", "", "", "", "", ""]
                : [b.label, EF.energy(b.pv), EF.energy(b.home), EF.energy(b.imp),
                    EF.energy(b.exp), EF.energy(b.chg), EF.energy(b.dis)];
            cells.forEach(function (c) {
                var td = document.createElement("td");
                td.textContent = c;
                tr.appendChild(td);
            });
            body.appendChild(tr);
        });

        var totals = sumBands(bands);
        EF.text("histAltText", bands.length
            ? altSubject + ": prodotti " + EF.energy(totals.pv) + " kWh, consumati " +
            EF.energy(totals.home) + " kWh, prelevati dalla rete " + EF.energy(totals.imp) +
            " kWh, immessi " + EF.energy(totals.exp) + " kWh su " + totals.days +
            (totals.days === 1 ? " giorno." : " giorni.")
            : altSubject + ".");
    }

    function describeCurve(iso, pts) {
        var peak = 0, maxHome = 0;
        pts.forEach(function (p) {
            if (p.pv > peak) { peak = p.pv; }
            if (p.home > maxHome) { maxHome = p.home; }
        });
        renderHistTable([], "Andamento al minuto del " + iso, "Andamento al minuto del " + iso);
        EF.text("histAltText", "Andamento al minuto del " + iso + ": " + pts.length +
            " punti, picco solare " + EF.powerText(peak) +
            ", consumo massimo " + EF.powerText(maxHome) + ".");
    }

    /* ==================================================================
       LINK DIRETTI (regola #4)
       ==================================================================
         ?period=day&anchor=2026-03-15    un giorno
         ?period=week&anchor=2026-07-06   la settimana che contiene quel giorno
         ?period=month&anchor=2026-07     un mese
         ?period=year&anchor=2026         un anno
         ?day=2026-03-15                  forma storica, ancora accettata

       L'indirizzo si riscrive ad ogni cambio di vista: quello che si legge
       nella barra è sempre un link che riapre esattamente quello che si sta
       guardando, senza dover ricliccare "precedente" venti volte.
       ================================================================== */
    function anchorParam(period, anchor) {
        if (period === "year") { return String(anchor.getFullYear()); }
        if (period === "month") { return monthKey(anchor); }
        return EF.isoDay(anchor);
    }

    function historyStateFromUrl() {
        var period = urlParam("period");
        if (PERIOD_ORDER.indexOf(period) < 0) { period = null; }
        var raw = urlParam("anchor");
        var anchor = null;

        if (raw) {
            if (/^\d{4}$/.test(raw)) {
                anchor = noon(new Date(Number(raw), 0, 1));
                if (!period) { period = "year"; }
            } else if (/^\d{4}-\d{2}$/.test(raw)) {
                anchor = noon(new Date(Number(raw.slice(0, 4)), Number(raw.slice(5, 7)) - 1, 1));
                if (!period) { period = "month"; }
            } else {
                anchor = parseDay(raw);
            }
        }
        // Forma storica: ?day=YYYY-MM-DD apre quel giorno in vista dettaglio.
        if (!anchor) {
            var legacy = parseDay(urlParam("day"));
            if (legacy) { anchor = legacy; period = period || "day"; }
        }
        if (anchor && isNaN(anchor.getTime())) { anchor = null; }

        S.hist.period = period || "week";
        S.hist.anchor = normalizeAnchor(S.hist.period, anchor || todayNoon());
    }

    var histUrlKey = null;

    function syncHistoryUrl(period, anchor) {
        var key = period + ":" + anchorParam(period, anchor);
        if (key === histUrlKey) { return; }
        histUrlKey = key;
        try {
            var p = new URLSearchParams(window.location.search);
            p.delete("day");           // una sola forma canonica nell'indirizzo
            p.set("period", period);
            p.set("anchor", anchorParam(period, anchor));
            history.replaceState(null, "",
                window.location.pathname + "?" + p.toString() + window.location.hash);
        } catch (e) {
            /* Da file:// riscrivere la query è vietato: la vista funziona
               lo stesso, si perde solo il link condivisibile. */
        }
    }

    /* ==================================================================
       COMANDI DELLA SEZIONE
       ================================================================== */
    function histGo(dir) {
        var btn = EF.el(dir > 0 ? "histNext" : "histPrev");
        if (btn && btn.disabled) { return; }
        S.hist.anchor = shiftAnchor(S.hist.period, S.hist.anchor || todayNoon(), dir);
        renderHistory(true);
    }

    /* Cambiando periodo si resta dove si è: se il periodo mostrato contiene
       oggi si va su oggi, altrimenti sul suo primo giorno. Saltare sempre a
       oggi perderebbe il punto in cui si stava guardando. */
    function histSetPeriod(next) {
        if (PERIOD_ORDER.indexOf(next) < 0 || next === S.hist.period) { return; }
        var range = periodRange(S.hist.period, S.hist.anchor || todayNoon());
        var today = todayNoon();
        var keep = (today >= range.from && today <= range.to) ? today : range.from;
        S.hist.period = next;
        S.hist.anchor = normalizeAnchor(next, keep);
        histSig = null;
        renderHistory(true);
    }

    function histCyclePeriod() {
        var i = PERIOD_ORDER.indexOf(S.hist.period);
        histSetPeriod(PERIOD_ORDER[(i + 1) % PERIOD_ORDER.length]);
    }

    function bindHistory() {
        var tabs = EF.el("histTabs");
        if (tabs) {
            tabs.addEventListener("click", function (ev) {
                var t = ev.target.closest ? ev.target.closest(".tab") : null;
                if (t) { histSetPeriod(t.getAttribute("data-period")); }
            });
            // Frecce dentro il tablist: è il comportamento che un lettore di
            // schermo annuncia e si aspetta da role="tablist".
            tabs.addEventListener("keydown", function (ev) {
                var list = Array.prototype.slice.call(tabs.querySelectorAll(".tab"));
                var i = list.indexOf(document.activeElement);
                if (i < 0) { return; }
                var next = null;
                if (ev.key === "ArrowRight" || ev.key === "ArrowDown") { next = (i + 1) % list.length; }
                else if (ev.key === "ArrowLeft" || ev.key === "ArrowUp") { next = (i - 1 + list.length) % list.length; }
                else if (ev.key === "Home") { next = 0; }
                else if (ev.key === "End") { next = list.length - 1; }
                if (next === null) { return; }
                ev.preventDefault();
                histSetPeriod(list[next].getAttribute("data-period"));
                list[next].focus();
            });
        }

        var prev = EF.el("histPrev");
        var next = EF.el("histNext");
        if (prev) { prev.addEventListener("click", function () { histGo(-1); }); }
        if (next) { next.addEventListener("click", function () { histGo(1); }); }
    }

    /* Sonda d'avvio dello storico.
       La sezione si mostra solo se /history/day risponde: se lo storico è
       spento da config.json l'endpoint torna 404, e dei controlli che non
       portano da nessuna parte promettono una funzione che quel pannello non
       ha. La stessa risposta porta anche la curva di oggi già fatta — due
       lavori, una richiesta. */
    function bootstrapHistory() {
        var section = document.querySelector('[data-area="history"]');
        var iso = EF.isoDay(new Date());
        return fetchJSON("/history/day/" + iso).then(function (r) {
            S.historyAvailable = !!r.ok;
            if (section) { section.hidden = !r.ok; }

            if (r.ok && r.body) {
                S.histResolutionS = r.body.resolution_s || 60;
                S.histRetentionDays = EF.num(r.body.retention_days) || S.histRetentionDays;
                var pts = normalizeServerSamples(r.body.samples);
                histCache = {
                    iso: iso, pts: pts, status: r.status,
                    note: r.body.note || null, fetchedMs: Date.now(), pending: false
                };
                if (pts.length > 1) { noteDetailDay(iso); }

                var n = adoptServerSamples(r.body.samples) ? S.samples.length : 0;
                console.log("[storico] endpoint attivo — " + n + " punti per oggi" +
                    " (risoluzione " + S.histResolutionS + "s, retention " +
                    (r.body.retention_days || "?") + " giorni)");

                /* L'archivio lungo, in una sola richiesta: copre l'anno appena
                   passato e stabilisce da subito il fondo della navigazione. */
                var today = todayNoon();
                ensureDaily(addDays(today, -(DAILY_BOOT_DAYS - 1)), today);
                renderCharts(true);
            } else {
                console.log("[storico] endpoint assente (" + r.status + "): sezione nascosta, " +
                    "la curva resta quella accumulata dal browser");
            }
        }, function (err) {
            S.historyAvailable = false;
            if (section) { section.hidden = true; }
            console.warn("[storico] sonda fallita: " + (err && err.message ? err.message : err));
        });
    }

    /* ==================================================================
       CONFIGURAZIONE E METEO
       Niente più /config.json: quel file contiene le coordinate GPS di casa
       e non deve essere scaricabile dal browser. Si usano gli endpoint
       dedicati; se non esistono ancora si degrada senza rompere nulla.
       ================================================================== */
    function loadUiConfig() {
        return fetchJSON("/api/ui-config").then(function (r) {
            if (r.ok && r.body) { S.uiConfig = r.body; return; }
            throw new Error("ui-config " + r.status);
        }).catch(function () {
            // Ripiego sull'endpoint attuale, già sanificato lato server.
            return fetchJSON("/config").then(function (r) {
                if (r.ok && r.body) {
                    S.uiConfig = { battery: r.body.battery, solar: r.body.solar };
                    console.warn("[config] /api/ui-config assente, uso /config");
                } else {
                    console.warn("[config] nessuna configurazione: capacità batteria sconosciuta");
                }
            }, function () {
                console.warn("[config] nessuna configurazione raggiungibile");
            });
        });
    }

    /* Il meteo passa dal backend (proxy), non da una chiamata diretta del
       browser a open-meteo: così le coordinate di casa non lasciano il
       server e la CSP può restare "connect-src 'self'". */
    function loadWeather() {
        return fetchJSON("/api/weather").then(function (r) {
            if (!r.ok || !r.body) { throw new Error("weather " + r.status); }
            S.weather = normalizeWeather(r.body);
            renderWeather();
            applyTheme();
        }).catch(function () {
            console.warn("[meteo] /api/weather non disponibile");
            renderWeather();
        });
    }

    /* Il backend è in corso di estensione da un altro agente: la forma esatta
       della risposta non è ancora fissata. Si accettano sia una forma piatta
       sia il passthrough di open-meteo, e qualunque campo mancante diventa
       null invece di far esplodere il rendering. */
    function normalizeWeather(b) {
        var out = { tempC: null, code: null, sunriseMin: null, sunsetMin: null };
        if (!b) { return out; }

        /* Forma servita dal backend:
             current: { temperature_c, weather_code, is_day, time }
             today:   { sunrise, sunset, weather_code, temp_max_c, temp_min_c }
           Restano accettate anche la forma piatta e il passthrough grezzo di
           open-meteo (temperature_2m / daily.sunrise[]): costano due righe e
           evitano che un cambio di forma a monte spenga il meteo in silenzio. */
        var cur = b.current || {};
        out.tempC = firstNum([cur.temperature_c, cur.temperature_2m,
            b.temperature_c, b.temperature]);
        out.code = firstNum([cur.weather_code, b.weather_code, b.code,
            b.today && b.today.weather_code]);

        var sr = null, ss = null;
        if (b.today) { sr = b.today.sunrise; ss = b.today.sunset; }
        if (!sr && b.daily) {
            sr = Array.isArray(b.daily.sunrise) ? b.daily.sunrise[0] : b.daily.sunrise;
            ss = Array.isArray(b.daily.sunset) ? b.daily.sunset[0] : b.daily.sunset;
        }
        if (!sr) { sr = b.sunrise; ss = b.sunset; }

        out.sunriseMin = timeToMinutes(sr);
        out.sunsetMin = timeToMinutes(ss);
        return out;
    }

    function firstNum(list) {
        for (var i = 0; i < list.length; i++) {
            var n = EF.num(list[i]);
            if (n !== null) { return n; }
        }
        return null;
    }

    function timeToMinutes(v) {
        if (!v) { return null; }
        if (typeof v === "string") {
            /* "2026-08-09T06:10" oppure "06:10".
               Si legge l'ora con una regex e NON con Date.parse di proposito:
               il backend manda un ISO SENZA fuso, già in ora locale. Date lo
               interpreterebbe come UTC su alcuni motori, e alba e tramonto
               slitterebbero di due ore in estate — abbastanza da far passare
               il pannello al tema scuro a metà pomeriggio. */
            var m = v.match(/(\d{1,2}):(\d{2})/);
            if (m) { return parseInt(m[1], 10) * 60 + parseInt(m[2], 10); }
        }
        var n = EF.num(v);
        if (n !== null && n > 1e9) { return EF.minutesOfDay(new Date(n * 1000)); }
        return null;
    }

    function renderWeather() {
        var w = S.weather;
        if (!w) {
            EF.text("weatherDesc", "meteo non disponibile");
            EF.text("weatherTemp", "--°");
            return;
        }
        var wc = EF.weatherCode(w.code);
        EF.text("weatherIcon", wc.icon);
        EF.text("weatherDesc", wc.label);
        EF.text("weatherTemp", w.tempC === null ? "--°" : EF.dec(w.tempC, 1) + "°");
        EF.text("sunrise", w.sunriseMin === null ? "--:--" : minutesToHHMM(w.sunriseMin));
        EF.text("sunset", w.sunsetMin === null ? "--:--" : minutesToHHMM(w.sunsetMin));
    }

    function minutesToHHMM(m) {
        var h = Math.floor(m / 60), mm = Math.round(m % 60);
        return String(h).padStart(2, "0") + ":" + String(mm).padStart(2, "0");
    }

    /* ==================================================================
       OROLOGIO — tick indipendente, ogni secondo.
       Prima l'ora veniva riscritta solo dentro fetchWeather, che gira ogni
       15 minuti: l'orologio del pannello avanzava a scatti di un quarto
       d'ora. Le due cose non hanno alcun motivo di condividere un timer.
       ================================================================== */
    function tickClock() {
        var now = new Date();
        EF.text("clockTime", EF.clock(now));
        EF.text("clockDate", EF.dateLong(now));
        applyTheme(); // il passaggio giorno/notte va colto al minuto, non al riavvio
    }

    /* Una sola regione aria-live, riscritta ogni 30 s. Se annunciasse i
       valori veri (che cambiano ogni 5 s) il lettore di schermo non
       smetterebbe mai di parlare e diventerebbe inascoltabile. */
    function announce() {
        if (!S.data) { return; }
        EF.text("srSummary",
            "Solare " + EF.powerText(solarW()) +
            ", casa " + EF.powerText(D("home_load_w")) +
            ", batteria " + EF.percent(D("battery_percent")) + " per cento" +
            (S.phase === "ok" ? "" : ". Attenzione: dati non aggiornati") + ".");
    }

    /* ==================================================================
       CONTROLLI
       ================================================================== */
    function bindControls() {
        var map = [
            ["btnRefresh", pull],
            ["btnAuto", toggleAuto],
            ["btnTheme", cycleTheme],
            ["btnKiosk", toggleMode],
            ["btnTech", toggleTech],
            ["btnHelp", function () { EF.keys.help(); }]
        ];
        map.forEach(function (pair) {
            var el = EF.el(pair[0]);
            if (el) { el.addEventListener("click", pair[1]); }
        });

        /* Schede del periodo e navigazione avanti/indietro: tutto in
           bindHistory(), accanto alla logica che governano. */
        bindHistory();
    }

    function toggleTech() {
        var panel = EF.el("techPanel");
        if (!panel) { return; }
        panel.hidden = !panel.hidden;
        var btn = EF.el("btnTech");
        if (btn) { btn.setAttribute("aria-pressed", panel.hidden ? "false" : "true"); }
        if (!panel.hidden) { renderTech(); }
    }

    function scrollToArea(area) {
        var el = document.querySelector('[data-area="' + area + '"]');
        if (el) { el.scrollIntoView({ behavior: "smooth", block: "start" }); }
    }

    /* ==================================================================
       AVVIO
       ================================================================== */
    function boot() {
        applyMode(resolveMode());
        applyTheme();
        loadSamples();
        bindControls();

        EF.flow.init();
        EF.keys.init({
            refresh: pull,
            toggleAuto: toggleAuto,
            cycleTheme: cycleTheme,
            toggleMode: toggleMode,
            toggleTech: toggleTech,
            goto: scrollToArea,
            /* Lo storico si guida da tastiera come il resto (regola #5):
               `p` cambia periodo, `[` e `]` scorrono avanti e indietro. */
            histPeriod: histCyclePeriod,
            histPrev: function () { histGo(-1); },
            histNext: function () { histGo(1); }
        });

        /* Nessun bootstrap con dati di esempio.
           La versione precedente inizializzava la pagina con un campione
           finto: per uno o due secondi il pannello mostrava numeri inventati
           indistinguibili dai veri. Qui si parte da "--" e si aspetta. */
        renderCharts();
        evaluate();

        loadUiConfig().then(pull);
        loadWeather();
        historyStateFromUrl();
        bootstrapHistory();

        startAuto();
        setInterval(tickClock, 1000);
        setInterval(loadWeather, WEATHER_MS);
        /* Riallineamento periodico col file sul server: su un pannello acceso
           per giorni è l'unico modo di recuperare i minuti persi mentre il
           browser dormiva. */
        setInterval(syncDayFromServer, HISTORY_SYNC_MS);
        setInterval(announce, SUMMARY_MS);
        /* Il watchdog: indipendente dal fetch, guarda l'orologio.
           Se il polling smette del tutto di produrre eventi, è l'unica cosa
           che se ne accorge — un ciclo morto non può denunciarsi da solo. */
        setInterval(evaluate, 1000);
        tickClock();

        /* Il cambio di orientamento del pannello o della finestra rimisura i
           grafici; il diagramma ha già il suo ResizeObserver.
           `true` esplicito: le colonne dello storico si ridisegnano solo se
           qualcosa è cambiato, e una finestra più stretta è esattamente uno
           di quei cambiamenti che la firma dei dati non vede. */
        window.addEventListener("resize", EF.rafThrottle(function () {
            renderCharts(true);
        }));

        /* La media query decide la modalità solo se l'utente non l'ha
           forzata: ruotare il pannello non deve scavalcare una scelta. */
        var onMQ = function () {
            var forced = urlParam("mode");
            var saved = null;
            try { saved = localStorage.getItem(LS_MODE); } catch (e) { saved = null; }
            if (!forced && !saved) { applyMode(kioskMQ.matches ? "kiosk" : "compact"); }
        };
        if (kioskMQ.addEventListener) { kioskMQ.addEventListener("change", onMQ); }
        else if (kioskMQ.addListener) { kioskMQ.addListener(onMQ); }

        console.log("[EnergyFlow] avviata — modalità " + root.getAttribute("data-mode"));
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", boot);
    } else {
        boot();
    }
})();
