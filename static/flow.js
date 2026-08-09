/* ============================================================================
   EnergyFlow — diagramma di flusso a geometria MISURATA.

   IL BUG CHE QUESTO FILE ESISTE PER ELIMINARE
   ------------------------------------------------------------------------
   La versione precedente disegnava quattro curve di Bézier con coordinate
   scritte a mano dentro un viewBox="0 0 800 400" con
   preserveAspectRatio="none", mentre i nodi vivevano in una griglia CSS.
   Due sistemi di coordinate scollegati: appena il contenitore cambiava
   rapporto d'aspetto, l'SVG si deformava in modo anisotropo (x e y scalati
   di fattori diversi) e i nodi no. Le curve partivano dal vuoto. Sul
   pannello verticale, dove il rapporto è ribaltato, il risultato era
   inguardabile — tanto che su mobile la "soluzione" adottata era stata un
   display:none !important sull'SVG.

   LA CORREZIONE
   ------------------------------------------------------------------------
   1. Il viewBox è in pixel CSS REALI del contenitore, 1:1, aggiornato da un
      ResizeObserver. Con viewBox e dimensione dell'elemento identici non
      esiste alcun fattore di scala, quindi nessuna deformazione è possibile.
   2. Gli ancoraggi si MISURANO con getBoundingClientRect() sui dischi dei
      nodi, relativi al contenitore. Il punto di attacco è l'intersezione fra
      il bordo del disco e la retta verso il nodo di destinazione.
   3. La `d` cubica viene generata da quelle misure, mai scritta.

   In questo file non esiste una sola costante geometrica, e nemmeno nel CSS
   o nell'HTML: cambiare la dimensione dei dischi in components.css riattacca
   gli archi da solo.
   ========================================================================= */
