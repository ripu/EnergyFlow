/* ============================================================================
   EnergyFlow — grafici in SVG scritti a mano. Zero dipendenze, zero CDN.
   (Un pannello senza internet non può caricare una libreria da unpkg, e una
   dashboard che si degrada quando cade il router non è una dashboard.)

   Scelte di forma, dalla skill `dataviz`:
   - MAI un doppio asse y. Il SOC (0-100%) non condivide il riquadro con le
     potenze (0-N kW): sta in una striscia separata sotto, con lo STESSO asse
     x. L'allineamento fra due scale y è arbitrario e inventa correlazioni
     che nei dati non esistono.
   - MAI una torta per le energie: una barra impilata orizzontale, dove il
     confronto è una lunghezza e non un angolo.
   - Marchi sottili, griglia in tinta a un passo dalla superficie e SOLIDA
     (una griglia tratteggiata si legge come "soglia" o "proiezione").
   - Etichette dirette col contatagocce — il picco, non ogni punto.
   ========================================================================= */
(function () {
    "use strict";

    var EF = window.EF;
    var NS = EF.SVGNS;

    var DAY_MIN = 1440;

    function isKiosk() {
        return document.documentElement.getAttribute("data-mode") === "kiosk";
    }

    function clear(node) {
        while (node && node.firstChild) { node.removeChild(node.firstChild); }
    }

    /* Stato vuoto ONESTO: dice che non ci sono dati e perché. Mai una curva
       inventata per "riempire" il riquadro.

       `kind` distingue due messaggi che sembrano uguali e non lo sono:
         "empty" (default)  qui non c'è niente — bordo tratteggiato, il segno
                            classico del buco;
         "info"             qui c'è un dato, ma di un'altra natura da quella
                            che il riquadro disegnerebbe (il riepilogo di un
                            giorno di cui manca il dettaglio al minuto). Bordo
                            pieno: non è un buco, è un'altra cosa. */
    function empty(host, title, detail, kind) {
        clear(host);
        var box = document.createElement("div");
        box.className = "chart__empty";
        box.setAttribute("data-kind", kind === "info" ? "info" : "empty");
        var strong = document.createElement("strong");
        strong.textContent = title;
        box.appendChild(strong);
        if (detail) {
            var p = document.createElement("span");
            p.textContent = detail;
            box.appendChild(p);
        }
        host.appendChild(box);
    }

    /* Scala "carina" per l'asse y: i tick devono cadere su numeri che una
       persona legge senza tradurli (0 / 1 / 2 / 3 kW), non su 0 / 1,37 / 2,74. */
    function niceMax(v) {
        if (!isFinite(v) || v <= 0) { return 1000; }
        var exp = Math.floor(Math.log10(v));
        var base = Math.pow(10, exp);
        var n = v / base;
        /* Scala fitta anche nella parte alta della decade.
           Con i soli passi 1/2/2.5/5/10 un picco da 5,06 kW saltava al
           fondoscala di 10 kW: la curva finiva schiacciata nella metà bassa
           del riquadro e la giornata non si leggeva più. I passi 3/4/6/8
           costano nulla e restano numeri tondi sull'asse. */
        var steps = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
        for (var i = 0; i < steps.length; i++) {
            if (n <= steps[i]) { return steps[i] * base; }
        }
        return 10 * base;
    }

    /* Altezza utile del contenitore, se ne ha una decisa dal layout.
       In modalità compatta la card cresce col contenuto, quindi clientHeight
       è 0 o irrisorio al primo giro: lì vince il valore di riferimento. */
    function fitHeight(host, fallback) {
        var h = host ? host.clientHeight : 0;
        return h > 60 ? Math.round(h) : fallback;
    }

    function svgRoot(width, height) {
        var s = document.createElementNS(NS, "svg");
        s.setAttribute("class", "chart");
        /* viewBox 1:1 coi pixel CSS reali e preserveAspectRatio esplicito.
           Stessa disciplina del diagramma di flusso: nessun fattore di scala
           implicito, quindi nessun testo stirato quando cambia il rapporto
           d'aspetto del contenitore. */
        s.setAttribute("viewBox", "0 0 " + width + " " + height);
        s.setAttribute("preserveAspectRatio", "xMidYMid meet");
        s.setAttribute("width", "100%");
        s.setAttribute("height", height);
        s.setAttribute("role", "presentation");
        return s;
    }

    function pathFrom(points, xOf, yOf) {
        var d = "";
        for (var i = 0; i < points.length; i++) {
            d += (i ? " L " : "M ") + xOf(points[i]).toFixed(1) + " " + yOf(points[i]).toFixed(1);
        }
        return d;
    }

    /* ==================================================================
       ANDAMENTO DELLA GIORNATA — area (solare) + linea (casa)
       ================================================================== */
    function renderDay(host, points, opts) {
        if (!host) { return; }
        opts = opts || {};

        if (!points || points.length < 2) {
            empty(host,
                "Nessun andamento ancora",
                opts.emptyDetail || "La curva si costruisce mentre la pagina resta aperta.");
            return;
        }

        var kiosk = isKiosk();
        var width = Math.max(280, Math.round(host.clientWidth || 600));
        /* L'altezza la detta il contenitore quando ne ha una imposta (sul
           kiosk la banda è fissa e i due riquadri se la dividono per flex).
           Con un'altezza scritta nel codice i due SVG sfondavano i rispettivi
           wrapper e finivano disegnati uno sopra l'altro. */
        var height = opts.height || fitHeight(host, kiosk ? 230 : 180);
        var padL = kiosk ? 84 : 46;
        var padR = kiosk ? 24 : 14;
        var padT = kiosk ? 22 : 14;
        /* La fascia dell'asse x fa parte dell'altezza: un contenitore che la
           esclude produce un mini-scroll verticale dentro la card. */
        var padB = kiosk ? 42 : 26;

        var plotW = width - padL - padR;
        var plotH = height - padT - padB;
        if (plotW <= 0 || plotH <= 0) { return; }

        var maxV = 0;
        points.forEach(function (p) {
            if (p.pv > maxV) { maxV = p.pv; }
            if (p.home > maxV) { maxV = p.home; }
        });
        var top = niceMax(maxV * 1.12);

        var xOf = function (p) { return padL + (p.t / DAY_MIN) * plotW; };
        var yOf = function (v) { return padT + plotH - (v / top) * plotH; };

        clear(host);
        var s = svgRoot(width, height);

        /* ---- griglia y + tick ----
           Il numero di tacche si adatta all'altezza disponibile. Fisso a 4
           produceva cinque etichette da 22px dentro 86px di plot: si
           accavallavano fino a diventare una macchia. Meglio tre numeri
           leggibili che cinque illeggibili — la griglia serve a leggere il
           valore, non a decorare. */
        var gGrid = EF.svg("g", { "class": "chart__grid" });
        var tickH = kiosk ? 26 : 14;
        var steps = plotH / tickH >= 5 ? 4 : (plotH / tickH >= 3 ? 2 : 1);
        for (var i = 0; i <= steps; i++) {
            var val = (top / steps) * i;
            var y = yOf(val);
            gGrid.appendChild(EF.svg("line", {
                x1: padL, x2: padL + plotW, y1: y.toFixed(1), y2: y.toFixed(1)
            }));
            var t = EF.svg("text", {
                x: padL - 8, y: (y + 4).toFixed(1),
                "text-anchor": "end", "class": "tick"
            });
            /* L'unità sta SOLO sul tick più alto. Ripeterla su ognuno è
               rumore; metterla in un'etichetta separata sopra l'asse la
               faceva finire addosso proprio a quel tick. */
            t.textContent = (val >= 1000 ? EF.dec(val / 1000, 1) : String(Math.round(val))) +
                (i === steps ? " " + (top >= 1000 ? "kW" : "W") : "");
            gGrid.appendChild(t);
        }
        s.appendChild(gGrid);

        // ---- tick x ogni 6 ore ----
        var gx = EF.svg("g", { "class": "chart__grid" });
        [0, 360, 720, 1080, 1440].forEach(function (m) {
            var x = padL + (m / DAY_MIN) * plotW;
            var lbl = EF.svg("text", {
                x: x.toFixed(1), y: (padT + plotH + (kiosk ? 30 : 18)).toFixed(1),
                "text-anchor": m === 0 ? "start" : (m === DAY_MIN ? "end" : "middle"),
                "class": "tick"
            });
            lbl.textContent = String(m / 60).padStart(2, "0") + ":00";
            gx.appendChild(lbl);
        });
        s.appendChild(gx);

        // ---- asse di base ----
        s.appendChild(EF.svg("line", {
            "class": "axis-line",
            x1: padL, x2: padL + plotW,
            y1: (padT + plotH).toFixed(1), y2: (padT + plotH).toFixed(1)
        }));

        // ---- area solare: un velo al 10%, mai un blocco saturo ----
        var areaD = pathFrom(points, xOf, function (p) { return yOf(p.pv); }) +
            " L " + xOf(points[points.length - 1]).toFixed(1) + " " + yOf(0).toFixed(1) +
            " L " + xOf(points[0]).toFixed(1) + " " + yOf(0).toFixed(1) + " Z";
        var area = EF.svg("path", { "class": "series-area", d: areaD });
        area.style.fill = "var(--role-solar)";
        s.appendChild(area);

        var pvLine = EF.svg("path", {
            "class": "series-line",
            d: pathFrom(points, xOf, function (p) { return yOf(p.pv); })
        });
        pvLine.style.stroke = "var(--role-solar)";
        s.appendChild(pvLine);

        // ---- linea casa, in inchiostro ----
        var homeLine = EF.svg("path", {
            "class": "series-line",
            d: pathFrom(points, xOf, function (p) { return yOf(p.home); })
        });
        homeLine.style.stroke = "var(--role-home)";
        s.appendChild(homeLine);

        // ---- punti finali con anello nel colore della superficie ----
        var last = points[points.length - 1];
        [["pv", "var(--role-solar)"], ["home", "var(--role-home)"]].forEach(function (pair) {
            var dot = EF.svg("circle", {
                "class": "end-dot",
                cx: xOf(last).toFixed(1),
                cy: yOf(last[pair[0]]).toFixed(1),
                r: kiosk ? 7 : 4.5
            });
            dot.style.fill = pair[1];
            s.appendChild(dot);
        });

        /* ---- UNA sola etichetta diretta: il picco solare ----
           Il valore su ogni punto sarebbe caos e non lo leggerebbe nessuno.
           Il picco è l'unico numero che l'asse non racconta già. */
        var peak = points[0];
        points.forEach(function (p) { if (p.pv > peak.pv) { peak = p; } });
        if (peak.pv > top * 0.12) {
            var px = xOf(peak);
            var py = yOf(peak.pv);
            var anchor = px > padL + plotW * 0.8 ? "end" : (px < padL + plotW * 0.2 ? "start" : "middle");
            var lab = EF.svg("text", {
                x: px.toFixed(1), y: (py - (kiosk ? 16 : 10)).toFixed(1),
                "text-anchor": anchor, "class": "tick"
            });
            lab.style.fontWeight = "700";
            lab.style.fill = "var(--text)";
            lab.textContent = "picco " + EF.powerText(peak.pv);
            s.appendChild(lab);
        }

        host.appendChild(s);

        /* ---- Strato di hover: un grafico HTML È interattivo -------------
           Sul kiosk non serve (nessuno tocca il muro) e non viene montato:
           un listener pointermove attivo h24 è lavoro per niente. */
        if (!kiosk) {
            attachHover(host, s, points, xOf, yOf, padL, padT, plotW, plotH);
        }
    }

    /* Crosshair + tooltip sul punto più vicino. */
    function attachHover(host, s, points, xOf, yOf, padL, padT, plotW, plotH) {
        var line = EF.svg("line", {
            "class": "axis-line", y1: padT, y2: padT + plotH, x1: -99, x2: -99
        });
        line.style.opacity = "0";
        s.appendChild(line);

        var tip = document.createElement("div");
        tip.className = "freshness";
        tip.style.position = "absolute";
        tip.style.pointerEvents = "none";
        tip.style.opacity = "0";
        tip.style.transition = "opacity var(--dur-1) var(--ease-out)";
        tip.style.zIndex = "5";
        host.style.position = "relative";
        host.appendChild(tip);

        function hide() {
            line.style.opacity = "0";
            tip.style.opacity = "0";
        }

        s.addEventListener("pointerleave", hide);
        s.addEventListener("pointermove", function (ev) {
            var box = s.getBoundingClientRect();
            // Il viewBox è 1:1 coi px CSS, ma l'SVG ha width:100%: se il
            // contenitore è stato ridimensionato dopo il render, la mappatura
            // px-schermo -> px-viewBox ha un fattore. Lo si ricava dal rapporto.
            var k = box.width ? (s.viewBox.baseVal.width / box.width) : 1;
            var mx = (ev.clientX - box.left) * k;
            if (mx < padL || mx > padL + plotW) { hide(); return; }

            var best = points[0];
            var bestD = Infinity;
            for (var i = 0; i < points.length; i++) {
                var d = Math.abs(xOf(points[i]) - mx);
                if (d < bestD) { bestD = d; best = points[i]; }
            }

            var bx = xOf(best);
            line.setAttribute("x1", bx.toFixed(1));
            line.setAttribute("x2", bx.toFixed(1));
            line.style.opacity = ".55";

            var hh = String(Math.floor(best.t / 60)).padStart(2, "0");
            var mm = String(Math.round(best.t % 60)).padStart(2, "0");
            tip.textContent = hh + ":" + mm + " · solare " + EF.powerText(best.pv) +
                " · casa " + EF.powerText(best.home);
            tip.style.opacity = "1";

            var leftPx = (bx / k) + 12;
            var maxLeft = box.width - tip.offsetWidth - 8;
            tip.style.left = Math.max(4, Math.min(leftPx, maxLeft)) + "px";
            tip.style.top = "4px";
        });
    }

    /* ==================================================================
       STRISCIA SOC — stesso asse x, riquadro separato
       ================================================================== */
    function renderSoc(host, points) {
        if (!host) { return; }
        if (!points || points.length < 2) { clear(host); return; }

        var kiosk = isKiosk();
        var width = Math.max(280, Math.round(host.clientWidth || 600));
        var height = fitHeight(host, kiosk ? 96 : 74);
        var padL = kiosk ? 84 : 46;
        var padR = kiosk ? 24 : 14;
        var padT = kiosk ? 12 : 10;
        var padB = kiosk ? 12 : 10;
        var plotW = width - padL - padR;
        var plotH = height - padT - padB;
        if (plotW <= 0 || plotH <= 0) { return; }

        var xOf = function (p) { return padL + (p.t / DAY_MIN) * plotW; };
        var yOf = function (v) { return padT + plotH - (EF.clamp(v, 0, 100) / 100) * plotH; };

        clear(host);
        var s = svgRoot(width, height);

        var g = EF.svg("g", { "class": "chart__grid" });
        // Stessa logica del grafico sopra: sotto una certa altezza il 50%
        // sparisce, perché tre etichette non ci starebbero senza toccarsi.
        var marks = plotH >= (kiosk ? 56 : 46) ? [0, 50, 100] : [0, 100];
        marks.forEach(function (v) {
            var y = yOf(v);
            g.appendChild(EF.svg("line", { x1: padL, x2: padL + plotW, y1: y.toFixed(1), y2: y.toFixed(1) }));
            var t = EF.svg("text", {
                x: padL - 8, y: (y + 4).toFixed(1), "text-anchor": "end", "class": "tick"
            });
            t.textContent = v + "%";
            g.appendChild(t);
        });
        s.appendChild(g);

        var lbl = EF.svg("text", { x: padL, y: (padT - 2).toFixed(1), "class": "tick" });
        lbl.textContent = "Carica batteria";
        s.appendChild(lbl);

        var areaD = pathFrom(points, xOf, function (p) { return yOf(p.soc); }) +
            " L " + xOf(points[points.length - 1]).toFixed(1) + " " + yOf(0).toFixed(1) +
            " L " + xOf(points[0]).toFixed(1) + " " + yOf(0).toFixed(1) + " Z";
        var area = EF.svg("path", { "class": "series-area", d: areaD });
        area.style.fill = "var(--role-battery)";
        s.appendChild(area);

        var line = EF.svg("path", {
            "class": "series-line",
            d: pathFrom(points, xOf, function (p) { return yOf(p.soc); })
        });
        line.style.stroke = "var(--role-battery)";
        s.appendChild(line);

        host.appendChild(s);
    }

    /* ==================================================================
       ENERGIE — due barre impilate, ognuna un vero intero
       ==================================================================
       Non si impilano grandezze scorrelate ("prodotta + consumata +
       importata"): la somma non significherebbe niente. Si impilano due
       decomposizioni vere:
         Produzione = autoconsumata + esportata
         Consumo    = dall'impianto + dalla rete (+ EPS)
       Così ogni segmento è una frazione di un intero che esiste davvero.

       Il MODELLO arriva già fatto da app.js (energyModel): qui non si decide
       più cosa sia "autoconsumata", si disegna. Prima la decomposizione era
       scritta due volte — una qui per le barre e una in app.js per gli indici
       — ed erano due fonti di verità per lo stesso numero. Ora la funzione
       serve senza modifiche sia alla giornata sia a un periodo di 229 giorni,
       perché la forma del modello è la stessa.
       ================================================================== */
    function renderEnergy(host, model) {
        if (!host) { return; }

        if (!model) {
            empty(host, "Bilancio non disponibile",
                "Il backend non espone ancora i contatori di energia giornalieri.");
            return;
        }

        clear(host);

        bar(host, model.producedLabel || "Prodotta", model.production, [
            { label: "autoconsumata", value: model.selfUsed, role: "solar" },
            { label: "esportata", value: model.exported, role: "grid" }
        ], model.productionNote);

        var segs = [
            { label: "dall'impianto", value: model.fromPlant, role: "solar" },
            { label: "dalla rete", value: model.imported, role: "grid" }
        ];
        if (model.eps > 0) { segs.push({ label: "da EPS", value: model.eps, role: "battery" }); }

        bar(host, model.consumedLabel || "Consumata", model.consumption, segs,
            model.consumptionNote);
    }

    function bar(host, title, total, segments, note) {
        var wrap = document.createElement("div");
        wrap.className = "stackbar";

        var head = document.createElement("p");
        head.className = "stackbar__label";
        var left = document.createElement("span");
        left.textContent = title;
        if (note) {
            // La nota porta i numeri che NON stanno nella barra (resa DC,
            // flussi interni della batteria): sono informazione, ma non
            // frazioni dell'intero che la barra rappresenta.
            var small = document.createElement("span");
            small.className = "stackbar__note";
            small.textContent = note;
            left.appendChild(small);
        }
        var right = document.createElement("b");
        right.className = "tnum";
        right.textContent = EF.energy(total) + " kWh";
        head.appendChild(left);
        head.appendChild(right);
        wrap.appendChild(head);

        var track = document.createElement("div");
        track.className = "stackbar__track";
        var sum = segments.reduce(function (a, s) { return a + Math.max(0, s.value); }, 0);

        segments.forEach(function (seg) {
            var v = Math.max(0, seg.value);
            if (sum <= 0) { return; }
            var pct = (v / sum) * 100;
            if (pct <= 0) { return; }
            var el = document.createElement("div");
            el.className = "stackbar__seg";
            el.setAttribute("data-role", seg.role);
            el.style.width = pct.toFixed(2) + "%";
            /* Il valore sta nel title e nella legenda testuale sotto, non
               stampato dentro un segmento che potrebbe essere largo 4px:
               un'etichetta ritagliata è peggio di nessuna etichetta. */
            el.title = seg.label + ": " + EF.energy(v) + " kWh";
            track.appendChild(el);
        });

        if (sum <= 0) {
            var none = document.createElement("div");
            none.className = "stackbar__seg";
            none.style.width = "100%";
            track.appendChild(none);
        }
        wrap.appendChild(track);

        /* Legenda testuale per segmento: identità mai affidata al solo colore.
           Sul kiosk si salta — non per risparmiare, ma perché lì la legenda
           dei tre ruoli è già in testa alla card, una sola per entrambe le
           barre: ripeterla sotto ciascuna costerebbe l'altezza dell'intera
           banda per dire due volte la stessa cosa. L'identità resta portata
           da una legenda visibile, che è ciò che la regola chiede. */
        if (isKiosk()) {
            host.appendChild(wrap);
            return;
        }

        var legend = document.createElement("p");
        legend.className = "legend";
        segments.forEach(function (seg) {
            if (seg.value <= 0) { return; }
            var item = document.createElement("span");
            item.className = "legend__item";
            item.setAttribute("data-role", seg.role);
            var sw = document.createElement("span");
            sw.className = "swatch";
            sw.setAttribute("aria-hidden", "true");
            item.appendChild(sw);
            item.appendChild(document.createTextNode(
                seg.label + " " + EF.energy(seg.value) + " kWh"));
            legend.appendChild(item);
        });
        wrap.appendChild(legend);

        host.appendChild(wrap);
    }

    /* ==================================================================
       STORICO MULTI-GIORNO — colonne affiancate, mai una torta
       ==================================================================
       Una colonna per giorno (settimana, mese) o per mese (anno), due serie
       AFFIANCATE e non impilate: produzione e consumo non sono le parti di
       un intero, e impilarle inventerebbe un totale che nessuno consuma.

       Il colore viene dai token di ruolo già in uso ovunque (--role-solar,
       --role-home): un data-role sul segno, mai un colore scritto qui. Così
       la colonna "Produzione" è dello stesso arancio del nodo Fotovoltaico e
       della curva di oggi, e chi ha imparato il colore una volta lo riusa.

       `bands` è la struttura comune anche alla striscia degli scambi e alla
       tabella nascosta: un solo posto in cui un giorno diventa una riga.

         { key, tick, label, pv, home, imp, exp, chg, dis, missing, partial }

       Un giorno senza dati ha missing:true e NON disegna una colonna a zero:
       "il sistema era spento" e "la casa non ha consumato niente" sono due
       fatti diversi e devono avere due segni diversi (qui: nessun segno).
       ================================================================== */
    var BAR_GAP = 2;        // il distacco lo fa la superficie, non un bordo
    var BAR_MAX = 24;       // colonne sottili: il dato è l'unica cosa densa
    var BAR_RADIUS = 4;     // estremo dati arrotondato, base squadrata

    /* Colonna con gli angoli arrotondati sull'estremo che porta il DATO e
       squadrati sulla linea di base, che è un riferimento e deve restare
       dritta. `down = true` specchia l'arrotondamento in basso: nella
       striscia degli scambi la metà inferiore cresce verso il basso, quindi
       il suo estremo dati è quello di sotto. */
    function colPath(x, y, w, h, down) {
        if (h <= 0) { return ""; }
        var r = Math.min(BAR_RADIUS, w / 2, h);
        var x2 = x + w, y2 = y + h;
        if (down) {
            return "M " + x.toFixed(1) + " " + y.toFixed(1) +
                " L " + x.toFixed(1) + " " + (y2 - r).toFixed(1) +
                " Q " + x.toFixed(1) + " " + y2.toFixed(1) + " " + (x + r).toFixed(1) + " " + y2.toFixed(1) +
                " L " + (x2 - r).toFixed(1) + " " + y2.toFixed(1) +
                " Q " + x2.toFixed(1) + " " + y2.toFixed(1) + " " + x2.toFixed(1) + " " + (y2 - r).toFixed(1) +
                " L " + x2.toFixed(1) + " " + y.toFixed(1) + " Z";
        }
        return "M " + x.toFixed(1) + " " + y2.toFixed(1) +
            " L " + x.toFixed(1) + " " + (y + r).toFixed(1) +
            " Q " + x.toFixed(1) + " " + y.toFixed(1) + " " + (x + r).toFixed(1) + " " + y.toFixed(1) +
            " L " + (x2 - r).toFixed(1) + " " + y.toFixed(1) +
            " Q " + x2.toFixed(1) + " " + y.toFixed(1) + " " + x2.toFixed(1) + " " + (y + r).toFixed(1) +
            " L " + x2.toFixed(1) + " " + y2.toFixed(1) + " Z";
    }

    /* Larghezza di banda e posizione del gruppo. La banda è la larghezza
       CLICCABILE (e la zona di hover), il gruppo è l'inchiostro: la
       differenza è aria, ed è quella che rende leggibile un mese da 31
       colonne. */
    function bandGeom(count, plotW, seriesCount) {
        var bw = plotW / Math.max(1, count);
        var gw = Math.min(bw * 0.78, seriesCount * BAR_MAX + (seriesCount - 1) * BAR_GAP);
        var barW = Math.max(1, (gw - BAR_GAP * (seriesCount - 1)) / seriesCount);
        return { bw: bw, gw: barW * seriesCount + BAR_GAP * (seriesCount - 1), barW: barW };
    }

    /* Etichette dell'asse x: quante ce ne stanno, non quante ce ne sono.
       Con 31 giorni e 600px, una etichetta per banda diventa una macchia
       grigia; si tiene un passo che lascia respiro e si parte dall'ULTIMA
       banda, perché il giorno più recente è quello che si cerca per primo. */
    function tickStep(bands, bw, kiosk) {
        var maxLen = 0;
        bands.forEach(function (b) { if (b.tick) { maxLen = Math.max(maxLen, b.tick.length); } });
        var w = maxLen * (kiosk ? 12 : 6.6) + 10;
        return Math.max(1, Math.ceil(w / Math.max(1, bw)));
    }

    /* Testo di un tick e larghezza del margine che lo deve contenere.
       Il carattere è quello dei tick (11px compatta, 22px kiosk): la stima a
       0.6em per carattere è larga abbastanza per le cifre tabulari. */
    function tickText(v, unit) {
        return EF.dec(v, v >= 10 || v === 0 ? 0 : 1) + (unit ? " " + unit : "");
    }

    function axisPad(label, kiosk) {
        var per = kiosk ? 12.5 : 6.6;
        return Math.max(kiosk ? 84 : 46, Math.round(label.length * per) + 14);
    }

    function yAxis(s, bands, top, padL, plotW, padT, plotH, kiosk, unit) {
        var g = EF.svg("g", { "class": "chart__grid" });
        var tickH = kiosk ? 26 : 14;
        var steps = plotH / tickH >= 5 ? 4 : (plotH / tickH >= 3 ? 2 : 1);
        for (var i = 0; i <= steps; i++) {
            var val = (top / steps) * i;
            var y = padT + plotH - (val / top) * plotH;
            g.appendChild(EF.svg("line", {
                x1: padL, x2: padL + plotW, y1: y.toFixed(1), y2: y.toFixed(1)
            }));
            var t = EF.svg("text", {
                x: padL - 8, y: (y + 4).toFixed(1), "text-anchor": "end", "class": "tick"
            });
            // L'unità sta SOLO sul tick più alto: ripeterla su ognuno è rumore.
            t.textContent = tickText(val, i === steps ? unit : null);
            g.appendChild(t);
        }
        s.appendChild(g);
    }

    function xTicks(s, bands, geom, padL, padT, plotH, kiosk) {
        var g = EF.svg("g", { "class": "chart__grid" });
        var step = tickStep(bands, geom.bw, kiosk);
        var n = bands.length;
        bands.forEach(function (b, i) {
            if (!b.tick) { return; }
            if ((n - 1 - i) % step !== 0) { return; }
            var t = EF.svg("text", {
                x: (padL + geom.bw * (i + 0.5)).toFixed(1),
                y: (padT + plotH + (kiosk ? 30 : 17)).toFixed(1),
                "text-anchor": "middle", "class": "tick"
            });
            t.textContent = b.tick;
            g.appendChild(t);
        });
        s.appendChild(g);
    }

    function renderColumns(host, bands, opts) {
        if (!host) { return; }
        opts = opts || {};
        if (!bands || !bands.length) {
            empty(host, "Nessun giorno nel periodo",
                opts.emptyDetail || "L'archivio non copre queste date.");
            return;
        }

        var kiosk = isKiosk();
        var width = Math.max(280, Math.round(host.clientWidth || 600));
        var height = opts.height || fitHeight(host, kiosk ? 260 : 210);

        var maxV = 0;
        bands.forEach(function (b) {
            if (b.missing) { return; }
            if (b.pv > maxV) { maxV = b.pv; }
            if (b.home > maxV) { maxV = b.home; }
        });
        var top = niceMax(maxV * 1.12);

        /* Il margine sinistro si misura sull'etichetta più lunga che ci
           dovrà stare, non su una costante: un anno intero arriva a "2000
           kWh", e in 46px quel testo usciva dal riquadro fino a toccare il
           bordo della card. */
        var padL = axisPad(tickText(top, "kWh"), kiosk);
        var padR = kiosk ? 24 : 14;
        var padT = kiosk ? 24 : 18;
        var padB = kiosk ? 42 : 26;
        var plotW = width - padL - padR;
        var plotH = height - padT - padB;
        if (plotW <= 0 || plotH <= 0) { return; }

        clear(host);
        var s = svgRoot(width, height);
        s.setAttribute("role", "img");
        s.setAttribute("aria-label", opts.ariaLabel || "Produzione e consumo per giorno");

        yAxis(s, bands, top, padL, plotW, padT, plotH, kiosk, "kWh");

        var geom = bandGeom(bands.length, plotW, 2);
        var baseY = padT + plotH;
        var yOf = function (v) { return baseY - (Math.max(0, v) / top) * plotH; };

        // Fondo di evidenziazione della banda sotto il puntatore: sta PRIMA
        // delle colonne, così le schiarisce senza coprirle.
        /* Larghezza 0 da spenta, non "spostata fuori": con una banda
           settimanale da 186px, portarla a x=-99 ne lasciava 87 in vista
           come una fascia grigia permanente sul bordo sinistro. */
        var hi = EF.svg("rect", {
            "class": "band-hi", x: padL, y: padT, width: 0, height: plotH
        });
        s.appendChild(hi);

        xTicks(s, bands, geom, padL, padT, plotH, kiosk);

        var gCols = EF.svg("g", { "class": "cols" });
        var peak = null;
        bands.forEach(function (b, i) {
            if (b.missing) { return; }
            var x0 = padL + geom.bw * i + (geom.bw - geom.gw) / 2;
            [["pv", "solar"], ["home", "home"]].forEach(function (pair, k) {
                var v = b[pair[0]];
                if (!(v > 0)) { return; }
                var y = yOf(v);
                var d = colPath(x0 + k * (geom.barW + BAR_GAP), y, geom.barW, baseY - y);
                if (!d) { return; }
                var p = EF.svg("path", { "class": "col", d: d });
                p.setAttribute("data-role", pair[1]);
                gCols.appendChild(p);
            });
            if (peak === null || b.pv > bands[peak].pv) { peak = i; }
        });
        s.appendChild(gCols);

        // Asse di base sopra le colonne: la linea dello zero resta netta.
        s.appendChild(EF.svg("line", {
            "class": "axis-line", x1: padL, x2: padL + plotW,
            y1: baseY.toFixed(1), y2: baseY.toFixed(1)
        }));

        /* UNA sola etichetta diretta: il giorno di produzione massima.
           Un numero su ogni colonna sarebbe illeggibile e non lo guarderebbe
           nessuno; il picco è l'unica cosa che l'asse non racconta già. */
        if (peak !== null && bands[peak].pv > top * 0.15) {
            var px = padL + geom.bw * (peak + 0.5);
            var py = yOf(bands[peak].pv) - (kiosk ? 12 : 7);
            if (py > padT + 4) {
                var anchor = "middle";
                if (px < padL + 30) { anchor = "start"; }
                else if (px > padL + plotW - 30) { anchor = "end"; }
                var lab = EF.svg("text", {
                    x: px.toFixed(1), y: py.toFixed(1), "text-anchor": anchor, "class": "tick col__peak"
                });
                lab.textContent = EF.energy(bands[peak].pv) + " kWh";
                s.appendChild(lab);
            }
        }

        host.appendChild(s);

        if (!kiosk) { attachBandHover(host, s, bands, geom, padL, hi, plotW, padT, plotH); }
    }

    /* ==================================================================
       SCAMBI — striscia a due direzioni, STESSA scala di kWh
       ==================================================================
       Sopra lo zero l'energia che ENTRA in casa da fuori del sole di quel
       momento (prelievo dalla rete + scarica della batteria); sotto, quella
       che ESCE dall'impianto (immissione in rete + carica della batteria).

       Una sola scala di kWh per entrambe le direzioni — px per kWh identico
       sopra e sotto — quindi le due metà si confrontano davvero. Il fondo
       scala delle due metà è diverso solo per non sprecare metà riquadro
       quando si esporta dieci volte quello che si preleva.

       Il segno lo porta la direzione (sopra/sotto), l'identità la porta la
       tinta (rete / batteria): due canali per due informazioni diverse, mai
       lo stesso canale per entrambe.
       ================================================================== */
    function renderFlows(host, bands, opts) {
        if (!host) { return; }
        opts = opts || {};
        if (!bands || !bands.length) { clear(host); return; }

        var upMax = 0, downMax = 0;
        bands.forEach(function (b) {
            if (b.missing) { return; }
            upMax = Math.max(upMax, b.imp + b.dis);
            downMax = Math.max(downMax, b.exp + b.chg);
        });
        if (upMax <= 0 && downMax <= 0) { clear(host); return; }

        var kiosk = isKiosk();
        var width = Math.max(280, Math.round(host.clientWidth || 600));
        var height = opts.height || (kiosk ? 170 : 132);

        var upTop = upMax > 0 ? niceMax(upMax * 1.15) : 0;
        var downTop = downMax > 0 ? niceMax(downMax * 1.15) : 0;

        // Stesso margine calcolato del riquadro sopra, e per lo stesso motivo:
        // "1500" e "400 kWh" non entrano in 46px.
        var padL = Math.max(axisPad(tickText(upTop, "kWh"), kiosk),
            axisPad(tickText(downTop, null), kiosk));
        var padR = kiosk ? 24 : 14;
        var padT = kiosk ? 18 : 14;
        var padB = kiosk ? 18 : 14;
        var plotW = width - padL - padR;
        var plotH = height - padT - padB;
        if (plotW <= 0 || plotH <= 0) { return; }
        var span = upTop + downTop;
        if (span <= 0) { clear(host); return; }
        var zeroY = padT + plotH * (upTop / span);
        var perKwh = plotH / span;   // identico sopra e sotto: una sola scala

        clear(host);
        var s = svgRoot(width, height);
        s.setAttribute("role", "img");
        s.setAttribute("aria-label", opts.ariaLabel ||
            "Energia presa dalla rete e dalla batteria, e energia data alla rete e alla batteria, per giorno");

        var g = EF.svg("g", { "class": "chart__grid" });
        [[upTop, padT], [downTop, padT + plotH]].forEach(function (pair, idx) {
            if (pair[0] <= 0) { return; }
            g.appendChild(EF.svg("line", {
                x1: padL, x2: padL + plotW, y1: pair[1].toFixed(1), y2: pair[1].toFixed(1)
            }));
            var t = EF.svg("text", {
                x: padL - 8, y: (pair[1] + (idx === 0 ? 9 : 0)).toFixed(1),
                "text-anchor": "end", "class": "tick"
            });
            t.textContent = tickText(pair[0], idx === 0 ? "kWh" : null);
            g.appendChild(t);
        });
        s.appendChild(g);

        var geom = bandGeom(bands.length, plotW, 1);
        /* Larghezza 0 da spenta, non "spostata fuori": con una banda
           settimanale da 186px, portarla a x=-99 ne lasciava 87 in vista
           come una fascia grigia permanente sul bordo sinistro. */
        var hi = EF.svg("rect", {
            "class": "band-hi", x: padL, y: padT, width: 0, height: plotH
        });
        s.appendChild(hi);

        var gCols = EF.svg("g", { "class": "cols" });
        bands.forEach(function (b, i) {
            if (b.missing) { return; }
            var x0 = padL + geom.bw * i + (geom.bw - geom.gw) / 2;
            // Verso l'alto: prelievo (rete) impilato sopra la scarica (batteria).
            stack(gCols, x0, geom.barW, zeroY, -1, [
                { v: b.dis, role: "battery" },
                { v: b.imp, role: "grid" }
            ], perKwh);
            // Verso il basso: carica (batteria) e immissione (rete).
            stack(gCols, x0, geom.barW, zeroY, 1, [
                { v: b.chg, role: "battery" },
                { v: b.exp, role: "grid" }
            ], perKwh);
        });
        s.appendChild(gCols);

        // La linea dello zero è l'unico riferimento del riquadro.
        s.appendChild(EF.svg("line", {
            "class": "axis-line", x1: padL, x2: padL + plotW,
            y1: zeroY.toFixed(1), y2: zeroY.toFixed(1)
        }));

        [["↑ preso", padT + 10, "start"], ["↓ dato", padT + plotH - 2, "start"]].forEach(function (row) {
            var t = EF.svg("text", {
                x: (padL + 4).toFixed(1), y: row[1].toFixed(1),
                "text-anchor": row[2], "class": "tick"
            });
            t.textContent = row[0];
            s.appendChild(t);
        });

        host.appendChild(s);
        if (!kiosk) { attachBandHover(host, s, bands, geom, padL, hi, plotW, padT, plotH); }
    }

    /* Impila i segmenti in una direzione lasciando la superficie a fare da
       distacco: il vuoto, non un bordo disegnato (un bordo aggiungerebbe
       inchiostro che non è dato).

       Lo stacco si prende anche contro la LINEA DELLO ZERO, e non è un
       dettaglio: sopra lo zero il primo segmento è la scarica della batteria,
       sotto è la carica — stessa tinta. Senza quel millimetro di superficie
       le due si saldano in un unico blocco verde a cavallo dell'asse, e
       "presi 6 kWh, dati 8" si legge come "14 kWh di qualcosa".
       ------------------------------------------------------------------
       Le distanze si contano dallo zero: [cursor, cursor+h] è il segmento,
       il bordo interno guarda l'asse e quello esterno porta il dato. */
    function stack(parent, x, w, zeroY, dir, segs, perKwh) {
        var cursor = 0;
        segs.forEach(function (seg) {
            var v = Math.max(0, seg.v || 0);
            if (v <= 0) { return; }
            var h = v * perKwh;
            var inner = cursor + (cursor > 0 ? BAR_GAP : BAR_GAP / 2);
            var outer = cursor + h;
            var drawH = Math.max(0.8, outer - inner);
            var top = dir < 0 ? zeroY - inner - drawH : zeroY + inner;
            var p = EF.svg("path", {
                "class": "col", d: colPath(x, top, w, drawH, dir > 0)
            });
            p.setAttribute("data-role", seg.role);
            parent.appendChild(p);
            cursor += h;
        });
    }

    /* ------------------------------------------------------------------
       Hover di banda. Il bersaglio è la BANDA intera, non la colonna: una
       colonna di 6px in una vista mensile sarebbe un bersaglio da centrare
       col millimetro, e il valore finirebbe raggiungibile solo dalla
       tabella. La stessa lettura completa esce ovunque cada il puntatore.
       ------------------------------------------------------------------ */
    function attachBandHover(host, s, bands, geom, padL, hi, plotW, padT, plotH) {
        /* Piano di cattura trasparente sopra tutto.
           Un <svg> non riceve pointermove nello spazio VUOTO fra un segno e
           l'altro: l'hit test guarda i figli dipinti, quindi il tooltip
           usciva solo centrando una colonna da 6px — cioè quasi mai, e
           proprio nella vista mensile dove serve di più. Un rettangolo con
           pointer-events:all copre l'intera area di disegno e rende il
           bersaglio la BANDA, non il segno. */
        var hit = EF.svg("rect", {
            "class": "band-hit", x: padL, y: padT, width: Math.max(1, plotW), height: plotH
        });
        s.appendChild(hit);

        var tip = document.createElement("div");
        tip.className = "chart-tip";
        host.style.position = "relative";
        host.appendChild(tip);

        function hide() {
            tip.style.opacity = "0";
            hi.setAttribute("width", "0");
        }

        s.addEventListener("pointerleave", hide);
        s.addEventListener("pointermove", function (ev) {
            var box = s.getBoundingClientRect();
            var k = box.width ? (s.viewBox.baseVal.width / box.width) : 1;
            var mx = (ev.clientX - box.left) * k;
            var i = Math.floor((mx - padL) / geom.bw);
            if (i < 0 || i >= bands.length) { hide(); return; }

            var b = bands[i];
            hi.setAttribute("x", (padL + geom.bw * i).toFixed(1));
            hi.setAttribute("width", Math.max(1, geom.bw).toFixed(1));
            fillTip(tip, b);
            tip.style.opacity = "1";

            var leftPx = ((padL + geom.bw * (i + 0.5)) / k) - tip.offsetWidth / 2;
            var maxLeft = box.width - tip.offsetWidth - 6;
            tip.style.left = Math.max(4, Math.min(leftPx, maxLeft)) + "px";
            tip.style.top = "2px";
        });
    }

    function fillTip(tip, b) {
        clear(tip);

        var title = document.createElement("strong");
        title.className = "chart-tip__title";
        title.textContent = b.label + (b.partial ? " · in corso" : "");
        tip.appendChild(title);

        if (b.missing) {
            var none = document.createElement("span");
            none.className = "chart-tip__none";
            none.textContent = "nessun dato";
            tip.appendChild(none);
            return;
        }

        /* Il valore è l'elemento forte e l'etichetta il secondario: qui chi
           guarda ha già la serie sotto il puntatore e vuole il numero. */
        [
            ["solar", "Produzione", EF.energy(b.pv) + " kWh"],
            ["home", "Consumo", EF.energy(b.home) + " kWh"],
            ["grid", "Rete", "+" + EF.energy(b.imp) + " / −" + EF.energy(b.exp)],
            ["battery", "Batteria", "+" + EF.energy(b.chg) + " / −" + EF.energy(b.dis)]
        ].forEach(function (row) {
            var line = document.createElement("span");
            line.className = "chart-tip__row";

            var key = document.createElement("span");
            key.className = "chart-tip__key";
            key.setAttribute("data-role", row[0]);
            var mark = document.createElement("span");
            mark.className = "chart-tip__mark";
            mark.setAttribute("aria-hidden", "true");
            key.appendChild(mark);
            key.appendChild(document.createTextNode(row[1]));

            var val = document.createElement("b");
            val.className = "chart-tip__val tnum";
            val.textContent = row[2];

            line.appendChild(key);
            line.appendChild(val);
            tip.appendChild(line);
        });
    }

    /* ==================================================================
       METER AD ARCO — autosufficienza e autoconsumo
       ================================================================== */
    function renderMeters(host, values) {
        if (!host) { return; }
        clear(host);
        if (!values || !values.length) {
            empty(host, "Indici non disponibili", "Servono i contatori di energia del backend.");
            return;
        }
        values.forEach(function (m) { meter(host, m); });
    }

    function meter(host, spec) {
        var size = isKiosk() ? 150 : 118;
        var stroke = isKiosk() ? 14 : 11;
        var r = (size - stroke) / 2;
        // Semicerchio: 180 gradi bastano, e lasciano il centro libero per il
        // numero, che è il vero contenuto.
        var cx = size / 2, cy = size / 2 + r * 0.35;
        var len = Math.PI * r;

        var wrap = document.createElement("div");
        wrap.className = "meter";
        wrap.setAttribute("data-role", spec.role || "solar");

        var s = document.createElementNS(NS, "svg");
        s.setAttribute("class", "meter__svg");
        s.setAttribute("viewBox", "0 0 " + size + " " + (cy + stroke));
        s.setAttribute("width", size);
        s.setAttribute("height", cy + stroke);
        s.setAttribute("role", "img");
        s.setAttribute("aria-label", spec.label + ": " + EF.percent(spec.value) + " per cento");

        var d = "M " + (cx - r) + " " + cy + " A " + r + " " + r + " 0 0 1 " + (cx + r) + " " + cy;

        var track = EF.svg("path", { "class": "meter__track", d: d, "stroke-width": stroke });
        s.appendChild(track);

        var fill = EF.svg("path", {
            "class": "meter__fill", d: d, "stroke-width": stroke,
            "stroke-dasharray": len.toFixed(1),
            "stroke-dashoffset": (len * (1 - EF.clamp(spec.value, 0, 100) / 100)).toFixed(1)
        });
        s.appendChild(fill);
        wrap.appendChild(s);

        var val = document.createElement("p");
        val.className = "meter__value tnum";
        val.textContent = EF.percent(spec.value) + "%";
        wrap.appendChild(val);

        var lab = document.createElement("p");
        lab.className = "meter__label";
        lab.textContent = spec.label;
        wrap.appendChild(lab);

        host.appendChild(wrap);
    }

    EF.charts = {
        renderDay: renderDay,
        renderSoc: renderSoc,
        renderEnergy: renderEnergy,
        renderMeters: renderMeters,
        renderColumns: renderColumns,
        renderFlows: renderFlows,
        empty: empty
    };
})();
