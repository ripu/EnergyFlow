/* ============================================================================
   EnergyFlow — vista 3D dell'impianto.

   PERCHÉ ERA STATA TOLTA, E COSA È CAMBIATO
   ------------------------------------------------------------------------
   La prima versione della vista 3D è stata rimossa per tre difetti precisi.
   Non sono dettagli di stile: erano il motivo per cui su un Raspberry acceso
   H24 quella vista costava più di quanto valesse.

   1. three.js arrivava da unpkg.com — ~600 KB scaricati a runtime da un CDN.
      Su un kiosk senza uscita verso internet la vista semplicemente NON si
      apriva, e la sola presenza di un CDN nella pagina obbligava a tenere la
      CSP larga: un compromesso di unpkg avrebbe iniettato codice arbitrario
      nel pannello di casa.
      → Ora three.js è VENDORIZZATO in static/vendor/three.min.js e servito
        dallo stesso origin. La CSP resta `default-src 'self'; script-src
        'self'` e non va allargata di un carattere.

   2. Il ciclo di render non si fermava mai. stop3DAnimation() esisteva ma il
      toggle non la chiamava: tornando in 2D il requestAnimationFrame
      continuava a girare, con la GPU accesa su una scena che nessuno stava
      guardando. Su un pannello sempre acceso è consumo perpetuo.
      → Qui il ciclo si ferma alla chiusura, quando la pagina non è visibile
        e quando la finestra perde il focus. Il contatore dei fotogrammi è
        pubblico (EF.view3d.stats()) e visibile con ?debug3d=1, così che
        "si è fermato" sia una misura e non un'impressione.

   3. La logica dei flussi era duplicata e divergente: update3D deduceva il
      verso della batteria da un'euristica giorno/notte invece di leggere
      battery_power_w. Due viste degli stessi dati che raccontavano cose
      diverse.
      → Qui non si calcola NIENTE. Direzione, inattività e intensità arrivano
        da EF.flow.resolve() (static/flow.js), la stessa funzione che disegna
        gli archi 2D; i numeri delle etichette sono letteralmente le stringhe
        già scritte sui nodi 2D. Per costruzione le due viste non possono
        contraddirsi.

   THREE.JS — QUALE BUILD E PERCHÉ
   ------------------------------------------------------------------------
   static/vendor/three.min.js — three.js r159, build UMD minificata.
     origine  https://unpkg.com/three@0.159.0/build/three.min.js (solo come
              sorgente di DOWNLOAD: a runtime non si contatta nessun CDN)
     sha256   7b1c5d75b28d9de15042e2b374f83566d8c7146697af8fdeb4558b0fb528a585
     bytes    668024
   r159 è l'ultima revisione con build UMD (dalla r160 three è solo ESM). Si
   sceglie UMD e non ESM perché un <script> classico funziona anche aprendo
   index.html da file://, dove i moduli ES sono bloccati dalla CORS — lo stesso
   motivo per cui tutto il resto del frontend non usa import. Il file emette in
   console un avviso di deprecazione all'atto del caricamento: è upstream, il
   file è tenuto identico all'originale perché l'hash sia verificabile.

   CARICAMENTO PIGRO
   ------------------------------------------------------------------------
   three.js NON è nell'index. Lo <script> viene iniettato alla prima apertura
   della vista 3D. Il pannello a muro non apre mai questa vista, e non deve
   pagarne né i 668 KB né il contesto WebGL.
   ========================================================================= */