(function () {
    "use strict";

    var EF = window.EF;

    /* Sotto questa soglia il flusso è rumore di misura, non un trasferimento:
       l'arco resta grigio e fermo. Un filo che striscia per 4 W racconta
       un'attività che non c'è. */
    var IDLE_W = 20;

    /* Distacco fra il bordo del disco e l'inizio del tratto: senza, la
       punta dell'arco si infila sotto il bordo spesso del nodo. */
    var GAP = 6;

    /* Gli archi del sistema. Topologia a stella con l'inverter al centro:
       è la topologia fisica reale dell'impianto, non una semplificazione.

       COLORE — ogni arco veste il colore del proprio estremo NON-inverter.
       Nei casi informativi (sole che produce, batteria che scarica, rete che
       importa) quell'estremo È la sorgente, quindi la regola "colore della
       sorgente" è rispettata. Ma quando il segno si inverte — la batteria si
       carica, la rete riceve export — la sorgente diventa l'inverter, e
       colorare l'arco di grigio lo farebbe cambiare tinta a metà giornata.
       Un'entità che cambia colore quando cambia stato è esattamente ciò che
       fa perdere il filo a chi guarda: "la rete è blu" deve restare vero
       sempre. La direzione la portano l'animazione e la freccia, non la tinta.

       `sign`: quale campo decide il verso, e cosa significa il segno positivo.
       Verso canonico = dal nodo `from` al nodo `to`. */
    var ARCS = [
        { id: "pv", from: "pv", to: "inverter", role: "solar", field: "solar" },
        { id: "home", from: "inverter", to: "home", role: "home", field: "home" },
        { id: "battery", from: "inverter", to: "battery", role: "battery", field: "battery", bidir: true },
        { id: "grid", from: "grid", to: "inverter", role: "grid", field: "grid", bidir: true }
    ];

    var svg = null;
    var container = null;
    var nodesLayer = null;
    var built = false;
    var parts = {};       // id -> {group, track, flow, arrow}
    var lastState = null; // per ridisegnare al resize senza rifare la fetch

    /* ------------------------------------------------------------------
       SEMANTICA DEI FLUSSI — unica, per tutte le viste.

       La vista 3D è stata rimossa una prima volta anche per questo: il suo
       update3D deduceva il verso della batteria da un'euristica giorno/notte
       invece di leggere battery_power_w, e finiva per raccontare una carica
       mentre il diagramma 2D, sugli stessi identici dati, mostrava una
       scarica. Due viste degli stessi numeri che si contraddicono sono
       peggio di una vista sola.

       Da qui in avanti la direzione, la soglia di inattività e il rapporto
       sul fondoscala si calcolano UNA volta, qui dentro. La 2D li traduce in
       spessore e animazione dell'arco, la 3D in particelle e velocità: chi
       disegna non decide più cosa significano i segni.

       Convenzione dei segni, quella del backend, senza riscritture:
         solar   ≥ 0  produzione
         home    ≥ 0  consumo
         grid    > 0  PRELIEVO dalla rete   (verso canonico grid -> inverter)
         battery > 0  CARICA della batteria (verso canonico inverter -> battery)
       ------------------------------------------------------------------ */
    function resolve(state) {
        var s = state || {};
        var scale = EF.num(s.scaleW) || 6000;
        return ARCS.map(function (arc) {
            var value = EF.num(s[arc.field]);
            var magnitude = value === null ? 0 : Math.abs(value);
            return {
                id: arc.id,
                from: arc.from,
                to: arc.to,
                role: arc.role,
                field: arc.field,
                value: value,
                magnitude: magnitude,
                /* Sotto soglia il flusso è rumore di misura, non un
                   trasferimento: nessuna vista deve animarlo. */
                idle: magnitude < IDLE_W,
                ratio: EF.clamp(magnitude / scale, 0, 1),
                /* Il verso si legge SOLO dal segno del campo, e solo per gli
                   archi che possono davvero invertirsi. */
                reversed: !!arc.bidir && value !== null && value < 0
            };
        });
    }

    /* ------------------------------------------------------------------
       Misura: centro e raggio di un disco, in coordinate dell'SVG.

       Il riferimento è il rettangolo dell'SVG, NON quello di .flow.
       L'SVG è in position:absolute con inset:0, quindi è ancorato al
       padding box del contenitore: il bordo da 1px di .flow lo rende due
       pixel più piccolo del suo border box. Misurare rispetto a .flow
       introduceva uno scarto costante di 1px per lato fra il sistema di
       coordinate dei nodi e quello del viewBox — piccolo, ma esattamente
       la classe di errore che questo file esiste per non commettere.
       ------------------------------------------------------------------ */
    function measure(nodeName, base) {
        var node = nodesLayer.querySelector('[data-node="' + nodeName + '"] [data-anchor]');
        if (!node) { return null; }
        var r = node.getBoundingClientRect();
        if (!r.width || !r.height) { return null; }
        return {
            x: r.left - base.left + r.width / 2,
            y: r.top - base.top + r.height / 2,
            // I dischi sono cerchi: il raggio è la metà del lato minore.
            r: Math.min(r.width, r.height) / 2
        };
    }

    /* ------------------------------------------------------------------
       Spazio da lasciare libero agli overlay (regola #22).

       Gli slot sono sovrapposti al diagramma: senza riservare spazio, la
       riga di nodi in basso finisce SOTTO la legenda e la copre — che è
       proprio ciò che la regola vieta. La quota non è scritta a mano ma
       MISURATA sugli slot occupati, così vale sia in modalità compatta sia
       sul kiosk, e si riadatta da sola quando compare un banner o quando la
       legenda va a capo.
       ------------------------------------------------------------------ */
    function reserveForSlots() {
        var slots = container.querySelector(".slots");
        if (!slots) { return; }

        function bandHeight(names) {
            var max = 0;
            names.forEach(function (n) {
                var slot = slots.querySelector(".slot--" + n);
                if (!slot) { return; }
                for (var i = 0; i < slot.children.length; i++) {
                    var child = slot.children[i];
                    if (child.hidden || child.offsetParent === null) { continue; }
                    var h = child.getBoundingClientRect().height;
                    if (h > max) { max = h; }
                }
            });
            return max;
        }

        // padding degli slot (--space-3) su entrambi i lati della banda
        var pad = parseFloat(getComputedStyle(slots).paddingTop) || 0;
        var top = bandHeight(["tl", "tc", "tr"]);
        var bottom = bandHeight(["bl", "bc", "br"]);

        nodesLayer.style.paddingTop = (top ? top + pad * 1.5 : 0) + "px";
        nodesLayer.style.paddingBottom = (bottom ? bottom + pad * 1.5 : 0) + "px";
    }

    /* Punto di attacco sul bordo del disco nella direzione del bersaglio. */
    function attach(from, to) {
        var dx = to.x - from.x;
        var dy = to.y - from.y;
        var len = Math.sqrt(dx * dx + dy * dy);
        if (!len) { return { x: from.x, y: from.y }; }
        var d = from.r + GAP;
        return { x: from.x + (dx / len) * d, y: from.y + (dy / len) * d };
    }

    /* Cubica con i punti di controllo allineati all'asse dominante: gli
       archi prevalentemente verticali escono verticali (il caso del
       pannello a muro), quelli orizzontali escono orizzontali. */
    function cubic(a, b) {
        var dx = b.x - a.x;
        var dy = b.y - a.y;
        var k = 0.45;
        var c1, c2;
        if (Math.abs(dy) >= Math.abs(dx)) {
            c1 = { x: a.x, y: a.y + dy * k };
            c2 = { x: b.x, y: b.y - dy * k };
        } else {
            c1 = { x: a.x + dx * k, y: a.y };
            c2 = { x: b.x - dx * k, y: b.y };
        }
        return "M " + a.x.toFixed(1) + " " + a.y.toFixed(1) +
            " C " + c1.x.toFixed(1) + " " + c1.y.toFixed(1) +
            " " + c2.x.toFixed(1) + " " + c2.y.toFixed(1) +
            " " + b.x.toFixed(1) + " " + b.y.toFixed(1);
    }

    /* Spessore proporzionale alla potenza, con esponente 0.6: una radice
       addolcita. Lineare schiaccerebbe tutti i flussi domestici (qualche
       centinaio di watt su un fondoscala di alcuni kW) sullo spessore
       minimo, rendendo il canale inutile proprio nell'intervallo in cui si
       vive quasi sempre. */
    function widthFor(ratio) {
        return EF.clamp(3 + 11 * Math.pow(ratio, 0.6), 3, 14);
    }

    /* Più potenza, più veloce. A fondoscala 0.35 s, a flusso nullo 2.5 s. */
    function durationFor(ratio) {
        return EF.clamp(2.5 * (1 - ratio), 0.35, 2.5).toFixed(2) + "s";
    }

    /* ------------------------------------------------------------------
       Costruzione (una sola volta)
       ------------------------------------------------------------------ */
    function build() {
        if (built) { return; }
        ARCS.forEach(function (arc) {
            var g = EF.svg("g", { "class": "arc", "data-arc": arc.id });
            g.setAttribute("data-role", arc.role);
            var track = EF.svg("path", { "class": "arc__track" });
            var flow = EF.svg("path", { "class": "arc__flow" });
            var arrow = EF.svg("polygon", { "class": "arc__arrow" });
            g.appendChild(track);
            g.appendChild(flow);
            g.appendChild(arrow);
            svg.appendChild(g);
            parts[arc.id] = { group: g, track: track, flow: flow, arrow: arrow };
        });
        built = true;
    }

    /* Freccia statica a metà arco. Compare solo con prefers-reduced-motion
       (lo decide il CSS), ma la si calcola sempre: così non serve una
       seconda strada di codice per il caso accessibile, che è quella che poi
       non viene mai provata e si rompe in silenzio. */
    function placeArrow(poly, path, reversed, size) {
        var total;
        try {
            total = path.getTotalLength();
        } catch (e) {
            // getTotalLength esplode se la `d` non è ancora valida.
            poly.setAttribute("points", "");
            return;
        }
        if (!total) { poly.setAttribute("points", ""); return; }

        var mid = path.getPointAtLength(total / 2);
        var step = Math.min(6, total / 4);
        var ahead = path.getPointAtLength(EF.clamp(total / 2 + step, 0, total));
        var behind = path.getPointAtLength(EF.clamp(total / 2 - step, 0, total));

        var dx = ahead.x - behind.x;
        var dy = ahead.y - behind.y;
        if (reversed) { dx = -dx; dy = -dy; }
        var len = Math.sqrt(dx * dx + dy * dy) || 1;
        var ux = dx / len, uy = dy / len;
        // Normale, per i due vertici di base del triangolo.
        var nx = -uy, ny = ux;
        var h = size * 1.5;

        var p1 = (mid.x + ux * h) + "," + (mid.y + uy * h);
        var p2 = (mid.x - ux * h * .4 + nx * size) + "," + (mid.y - uy * h * .4 + ny * size);
        var p3 = (mid.x - ux * h * .4 - nx * size) + "," + (mid.y - uy * h * .4 - ny * size);
        poly.setAttribute("points", p1 + " " + p2 + " " + p3);
    }

    /* ------------------------------------------------------------------
       Ridisegno completo: misura + geometria + resa dinamica.
       ------------------------------------------------------------------ */
    function draw() {
        if (!container || !svg) { return; }

        /* Prima si riserva lo spazio agli overlay: sposta i nodi, quindi va
           fatto PRIMA di misurarli, non dopo. */
        reserveForSlots();

        var box = svg.getBoundingClientRect();
        if (!box.width || !box.height) { return; }

        /* Il viewBox segue i pixel CSS reali dell'SVG, 1:1. È questo che
           rende impossibile la deformazione: non c'è nessuna scala da
           sbagliare. preserveAspectRatio è scritto esplicitamente perché il
           "none" di prima non torni per distrazione. */
        svg.setAttribute("viewBox", "0 0 " + box.width.toFixed(1) + " " + box.height.toFixed(1));
        svg.setAttribute("preserveAspectRatio", "xMidYMid meet");

        build();

        var centers = {};
        ["pv", "inverter", "battery", "home", "grid"].forEach(function (n) {
            centers[n] = measure(n, box);
        });

        /* Gli stessi oggetti che riceve la vista 3D: la geometria è di questo
           file, il significato dei numeri no. */
        resolve(lastState).forEach(function (arc) {
            var p = parts[arc.id];
            var a = centers[arc.from];
            var b = centers[arc.to];
            if (!p) { return; }

            if (!a || !b) {
                // Nodo non misurabile (non ancora nel layout): niente `d`,
                // così non si disegna una curva verso l'origine.
                p.track.removeAttribute("d");
                p.flow.removeAttribute("d");
                p.arrow.setAttribute("points", "");
                return;
            }

            var start = attach(a, b);
            var end = attach(b, a);
            var d = cubic(start, end);
            p.track.setAttribute("d", d);
            p.flow.setAttribute("d", d);

            // ---- resa dinamica in base alla potenza ----
            var w = arc.idle ? 3 : widthFor(arc.ratio);

            p.group.setAttribute("data-idle", arc.idle ? "true" : "false");
            p.group.style.setProperty("--arc-width", w.toFixed(1) + "px");
            p.group.style.setProperty("--arc-dur", durationFor(arc.ratio));

            // Verso: positivo = verso canonico (from -> to).
            p.flow.setAttribute("data-dir", arc.reversed ? "reverse" : "forward");

            placeArrow(p.arrow, p.flow, arc.reversed, Math.max(4, w * .8));
        });
    }

    var redraw = null; // creato in init, throttled su rAF

    /* ------------------------------------------------------------------
       API pubblica
       ------------------------------------------------------------------ */
    EF.flow = {
        init: function () {
            container = document.querySelector(".flow");
            svg = EF.el("flowSvg");
            nodesLayer = EF.el("flowNodes");
            if (!container || !svg || !nodesLayer) { return; }

            redraw = EF.rafThrottle(draw);

            /* Un solo ricalcolo per fotogramma, qualunque sia la causa:
               resize della finestra, cambio di modalità, rotazione dello
               schermo. Senza il throttle un drag del bordo finestra
               scatenerebbe decine di getBoundingClientRect al secondo — e
               ognuno forza un reflow sincrono. */
            if (typeof ResizeObserver === "function") {
                var ro = new ResizeObserver(redraw);
                ro.observe(container);
                /* Anche gli slot: quando compare il banner "dati vecchi" la
                   banda superiore cresce e i nodi devono scendere. Il
                   contenitore però non cambia dimensione, quindi il suo
                   observer non scatterebbe e gli archi resterebbero
                   attaccati alle posizioni vecchie. */
                container.querySelectorAll(".slot").forEach(function (s) { ro.observe(s); });
            } else {
                window.addEventListener("resize", redraw);
            }

            /* Il cambio di modalità kiosk/compatta cambia la dimensione dei
               dischi via CSS: il ResizeObserver sul contenitore non scatta se
               il contenitore mantiene la stessa dimensione, quindi va
               notificato esplicitamente. */
            EF.on("layout", redraw);

            /* Il font è caricato con font-display:swap: quando Sora sostituisce
               il fallback, le etichette cambiano larghezza e i dischi possono
               spostarsi. Senza questo, gli archi restano attaccati alle
               posizioni del fallback. */
            if (document.fonts && document.fonts.ready) {
                document.fonts.ready.then(function () { if (redraw) { redraw(); } });
            }

            draw();
        },

        /* state: { solar, home, battery, grid, scaleW } in watt, segnati. */
        update: function (state) {
            lastState = state || {};
            if (redraw) { redraw(); } else { draw(); }
            /* Chi altro disegna gli stessi flussi (la vista 3D) si iscrive
               qui: riceve lo stato già normalizzato invece di andarselo a
               ripescare da /data e reinterpretarne i segni. */
            EF.emit("flow", lastState);
        },

        /* Nessun dato utilizzabile: tutti gli archi spenti. */
        clear: function () {
            lastState = { solar: null, home: null, battery: null, grid: null };
            if (redraw) { redraw(); } else { draw(); }
            EF.emit("flow", lastState);
        },

        /* Ultimo stato pubblicato: serve a una vista che si apre a metà
           partita e deve mostrare i numeri di adesso, non aspettare il
           prossimo giro di polling. */
        state: function () { return lastState; },

        /* Direzione, inattività e rapporto sul fondoscala di ogni arco.
           È l'unico posto in cui quei tre significati vengono decisi. */
        resolve: resolve,

        /* La soglia sotto cui un flusso non è un flusso. Pubblica perché
           anche la 3D deve usare LA stessa, non una sua. */
        IDLE_W: IDLE_W
    };
})();
