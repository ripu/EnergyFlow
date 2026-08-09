/* ============================================================================
   EnergyFlow — scorciatoie da tastiera (regola #5).
   Prima non ne esisteva nessuna: la dashboard si guidava solo col mouse, e
   sul Mac ogni operazione richiedeva di trovare il bottone giusto.

   Il pannello a muro non ha tastiera: queste servono alla vista compatta e
   alla manutenzione (una tastiera collegata al Pi per un controllo veloce).
   ========================================================================= */
(function () {
    "use strict";

    var EF = window.EF;
    var actions = {};
    var lastFocus = null;

    function overlay() { return EF.el("helpOverlay"); }

    function view3dOpen() {
        return !!(EF.view3d && EF.view3d.isOpen());
    }

    function helpOpen() {
        var o = overlay();
        return !!o && !o.hidden;
    }

    function showHelp(force) {
        var o = overlay();
        if (!o) { return; }
        var next = force === undefined ? o.hidden : force;
        if (next) {
            lastFocus = document.activeElement;
            o.hidden = false;
            var panel = o.querySelector(".overlay__panel");
            if (panel) {
                panel.setAttribute("tabindex", "-1");
                panel.focus();
            }
        } else {
            o.hidden = true;
            // Il focus torna da dove è partito: senza, la tabulazione
            // ricomincerebbe dall'inizio del documento.
            if (lastFocus && lastFocus.focus) { lastFocus.focus(); }
            lastFocus = null;
        }
    }

    function toggleFullscreen() {
        try {
            if (!document.fullscreenElement) {
                if (document.documentElement.requestFullscreen) {
                    document.documentElement.requestFullscreen();
                }
            } else if (document.exitFullscreen) {
                document.exitFullscreen();
            }
        } catch (e) {
            // Il fullscreen richiede un gesto dell'utente e può essere negato
            // da policy: un rifiuto non deve arrivare in console come errore.
            console.warn("[keys] schermo intero non disponibile");
        }
    }

    /* Un tasto premuto mentre si scrive in un campo deve scrivere, non
       lanciare un comando. Senza questo controllo digitare "attivo" in un
       input spegnerebbe l'auto-refresh e cambierebbe tema. */
    function typing(ev) {
        var t = ev.target;
        if (!t) { return false; }
        var tag = (t.tagName || "").toLowerCase();
        return tag === "input" || tag === "textarea" || tag === "select" || t.isContentEditable;
    }

    function onKey(ev) {
        if (ev.metaKey || ev.ctrlKey || ev.altKey) { return; }
        if (typing(ev)) { return; }

        var k = ev.key;

        if (k === "Escape") {
            /* Ordine deliberato: l'aiuto sta SOPRA la vista 3D (z-index 50
               contro 40), quindi Esc chiude prima quello che si vede davanti.
               Chiudere la 3D da sotto un pannello modale lascerebbe l'utente
               con l'aiuto aperto su una pagina cambiata alle sue spalle. */
            if (helpOpen()) { showHelp(false); ev.preventDefault(); }
            else if (view3dOpen()) { EF.view3d.close(); ev.preventDefault(); }
            return;
        }
        // Finché l'aiuto è aperto l'unica uscita è Esc o "?": lasciar passare
        // gli altri comandi cambierebbe la pagina sotto un pannello modale.
        if (helpOpen() && k !== "?") { return; }

        switch (k) {
            case "?":
                showHelp(); ev.preventDefault(); break;
            case "r": case "R":
                call("refresh"); ev.preventDefault(); break;
            case "a": case "A":
                call("toggleAuto"); ev.preventDefault(); break;
            case "t": case "T":
                call("cycleTheme"); ev.preventDefault(); break;
            case "k": case "K":
                call("toggleMode"); ev.preventDefault(); break;
            case "d": case "D":
                call("toggleTech"); ev.preventDefault(); break;
            case "f": case "F":
                toggleFullscreen(); ev.preventDefault(); break;
            case "1":
                go("flow"); ev.preventDefault(); break;
            case "2":
                go("history"); ev.preventDefault(); break;
            /* Storico: `p` cicla il periodo, `[` e `]` scorrono.
               Non si usano le frecce ← →: sono la navigazione naturale dentro
               il tablist del periodo (e lo scorrimento della pagina), e
               rubargliele a livello di documento romperebbe entrambe. */
            case "p": case "P":
                call("histPeriod"); ev.preventDefault(); break;
            case "[":
                call("histPrev"); ev.preventDefault(); break;
            case "]":
                call("histNext"); ev.preventDefault(); break;
            /* `3` apre e chiude la vista 3D. Prima scorreva al pannello
               registri, che però ha già il suo tasto (`d`) e lo apre davvero
               invece di limitarsi a scorrerci: la terza vista era di fatto un
               duplicato del secondo comando.

               Non passa da `actions`: app.js non conosce la vista 3D e non
               deve conoscerla — la 3D si iscrive ai flussi da sé. Se un
               giorno app.js volesse mapparla, l'azione `view3d` ha comunque
               la precedenza. */
            case "3":
                if (typeof actions.view3d === "function") { actions.view3d(); }
                else if (EF.view3d) { EF.view3d.toggle(); }
                ev.preventDefault(); break;
            default: break;
        }
    }

    function call(name) {
        if (typeof actions[name] === "function") { actions[name](); }
    }

    function go(area) {
        // La vista tecnica va aperta prima di scorrerci: altrimenti si
        // scorre verso un pannello nascosto e non succede niente di visibile.
        if (area === "tech") {
            var panel = EF.el("techPanel");
            if (panel && panel.hidden) { call("toggleTech"); }
        }
        if (typeof actions.goto === "function") { actions.goto(area); }
    }

    EF.keys = {
        init: function (map) {
            actions = map || {};
            document.addEventListener("keydown", onKey);

            var o = overlay();
            if (o) {
                // Click fuori dal pannello: chiude.
                o.addEventListener("click", function (ev) {
                    if (ev.target === o) { showHelp(false); }
                });
            }
        },
        help: function () { showHelp(); }
    };
})();