(function () {
    "use strict";

    var EF = window.EF;

    var VENDOR_SRC = "static/vendor/three.min.js";

    /* Geometria della scena. Stella con l'inverter al centro: la stessa
       topologia del diagramma 2D, che è poi quella fisica dell'impianto.
       `label` e `anchor` servono alle etichette HTML sovrapposte: il testo
       resta testo del documento (selezionabile, leggibile dagli AT, coerente
       coi token tipografici) invece di diventare pixel dentro una texture. */
    var NODES = {
        inverter: { pos: [0, 0.85, 0], anchor: 1.15, label: "Inverter", mirror: "nodeInverter", role: "inverter" },
        /* L'ancora del fotovoltaico è alta 2.15 e non 1.35 perché sopra il
           pannello c'è il sole: a 1.35 l'etichetta gli finiva davanti e ne
           tagliava a metà il disco. */
        pv: { pos: [-3.15, 1.15, 0.95], anchor: 2.15, label: "Fotovoltaico", mirror: "nodePv", role: "solar" },
        battery: { pos: [0.25, 0.55, 2.95], anchor: 1.05, label: "Batteria", mirror: "nodeBattery", role: "battery" },
        home: { pos: [3.15, 0.80, -0.35], anchor: 1.55, label: "Casa", mirror: "nodeHome", role: "home" },
        grid: { pos: [-0.65, 1.55, -3.05], anchor: 1.65, label: "Rete", mirror: "nodeGrid", role: "grid" }
    };

    /* Colore di ruolo per ogni arco: le stesse variabili dei token che usano
       il diagramma 2D, la legenda e i grafici. Lette da getComputedStyle, non
       ricopiate: un ritocco a tokens.css deve arrivare anche qui. */
    var ROLE_VAR = {
        solar: "--role-solar",
        battery: "--role-battery",
        grid: "--role-grid",
        home: "--role-home",
        inverter: "--role-inverter"
    };

    var MAX_DOTS = 6;          // particelle per arco: il tetto del pool
    var TARGET_FPS = 30;       // su un Pi 60 fps non aggiungono informazione
    var FRAME_MS = 1000 / TARGET_FPS;

    /* ------------------------------------------------------------------
       Stato del modulo
       ------------------------------------------------------------------ */
    var THREE = null;          // popolato dal caricamento pigro
    var loading = null;        // Promise in volo, per non iniettare due volte
    var open = false;
    var failed = false;        // WebGL assente o vendor non caricabile

    var root = document.documentElement;
    var host = null, stage = null, labelsBox = null, fallbackBox = null, statBox = null;

    var renderer = null, scene = null, camera = null;
    var themed = [];           // {obj, kind, varName} — ridipinti al cambio tema
    var arcs = {};             // id -> {curve, tube, dots[], arrow, mat}
    var labels = {};           // nodeName -> {box, value}
    var batteryFill = null;
    var groundFog = null;

    /* Camera in coordinate sferiche attorno al centro della scena.
       `zoom` è il fattore scelto dall'utente con la rotella; la distanza vera
       la calcola fitRadius() dal rapporto d'aspetto (vedi lì il perché). */
    var cam = { radius: 10.5, zoom: 1, theta: 0.85, phi: 1.02, target: null };
    var drag = null;

    /* Raggio della sfera che contiene tutta la scena, misurato sulle
       posizioni dei nodi più l'ingombro dei corpi. */
    var SCENE_R = 4.9;

    /* Ciclo di render — le variabili che il difetto #2 esiste per governare. */
    var running = false;
    var rafId = 0;
    var frames = 0;            // fotogrammi DISEGNATI, non rAF schedulati
    var lastFrameMs = 0;
    var lastTickMs = 0;
    var fps = 0;
    var fpsAcc = 0;            // inizio della finestra di misura, in ms
    var fpsFrames = 0;
    var mirrorTimer = 0;
    var statTimer = 0;

    var reduceMQ = window.matchMedia("(prefers-reduced-motion: reduce)");

    function reduced() { return !!reduceMQ.matches; }

    function kiosk() { return root.getAttribute("data-mode") === "kiosk"; }

    function debugOn() {
        try {
            return new URLSearchParams(window.location.search).get("debug3d") === "1";
        } catch (e) { return false; }
    }

    /* ------------------------------------------------------------------
       Colori dai token.

       Via principale: il valore CALCOLATO della custom property su :root. Il
       browser ha già risolto le catene di riferimenti — `--role-solar:
       var(--amber-light)` arriva qui come "#eb6834", cioè esattamente ciò che
       THREE.Color.setStyle sa leggere.

       Via di scorta: una sonda usa-e-getta, per il caso in cui il valore
       calcolato arrivasse ancora come `var(...)`.

       La prima stesura RIUSAVA una sola sonda, riscrivendone `color` ad ogni
       lettura. Sembrava più economico ed era sbagliato: Chrome restituiva lo
       stile calcolato precedente, così tutti i materiali finivano col colore
       della PRIMA variabile letta. In condizioni normali passava inosservato,
       con prefers-reduced-motion la scena veniva fuori tutta arancione — che è
       il modo peggiore di sbagliare, perché il difetto compare solo nel ramo
       accessibile, quello che nessuno guarda. Una sonda nuova ogni volta non
       ha stato da invalidare, e a quindici letture per cambio di tema il costo
       non si misura.
       ------------------------------------------------------------------ */
    function cssColor(varName, fallback) {
        var direct = (getComputedStyle(root).getPropertyValue(varName) || "").trim();
        if (direct && direct.indexOf("var(") === -1) { return direct; }

        var probe = document.createElement("span");
        probe.setAttribute("aria-hidden", "true");
        probe.style.cssText = "position:absolute;width:0;height:0;opacity:0;" +
            "pointer-events:none;color:var(" + varName + ")";
        document.body.appendChild(probe);
        var value = getComputedStyle(probe).color;
        probe.remove();

        if (!value || value === "rgba(0, 0, 0, 0)") { return fallback || "#888888"; }
        return value;
    }

    function color(varName, fallback) {
        var c = new THREE.Color();
        c.setStyle(cssColor(varName, fallback));
        return c;
    }

    /* Registra un materiale come "vestito da un token": al cambio di tema
       basta riscorrere questa lista invece di ricostruire la scena. */
    function themedMaterial(mat, varName, field) {
        themed.push({ mat: mat, varName: varName, field: field || "color" });
        return mat;
    }

    function applyPalette() {
        if (!scene) { return; }
        themed.forEach(function (t) {
            t.mat[t.field].copy(color(t.varName));
        });
        var bg = color("--chart-surface", "#ffffff");
        scene.background = bg;
        if (groundFog) { groundFog.color.copy(bg); }
        /* Con tema scuro la luce ambientale va alzata: le stesse intensità che
           su fondo chiaro danno volume, sul nero appiattiscono tutto in una
           silhouette. */
        var dark = root.getAttribute("data-theme") === "dark";
        if (scene.userData.hemi) { scene.userData.hemi.intensity = dark ? 1.15 : 1.75; }
        if (scene.userData.dir) { scene.userData.dir.intensity = dark ? 2.6 : 2.1; }
        if (scene.userData.amb) { scene.userData.amb.intensity = dark ? 1.1 : 0.7; }
    }

    /* ------------------------------------------------------------------
       Caricamento pigro di three.js.
       Uno <script> same-origin: la CSP `script-src 'self'` lo accetta senza
       nonce, senza hash e senza 'unsafe-inline'.
       ------------------------------------------------------------------ */
    function ensureThree() {
        if (window.THREE) { THREE = window.THREE; return Promise.resolve(THREE); }
        if (loading) { return loading; }

        loading = new Promise(function (resolve, reject) {
            var el = document.createElement("script");
            el.src = VENDOR_SRC;
            el.async = true;
            el.addEventListener("load", function () {
                if (!window.THREE) {
                    reject(new Error("three.js caricata ma il global THREE manca"));
                    return;
                }
                THREE = window.THREE;
                console.log("[3d] three.js r" + THREE.REVISION + " caricata da " + VENDOR_SRC);
                resolve(THREE);
            });
            el.addEventListener("error", function () {
                reject(new Error("three.js non caricabile da " + VENDOR_SRC));
            });
            document.head.appendChild(el);
        });
        return loading;
    }

    function webglAvailable() {
        try {
            var c = document.createElement("canvas");
            return !!(window.WebGLRenderingContext &&
                (c.getContext("webgl2") || c.getContext("webgl")));
        } catch (e) {
            return false;
        }
    }

    /* ------------------------------------------------------------------
       Costruzione della scena (una sola volta)
       ------------------------------------------------------------------ */
    function vec(a) { return new THREE.Vector3(a[0], a[1], a[2]); }

    function lambert(varName) {
        var m = new THREE.MeshLambertMaterial({ color: 0xffffff });
        return themedMaterial(m, varName);
    }

    function addGround() {
        var mat = themedMaterial(
            new THREE.MeshLambertMaterial({ transparent: true, opacity: 0.55 }),
            "--surface-sunken");
        var disc = new THREE.Mesh(new THREE.CircleGeometry(5.9, 48), mat);
        disc.rotation.x = -Math.PI / 2;
        disc.position.y = -0.01;
        scene.add(disc);

        /* Griglia di riferimento: senza un piano leggibile la profondità si
           perde e gli oggetti sembrano galleggiare a caso. */
        var grid = new THREE.GridHelper(11.8, 22);
        /* GridHelper cuoce i propri grigi nei colori per vertice: lasciandoli
           accesi, il colore del token verrebbe moltiplicato per quei grigi e
           il tema non si vedrebbe più. */
        grid.material.vertexColors = false;
        grid.material.transparent = true;
        grid.material.opacity = 0.3;
        grid.material.needsUpdate = true;
        themedMaterial(grid.material, "--border-strong");
        scene.add(grid);
    }

    function addPv() {
        var g = new THREE.Group();
        g.position.copy(vec(NODES.pv.pos));

        // Il pannello: piano inclinato verso il sole.
        var panel = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.08, 1.25),
            lambert("--role-inverter"));
        panel.rotation.z = -0.34;
        panel.position.y = 0.28;
        g.add(panel);

        // Celle: un secondo piano appena sopra, in colore solare.
        var cells = new THREE.Mesh(new THREE.BoxGeometry(1.74, 0.03, 1.1),
            lambert("--role-solar"));
        cells.rotation.z = -0.34;
        cells.position.set(0.02, 0.34, 0);
        g.add(cells);

        var leg = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.6, 8),
            lambert("--role-inverter"));
        leg.position.set(0.55, -0.02, 0);
        g.add(leg);
        var leg2 = leg.clone();
        leg2.position.set(-0.5, -0.14, 0);
        leg2.scale.y = 1.5;
        g.add(leg2);

        // Il sole: emissivo, sopra il pannello. Non è illuminazione, è un
        // simbolo — la luce vera la fanno hemi + directional.
        var sun = new THREE.Mesh(new THREE.SphereGeometry(0.30, 20, 14),
            themedMaterial(new THREE.MeshBasicMaterial(), "--role-solar"));
        sun.position.set(-0.35, 1.55, -0.2);
        g.add(sun);

        scene.add(g);
    }

    function addInverter() {
        var g = new THREE.Group();
        g.position.copy(vec(NODES.inverter.pos));

        var body = new THREE.Mesh(new THREE.BoxGeometry(0.95, 1.3, 0.55),
            lambert("--surface-raised"));
        g.add(body);

        var face = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.30, 0.04),
            themedMaterial(new THREE.MeshBasicMaterial(), "--role-inverter"));
        face.position.set(0, 0.30, 0.30);
        g.add(face);

        var edge = new THREE.Mesh(new THREE.BoxGeometry(0.99, 0.06, 0.59),
            lambert("--role-inverter"));
        edge.position.y = -0.66;
        g.add(edge);

        scene.add(g);
    }

    function addBattery() {
        var g = new THREE.Group();
        g.position.copy(vec(NODES.battery.pos));

        var shell = new THREE.Mesh(new THREE.BoxGeometry(1.25, 1.05, 0.8),
            themedMaterial(new THREE.MeshLambertMaterial({
                transparent: true, opacity: 0.34
            }), "--surface-raised"));
        g.add(shell);

        /* Il livello di carica è un solido che cresce dal basso: si scala in
           y e si riposiziona di conseguenza, così la base resta appoggiata al
           fondo dell'involucro invece di espandersi dal centro. */
        batteryFill = new THREE.Mesh(new THREE.BoxGeometry(1.05, 1.0, 0.62),
            lambert("--role-battery"));
        batteryFill.position.y = -0.5;
        batteryFill.scale.y = 0.001;
        g.add(batteryFill);

        var cap = new THREE.Mesh(new THREE.BoxGeometry(1.29, 0.07, 0.84),
            lambert("--role-inverter"));
        cap.position.y = 0.56;
        g.add(cap);

        scene.add(g);
        g.userData.fillBase = -0.5;
    }

    function addHome() {
        var g = new THREE.Group();
        g.position.copy(vec(NODES.home.pos));

        var walls = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.0, 1.25),
            lambert("--surface-raised"));
        g.add(walls);

        /* Cono a 4 lati = tetto a padiglione, senza geometria dedicata.
           Più alto e più stretto della prima stesura: a 1.28 di raggio per
           0.75 di alzata, visto dall'alto, era una piastra piatta invece che
           un tetto — e nel tema chiaro quella piastra è --role-home, cioè
           quasi nera, e prendeva metà della scena. */
        var roof = new THREE.Mesh(new THREE.ConeGeometry(1.12, 0.9, 4),
            lambert("--role-home"));
        roof.rotation.y = Math.PI / 4;
        roof.position.y = 0.93;
        g.add(roof);

        // Finestra accesa: dà il verso della casa e un punto caldo che
        // distingue la facciata dai fianchi.
        var door = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.5, 0.04),
            themedMaterial(new THREE.MeshBasicMaterial(), "--role-solar"));
        door.position.set(0, -0.22, 0.64);
        g.add(door);

        scene.add(g);
    }

    function addGrid() {
        var g = new THREE.Group();
        g.position.copy(vec(NODES.grid.pos));

        var mast = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.13, 2.2, 8),
            lambert("--role-grid"));
        g.add(mast);

        [0.55, 0.95].forEach(function (y, i) {
            var arm = new THREE.Mesh(new THREE.BoxGeometry(1.5 - i * 0.45, 0.08, 0.08),
                lambert("--role-grid"));
            arm.position.y = y;
            g.add(arm);
        });

        scene.add(g);
    }

    /* Curva di un arco: gli estremi arretrati verso l'esterno dei corpi e un
       punto di controllo sollevato, così il tubo non attraversa i solidi. */
    function arcCurve(fromName, toName) {
        var a = vec(NODES[fromName].pos);
        var b = vec(NODES[toName].pos);
        var dir = b.clone().sub(a).normalize();
        var start = a.clone().addScaledVector(dir, 0.78);
        var end = b.clone().addScaledVector(dir, -0.78);
        var mid = start.clone().add(end).multiplyScalar(0.5);
        mid.y += 0.55 + start.distanceTo(end) * 0.10;
        return new THREE.QuadraticBezierCurve3(start, mid, end);
    }

    function buildArcs() {
        /* La topologia arriva da flow.js: un arco in più nel diagramma 2D
           compare qui senza toccare questo file. */
        EF.flow.resolve(EF.flow.state()).forEach(function (a) {
            var curve = arcCurve(a.from, a.to);
            var varName = ROLE_VAR[a.role] || "--role-inverter";

            var tubeMat = themedMaterial(new THREE.MeshBasicMaterial({
                transparent: true, opacity: 0.28
            }), varName);
            var tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 36, 0.035, 8, false), tubeMat);
            scene.add(tube);

            // Pool di particelle: allocate una volta, accese/spente dopo.
            var dotMat = themedMaterial(new THREE.MeshBasicMaterial(), varName);
            var dotGeo = new THREE.SphereGeometry(0.085, 10, 8);
            var dots = [];
            for (var i = 0; i < MAX_DOTS; i++) {
                var d = new THREE.Mesh(dotGeo, dotMat);
                d.visible = false;
                scene.add(d);
                dots.push(d);
            }

            /* Freccia statica: è l'equivalente 3D di quella che il diagramma
               2D mostra con prefers-reduced-motion. Si costruisce sempre, così
               la strada accessibile non è un ramo di codice che nessuno prova. */
            var arrow = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.34, 12), dotMat);
            arrow.visible = false;
            scene.add(arrow);

            arcs[a.id] = { curve: curve, tube: tube, dots: dots, arrow: arrow, phase: Math.random() };
        });
    }

    function buildLabels() {
        /* Le etichette sono DOM, non texture: si generano da NODES perché la
           tabella dei nodi resti una sola. Duplicarle nell'HTML significa
           poterle dimenticare quando la scena cambia. */
        labelsBox.textContent = "";
        Object.keys(NODES).forEach(function (name) {
            var n = NODES[name];
            var box = document.createElement("p");
            box.className = "label3d";
            box.setAttribute("data-role", n.role);

            var title = document.createElement("span");
            title.className = "label3d__name";
            title.textContent = n.label;

            var value = document.createElement("b");
            value.className = "label3d__value tnum";
            value.textContent = "--";

            box.appendChild(title);
            box.appendChild(value);
            labelsBox.appendChild(box);
            labels[name] = { box: box, value: value, anchor: new THREE.Vector3(n.pos[0], n.pos[1] + n.anchor, n.pos[2]) };
        });
    }

    function buildScene() {
        scene = new THREE.Scene();
        groundFog = new THREE.Fog(0xffffff, 13, 27);
        scene.fog = groundFog;

        camera = new THREE.PerspectiveCamera(42, 1, 0.1, 120);
        cam.target = new THREE.Vector3(0, 0.9, 0);

        var hemi = new THREE.HemisphereLight(0xffffff, 0x404a58, 1.6);
        var dir = new THREE.DirectionalLight(0xffffff, 2.2);
        dir.position.set(5.5, 9, 4.5);
        var amb = new THREE.AmbientLight(0xffffff, 0.8);
        scene.add(hemi, dir, amb);
        scene.userData.hemi = hemi;
        scene.userData.dir = dir;
        scene.userData.amb = amb;

        addGround();
        addPv();
        addInverter();
        addBattery();
        addHome();
        addGrid();
        buildArcs();
        buildLabels();
        applyPalette();
    }

    /* ------------------------------------------------------------------
       DATI — nessun calcolo, solo traduzione in geometria.
       ------------------------------------------------------------------ */
    function onFlow(state) {
        /* A vista chiusa ci si ferma subito: nessuna particella da
           riposizionare, nessuna etichetta da riscrivere, nessun fotogramma.
           Il polling gira ogni 5 secondi per sempre, e una vista che nessuno
           sta guardando non deve costare niente. Alla riapertura doOpen()
           richiama onFlow con lo stato corrente, quindi la scena non si
           sveglia mai vecchia — e non serve tenersene una copia qui. */
        if (!scene || !open) { return; }

        EF.flow.resolve(state).forEach(function (a) {
            var g = arcs[a.id];
            if (!g) { return; }

            /* Idle: l'arco resta visibile ma smette di raccontare movimento.
               La soglia è quella di flow.js, non una locale. */
            g.tube.material.opacity = a.idle ? 0.14 : 0.30 + 0.22 * a.ratio;
            g.count = a.idle ? 0 : Math.round(2 + 4 * a.ratio);
            g.speed = a.idle ? 0 : 0.10 + 0.42 * a.ratio;
            g.size = 0.65 + 0.85 * a.ratio;
            g.reversed = a.reversed;

            var showArrow = reduced() && !a.idle;
            g.arrow.visible = showArrow;
            if (showArrow) { placeArrow(g); }

            for (var i = 0; i < MAX_DOTS; i++) {
                g.dots[i].visible = !reduced() && i < g.count;
            }
        });

        placeDots(0); // una posa iniziale anche se il ciclo non parte
        mirrorValues();
    }

    /* La freccia della modalità accessibile: a metà arco, orientata sulla
       tangente e ribaltata quando il flusso è invertito. */
    function placeArrow(g) {
        var p = g.curve.getPointAt(0.5);
        var t = g.curve.getTangentAt(0.5);
        if (g.reversed) { t.negate(); }
        g.arrow.position.copy(p);
        g.arrow.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), t.normalize());
    }

    function placeDots(dt) {
        Object.keys(arcs).forEach(function (id) {
            var g = arcs[id];
            if (!g.count) { return; }
            g.phase = (g.phase + (g.speed || 0) * dt) % 1;
            for (var i = 0; i < g.count; i++) {
                var t = (g.phase + i / g.count) % 1;
                /* Il verso NON è una scelta di questa funzione: `reversed`
                   arriva da flow.js, che lo legge dal segno del campo. */
                var u = g.reversed ? 1 - t : t;
                var p = g.curve.getPointAt(u);
                g.dots[i].position.copy(p);
                g.dots[i].scale.setScalar(g.size || 1);
            }
        });
    }

    /* ------------------------------------------------------------------
       Valori delle etichette — copiati, mai ricalcolati.

       Sono le stesse stringhe che il diagramma 2D sta mostrando in questo
       istante: se cambia il formato di là, cambia di qua, e le due viste non
       possono mostrare numeri diversi nemmeno per un errore di arrotondamento.
       Stessa cosa per la freschezza del dato: una vista che coprisse lo stato
       "dati vecchi" mostrerebbe numeri congelati come se fossero di adesso.
       ------------------------------------------------------------------ */
    function mirrorValues() {
        Object.keys(NODES).forEach(function (name) {
            var src = EF.el(NODES[name].mirror);
            var dst = labels[name];
            if (!src || !dst) { return; }
            var txt = src.textContent || "--";
            if (dst.value.textContent !== txt) { dst.value.textContent = txt; }
        });

        var soc = EF.el("socMeter");
        var pct = soc ? EF.num(soc.getAttribute("aria-valuenow")) : null;
        if (batteryFill) {
            var f = pct === null ? 0 : EF.clamp(pct, 0, 100) / 100;
            batteryFill.scale.y = Math.max(0.001, f);
            // base fissa: il solido cresce verso l'alto, non dal centro
            batteryFill.position.y = -0.5 + (1.0 * Math.max(0.001, f)) / 2;
        }
        var socLabel = labels.battery;
        if (socLabel && pct !== null) {
            socLabel.box.setAttribute("data-soc", Math.round(pct) + "%");
        }

        var fresh = EF.el("freshness");
        var freshTxt = EF.el("freshnessText");
        var out = EF.el("view3dFresh");
        var outTxt = EF.el("view3dFreshText");
        if (out && outTxt && fresh && freshTxt) {
            out.setAttribute("data-state", fresh.getAttribute("data-state") || "init");
            var t = freshTxt.textContent || "";
            if (outTxt.textContent !== t) { outTxt.textContent = t; }
        }
    }

    /* ------------------------------------------------------------------
       CICLO DI RENDER — il difetto #2 vive o muore qui.
       ------------------------------------------------------------------ */
    function renderFrame() {
        // Le etichette seguono la proiezione: vanno riposizionate col frame.
        placeLabels();
        renderer.render(scene, camera);
        frames++;
    }

    function loop(now) {
        if (!running) { return; }
        rafId = requestAnimationFrame(loop);

        var dt = (now - lastTickMs) / 1000;
        lastTickMs = now;
        if (dt > 0.25) { dt = 0.25; }  // ritorno da un tab in background

        /* Tetto ai fotogrammi: oltre i 30/s la scena non dice niente di nuovo
           e su un Pi la differenza si sente tutta. */
        if (now - lastFrameMs < FRAME_MS) { return; }
        lastFrameMs = now;

        if (!reduced()) {
            placeDots(dt);
            if (!drag) { cam.theta += dt * 0.085; }
        }
        updateCamera();
        renderFrame();

        /* Finestra su orologio da parete, non somma dei dt.
           Accumulando i dt dei soli fotogrammi disegnati si sommava ~0,5 s
           per ogni secondo reale (il rAF gira a 60 Hz, il render a 30): la
           finestra durava due secondi e il numero mostrato era la metà di
           quello vero. Un contatore che mente sul suo stesso ordine di
           grandezza è peggio di nessun contatore. */
        fpsFrames++;
        if (now - fpsAcc >= 1000) {
            fps = Math.round(fpsFrames * 1000 / (now - fpsAcc));
            fpsAcc = now; fpsFrames = 0;
        }
    }

    function start(why) {
        if (!open || running || failed || !renderer) { return; }
        /* Con prefers-reduced-motion non esiste ciclo continuo: si disegna
           quando cambia qualcosa e basta. È la richiesta dell'utente presa
           alla lettera, ed è anche il comportamento più economico. */
        if (reduced()) { renderOnce(); return; }
        running = true;
        lastTickMs = performance.now();
        lastFrameMs = 0;
        fpsAcc = lastTickMs;
        fpsFrames = 0;
        rafId = requestAnimationFrame(loop);
        console.log("[3d] render avviato (" + why + ")");
    }

    function stop(why) {
        if (!running && !rafId) { return; }
        running = false;
        if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
        fps = 0;
        console.log("[3d] render fermato (" + why + ") — fotogrammi totali " + frames);
    }

    function renderOnce() {
        if (!renderer || !scene || failed) { return; }
        updateCamera();
        renderFrame();
    }

    /* ------------------------------------------------------------------
       Distanza della camera dal rapporto d'aspetto.

       Il `fov` di three è VERTICALE: su un riquadro alto e stretto — il
       1080x1920 in modalità compatta — l'apertura orizzontale si stringe di
       un fattore `aspect`, e con una distanza fissa la scena usciva dai bordi
       a destra e a sinistra portandosi via tre etichette su cinque. Si prende
       quindi la distanza che soddisfa il PIÙ STRETTO dei due vincoli.
       ------------------------------------------------------------------ */
    function fitRadius() {
        var vFov = camera.fov * Math.PI / 180;
        var hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
        var need = Math.max(SCENE_R / Math.sin(vFov / 2), SCENE_R / Math.sin(hFov / 2));
        // margine: le etichette stanno FUORI dalla proiezione dei corpi e
        // verrebbero tagliate proprio quando la scena riempie il riquadro.
        return need * 1.06;
    }

    function updateCamera() {
        var sinPhi = Math.sin(cam.phi);
        camera.position.set(
            cam.target.x + cam.radius * sinPhi * Math.sin(cam.theta),
            cam.target.y + cam.radius * Math.cos(cam.phi),
            cam.target.z + cam.radius * sinPhi * Math.cos(cam.theta)
        );
        camera.lookAt(cam.target);

        /* Le matrici vanno aggiornate QUI e non lasciate al render.
           `Vector3.project` usa matrixWorldInverse, che renderer.render()
           ricalcola dopo: senza questa riga le etichette venivano proiettate
           con la camera del fotogramma PRECEDENTE e, mentre la scena ruota,
           strisciavano di un frame dietro ai corpi. Serve anche a fitCamera(),
           che proietta prima di aver mai disegnato. */
        camera.updateMatrixWorld(true);
        camera.matrixWorldInverse.copy(camera.matrixWorld).invert();

        /* Nebbia agganciata alla distanza: a fondo fisso (13-27) bastava una
           camera più lontana — il caso del riquadro verticale — perché tutta
           la scena finisse dentro la fascia di nebbia e sbiadisse nel colore
           di sfondo. Legata al raggio, la nebbia stacca il fondo dai corpi
           invece di mangiarseli. */
        if (groundFog) {
            groundFog.near = Math.max(1, cam.radius - SCENE_R * 0.4);
            groundFog.far = cam.radius + SCENE_R * 2.2;
        }
    }

    /* ------------------------------------------------------------------
       Inquadratura MISURATA.

       fitRadius() dà una prima distanza dalla geometria, ma tratta la scena
       come una sfera: la scena vera è larga e bassa, e vista di tre quarti
       occupa molto meno di quanto la sfera prometta — sul 1080x1920 restava
       un francobollo in mezzo al vuoto. Qui si PROIETTANO i punti notevoli e
       si corregge la distanza finché l'ingombro sullo schermo non è quello
       voluto. Stesso principio di flow.js: si misura invece di stimare.
       ------------------------------------------------------------------ */
    function projectedFill() {
        var minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
        var v = new THREE.Vector3();
        /* Non basta il centro del nodo: i corpi sono larghi ~1,4 unità e la
           casa, misurata sul solo centro, finiva mezza fuori dal bordo destro.
           Si campiona una crocetta attorno a ogni nodo più il punto
           dell'etichetta. */
        var OFF = [[0, 0, 0], [0.85, 0, 0], [-0.85, 0, 0], [0, 0, 0.85], [0, 0, -0.85],
        /* anche verso il basso: i corpi poggiano a terra e senza questo
           campione la casa e la batteria restavano tagliate dal bordo
           inferiore, dove il fit credeva di avere ancora margine. */
        [0, -0.95, 0]];
        Object.keys(NODES).forEach(function (name) {
            var n = NODES[name];
            OFF.map(function (o) {
                return [n.pos[0] + o[0], n.pos[1] + o[1], n.pos[2] + o[2]];
            }).concat([[n.pos[0], n.pos[1] + n.anchor, n.pos[2]]]).forEach(function (p) {
                v.set(p[0], p[1], p[2]).project(camera);
                if (v.x < minX) { minX = v.x; }
                if (v.x > maxX) { maxX = v.x; }
                if (v.y < minY) { minY = v.y; }
                if (v.y > maxY) { maxY = v.y; }
            });
        });
        // NDC va da -1 a 1: l'intero viewport vale 2.
        return Math.max((maxX - minX) / 2, (maxY - minY) / 2);
    }

    /* La scena ruota da sola: l'ingombro sullo schermo cambia con l'angolo, e
       una distanza tarata su UNA sola posizione lascia uscire la casa dal
       bordo mezzo giro dopo. Si prende quindi il caso peggiore su un giro
       intero, così l'inquadratura tiene sempre. Otto campioni bastano: fra
       due angoli vicini l'ingombro varia poco e il margine assorbe il resto. */
    function worstFill() {
        var saved = cam.theta;
        var worst = 0;
        for (var i = 0; i < 8; i++) {
            cam.theta = saved + i * Math.PI / 4;
            updateCamera();
            var f = projectedFill();
            if (isFinite(f) && f > worst) { worst = f; }
        }
        cam.theta = saved;
        updateCamera();
        return worst;
    }

    function fitCamera() {
        var TARGET_FILL = 0.84;   // quota del riquadro occupata dalla scena
        var savedZoom = cam.zoom;
        cam.zoom = 1;
        cam.radius = fitRadius();
        updateCamera();
        for (var i = 0; i < 4; i++) {
            var fill = worstFill();
            if (!isFinite(fill) || fill <= 0.01) { break; }
            cam.radius = EF.clamp(cam.radius * (fill / TARGET_FILL), 3, 60);
            updateCamera();
            if (Math.abs(fill - TARGET_FILL) < 0.01) { break; }
        }
        cam.base = cam.radius;
        cam.zoom = savedZoom;
        cam.radius = cam.base * cam.zoom;
        updateCamera();
    }

    function placeLabels() {
        var w = stage.clientWidth, h = stage.clientHeight;
        Object.keys(labels).forEach(function (name) {
            var l = labels[name];
            var p = l.anchor.clone().project(camera);
            /* Dietro la camera project() ribalta i segni: senza questo test
               le etichette dei nodi alle spalle comparirebbero specchiate in
               mezzo alla scena. */
            var behind = p.z > 1;
            l.box.style.opacity = behind ? "0" : "1";
            l.box.style.transform = "translate(-50%,-50%) translate(" +
                Math.round((p.x * 0.5 + 0.5) * w) + "px," +
                Math.round((-p.y * 0.5 + 0.5) * h) + "px)";
        });
    }

    /* ------------------------------------------------------------------
       Interazione: orbita col puntatore, zoom con la rotella.
       Scritta a mano invece di importare OrbitControls: l'addon vive in
       examples/jsm, che nella build UMD non c'è, e servirebbe un secondo file
       vendorizzato per una cinquantina di righe.
       ------------------------------------------------------------------ */
    function bindPointer() {
        stage.addEventListener("pointerdown", function (ev) {
            drag = { x: ev.clientX, y: ev.clientY };
            stage.setPointerCapture(ev.pointerId);
        });
        stage.addEventListener("pointermove", function (ev) {
            if (!drag) { return; }
            cam.theta -= (ev.clientX - drag.x) * 0.006;
            cam.phi = EF.clamp(cam.phi - (ev.clientY - drag.y) * 0.005, 0.22, 1.42);
            drag.x = ev.clientX; drag.y = ev.clientY;
            if (!running) { renderOnce(); }  // con reduced-motion il ciclo è fermo
        });
        function release(ev) {
            if (!drag) { return; }
            drag = null;
            try { stage.releasePointerCapture(ev.pointerId); } catch (e) { /* già rilasciato */ }
        }
        stage.addEventListener("pointerup", release);
        stage.addEventListener("pointercancel", release);

        stage.addEventListener("wheel", function (ev) {
            ev.preventDefault();
            /* Si sposta il FATTORE, non la distanza: così un ridimensionamento
               della finestra riadatta l'inquadratura senza buttare via lo zoom
               scelto dall'utente. */
            cam.zoom = EF.clamp(cam.zoom + ev.deltaY * 0.0015, 0.55, 2.2);
            cam.radius = (cam.base || fitRadius()) * cam.zoom;
            updateCamera();
            if (!running) { renderOnce(); }
        }, { passive: false });
    }

    function resize() {
        if (!renderer || !stage) { return; }
        var w = stage.clientWidth || 1;
        var h = stage.clientHeight || 1;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        fitCamera();
        /* Il ResizeObserver scatta anche quando il riquadro passa a
           display:none (dimensione 0): a vista chiusa non si disegna. */
        if (open && !running) { renderOnce(); }
    }

    /* ------------------------------------------------------------------
       Apertura / chiusura
       ------------------------------------------------------------------ */
    function showFallback(message) {
        failed = true;
        if (fallbackBox) {
            fallbackBox.hidden = false;
            EF.text("view3dFallbackText", message);
        }
        /* Sull'host, non solo sullo stage: il CSS toglie anche il suggerimento
           "trascina per ruotare", che davanti a un messaggio di errore
           spiegherebbe come usare una cosa che non c'è. */
        if (host) { host.setAttribute("data-failed", "true"); }
        console.warn("[3d] " + message);
    }

    function doOpen() {
        if (open) { return; }
        /* Sul kiosk la vista 3D non ha pubblico: il pannello a muro non ha né
           mouse né tastiera, nessuno può orbitare, e una scena WebGL che gira
           H24 è consumo puro su un Raspberry. Il bottone lì non c'è
           (data-kiosk-hidden) e il tasto `3` non fa niente. */
        if (kiosk()) {
            console.log("[3d] vista non disponibile in modalità kiosk (nessun input, GPU sempre accesa)");
            return;
        }

        open = true;
        host.hidden = false;
        host.setAttribute("aria-hidden", "false");
        syncButton();

        /* Lo specchio dei valori parte SUBITO, prima ancora di sapere se la
           scena si potrà disegnare: anche il riquadro di errore deve dire se i
           dati sono di adesso. Un chip di freschezza congelato su "in attesa
           dei dati" mentre la 2D sotto è in diretta è una bugia piccola ma
           gratuita. */
        mirrorValues();
        if (!mirrorTimer) { mirrorTimer = setInterval(mirrorValues, 1000); }

        /* Il pannello è aria-modal: se il focus restasse sul bottone «3D»
           dietro il riquadro, la tabulazione girerebbe in una pagina che il
           lettore di schermo considera nascosta. Si porta sull'uscita, che è
           anche la cosa più utile da avere sotto le dita. */
        var closeBtn = EF.el("view3dClose");
        if (closeBtn) { closeBtn.focus(); }

        if (!webglAvailable()) {
            showFallback("WebGL non è disponibile su questo browser: la vista 3D " +
                "non può essere disegnata. Tutti i dati restano nella vista 2D.");
            return;
        }

        ensureThree().then(function () {
            if (!open) { return; }  // chiusa mentre three stava arrivando
            if (!renderer) {
                try {
                    renderer = new THREE.WebGLRenderer({
                        antialias: (window.devicePixelRatio || 1) < 2,
                        alpha: false,
                        powerPreference: "low-power"
                    });
                } catch (e) {
                    showFallback("Il contesto WebGL non si è potuto creare: " +
                        "la vista 3D non è disponibile. I dati restano nella vista 2D.");
                    return;
                }
                /* Sul Pi il devicePixelRatio pieno quadruplica i pixel da
                   riempire senza aggiungere leggibilità a due metri. */
                renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
                stage.insertBefore(renderer.domElement, labelsBox);
                renderer.domElement.className = "view3d__canvas";
                buildScene();
                bindPointer();
                if (typeof ResizeObserver === "function") {
                    new ResizeObserver(EF.rafThrottle(resize)).observe(stage);
                }
            }
            resize();
            onFlow(EF.flow.state());
            renderOnce();          // un fotogramma c'è comunque, anche se il
            start("apertura");     // ciclo poi non parte (reduced-motion)
        }).catch(function (err) {
            showFallback("three.js non si è caricata (" + err.message + "). " +
                "La vista 3D non è disponibile; i dati restano nella vista 2D.");
        });
    }

    function doClose() {
        if (!open) { return; }
        open = false;
        stop("chiusura");
        if (mirrorTimer) { clearInterval(mirrorTimer); mirrorTimer = 0; }
        host.hidden = true;
        host.setAttribute("aria-hidden", "true");
        syncButton();
        var btn = EF.el("btn3d");
        if (btn) { btn.focus(); }
    }

    function syncButton() {
        var btn = EF.el("btn3d");
        if (btn) { btn.setAttribute("aria-pressed", open ? "true" : "false"); }
    }

    /* ------------------------------------------------------------------
       Contatore visibile — la prova che il ciclo si ferma.
       Con ?debug3d=1 il numero di fotogrammi disegnati compare nella barra:
       tornando in 2D, o mandando la scheda in background, smette di crescere.
       ------------------------------------------------------------------ */
    function startStatReadout() {
        if (!statBox) { return; }
        statBox.hidden = false;
        statTimer = setInterval(function () {
            /* Gli fps si mostrano solo quando sono stati davvero misurati: nel
               primo secondo di vita del ciclo scrivere "0 fps · in corso"
               significa contraddirsi in tre parole. */
            statBox.textContent = "frame " + frames +
                (fps ? " · " + fps + " fps" : "") +
                " · " + (running ? "in corso" : "fermo");
        }, 250);
    }

    /* ------------------------------------------------------------------
       API pubblica
       ------------------------------------------------------------------ */
    EF.view3d = {
        init: function () {
            host = EF.el("view3d");
            stage = EF.el("view3dStage");
            labelsBox = EF.el("view3dLabels");
            fallbackBox = EF.el("view3dFallback");
            statBox = EF.el("view3dStat");
            if (!host || !stage || !labelsBox) { return; }

            var btn = EF.el("btn3d");
            if (btn) { btn.addEventListener("click", function () { EF.view3d.toggle(); }); }
            var close = EF.el("view3dClose");
            if (close) { close.addEventListener("click", doClose); }
            var back = EF.el("view3dFallbackBack");
            if (back) { back.addEventListener("click", doClose); }

            /* I dati: una sola iscrizione, nessuna fetch propria. */
            EF.on("flow", onFlow);

            /* Il tema cambia con `t` e da solo ad alba/tramonto: i materiali
               vanno ridipinti, non ricostruiti.

               Il confronto col valore precedente non è un'ottimizzazione: è
               una correzione. app.js riscrive data-theme UNA VOLTA AL SECONDO
               (tickClock -> applyTheme), anche quando il tema non cambia, e
               ogni riscrittura sveglia il MutationObserver. Senza questo test
               la vista chiusa ridisegnava un fotogramma al secondo e con
               prefers-reduced-motion l'animazione "spenta" era in realtà un
               ciclo a 1 Hz: esattamente il difetto per cui la 3D era stata
               tolta, in una forma più difficile da notare. Trovato misurando
               il contatore, non guardando lo schermo. */
            var lastTheme = root.getAttribute("data-theme");
            var mo = new MutationObserver(function () {
                if (open && kiosk()) { doClose(); return; }
                var now = root.getAttribute("data-theme");
                if (now === lastTheme) { return; }
                lastTheme = now;
                if (!scene) { return; }
                applyPalette();
                if (open && !running) { renderOnce(); }
            });
            mo.observe(root, { attributes: true, attributeFilter: ["data-theme", "data-mode"] });

            /* Passaggio a kiosk mentre la 3D è aperta. */
            EF.on("layout", function () { if (open && kiosk()) { doClose(); } });

            /* --- le due condizioni di stop richieste, oltre alla chiusura --- */
            document.addEventListener("visibilitychange", function () {
                if (document.hidden) { stop("pagina non visibile"); }
                else if (open) { start("pagina di nuovo visibile"); }
            });
            window.addEventListener("blur", function () { stop("finestra senza focus"); });
            window.addEventListener("focus", function () { if (open) { start("focus"); } });

            /* Cambio di preferenza a pagina aperta: da "reduce" a "no-reduce"
               il ciclo deve ripartire, nell'altro verso deve spegnersi. */
            var onMotion = function () {
                if (!open) { return; }
                if (reduced()) { stop("prefers-reduced-motion"); renderOnce(); }
                else { start("motion consentito"); }
                onFlow(EF.flow.state());
            };
            if (reduceMQ.addEventListener) { reduceMQ.addEventListener("change", onMotion); }
            else if (reduceMQ.addListener) { reduceMQ.addListener(onMotion); }

            if (debugOn()) { startStatReadout(); }
        },

        open: doOpen,
        close: doClose,
        toggle: function () { if (open) { doClose(); } else { doOpen(); } },
        isOpen: function () { return open; },

        /* Misurabile dall'esterno: frames non deve crescere a vista chiusa.

           `arcs` non è decorazione da debug: è l'aggancio che rende
           VERIFICABILE la promessa "2D e 3D non possono contraddirsi".
           Riporta il verso effettivamente usato dalla scena e la posizione di
           una particella, così un test può campionarla due volte, ricavare da
           che parte si sta muovendo davvero e confrontarla con il data-dir
           dell'arco 2D corrispondente. Senza questo, l'unica verifica
           possibile sarebbe guardare lo schermo e fidarsi. */
        stats: function () {
            return {
                open: open,
                running: running,
                frames: frames,
                fps: fps,
                loaded: !!THREE,
                failed: failed,
                reduced: reduced(),
                /* Ingombro peggiore sul giro completo, in frazione di riquadro:
                   > 1 significa che ruotando qualcosa esce dal bordo. È il
                   controllo che tiene onesto fitCamera(). */
                fit: scene ? (function () {
                    var saved = cam.theta, worst = 0, at = 0;
                    for (var i = 0; i < 8; i++) {
                        cam.theta = saved + i * Math.PI / 4;
                        updateCamera();
                        var f = projectedFill();
                        if (isFinite(f) && f > worst) { worst = f; at = i * 45; }
                    }
                    cam.theta = saved;
                    updateCamera();
                    return { worst: worst, at: at };
                })() : null,
                /* Colore effettivo di ogni materiale, riconvertito in sRGB.
                   È la rete contro il difetto della sonda riusata: se due
                   ruoli diversi tornano allo stesso valore, la palette si è
                   di nuovo rotta e il test se ne accorge da solo invece di
                   aspettare che qualcuno noti una scena tutta arancione. */
                palette: themed.map(function (t) {
                    return { token: t.varName, hex: "#" + t.mat[t.field].getHexString() };
                }),
                arcs: Object.keys(arcs).map(function (id) {
                    var g = arcs[id];
                    var d = g.dots && g.dots[0];
                    return {
                        id: id,
                        reversed: !!g.reversed,
                        dots: g.count || 0,
                        phase: g.phase,
                        p0: d && d.visible ? [d.position.x, d.position.y, d.position.z] : null,
                        from: g.curve.getPointAt(0).toArray(),
                        to: g.curve.getPointAt(1).toArray()
                    };
                })
            };
        }
    };

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", EF.view3d.init);
    } else {
        EF.view3d.init();
    }
})();
