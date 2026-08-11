![EnergyFlow](cover.png)

<p align="center">
  <img src="assets/branding/logo.svg" alt="Logo EnergyFlow" width="96">
</p>

<h1 align="center">EnergyFlow</h1>

<p align="center">
  Il flusso energetico di casa in tempo reale, letto direttamente dall'inverter<br>
  via Modbus TCP — senza passare dal cloud del costruttore.
</p>

<p align="center">
  <a href="https://archimede.world">archimede.world</a>
</p>

<p align="center">
  <b>IT</b> · <a href="README.en.md">EN</a>
</p>

---

## Overview

EnergyFlow legge i registri dell'inverter fotovoltaico sulla rete locale, li decodifica
con una mappa versionata e **verificata contro il portale ufficiale del costruttore**, e
li pubblica su un'API HTTP locale autenticata.

Da quell'API si servono tre consumatori: la **dashboard web** (desktop e mobile), il
**pannello a muro** in kiosk verticale su Raspberry Pi, e i **widget nativi macOS**.

Il dato arriva con la latenza del poll — 5 secondi — invece dei minuti del portale, e
non lascia mai la casa: il server ascolta **solo su `127.0.0.1`**, quindi non è
raggiungibile nemmeno dalla rete di casa; da telefono e da Mac ci si arriva attraverso
un tailnet privato, non da una porta aperta su internet.

Oltre a *adesso*, la dashboard mostra **come andrà fino a fine giornata di domani** e
**quanto valgono in euro** i kWh che si vedono nelle barre.

Il dispositivo si dichiara da sé nei registri: **SolaX X1‑Hybrid G4** monofase (di cui
il Q.CELLS Q.HOME ESS HYB‑G3 è un rimarchio).

## Funzionalità

**Lettura e correttezza del dato**
- Mappa registri `registers.json` **v2.1**: 69 campi, 48 pubblicati, **21 dichiarati
  `unknown` ed esclusi dall'API** invece di essere indovinati.
- Verifica contro il portale ufficiale con 3 campioni accoppiati e **due identità
  aritmetiche** che chiudono scale e word order insieme.
- **12 invarianti fisici** (`--validate`): bilancio, rendimento, V×I=P, celle, integrale
  della potenza contro il contatore, monotonia dei contatori, azzeramento a mezzanotte,
  produzione notturna nulla, identità giornaliera e totale del portale.
- Watchdog permanente: un valore fuori dal dominio fisico diventa `quality: suspect` e
  porta `/health` a `degraded` (503) entro un poll.

**Robustezza**
- Poller Modbus in thread separato: l'API serve sempre dalla cache e **non si blocca
  mai** se l'inverter è lento o assente.
- **Auto‑discovery**: dopo 5 poll falliti fa uno sweep della subnet sulla porta 502,
  riconosce l'inverter dalla firma dei registri e si riaggancia da solo se il DHCP gli
  ha cambiato indirizzo.
- Servizio **systemd** con `Restart=always`, abilitato al boot.

**Interfaccia**
- Diagramma di flusso con archi **misurati sui nodi reali** (`getBoundingClientRect`),
  nessuna coordinata hardcoded: regge qualunque rapporto d'aspetto.
- **Tema adattivo giorno/notte** agganciato ad alba e tramonto, con override manuale
  persistito. Contrasti **AAA verificati per calcolo**.
- **Due layout da un solo markup**: kiosk verticale 1080×1920 e vista compatta
  mobile/desktop.
- Stati onesti: caricamento **senza numeri finti**, `stale` e `offline` distinti (sono
  due guasti diversi), campi `suspect` barrati.
- Grafico della giornata, bilancio energetico, autonomia stimata della batteria fino
  all'alba, meteo e orari solari.
- **Storico multi‑periodo** — Giorno, Settimana, Mese, Anno — su **230 giorni**
  (90 con il dettaglio al minuto), con la **carica della batteria** accanto alla curva
  nella vista Giorno.
- **Vista 3D** dell'impianto (tasto `3`), caricata solo quando la si apre ed esclusa dal
  pannello a muro.

**Previsione — `GET /api/forecast`**
- Solare, consumo e batteria **fino a fine giornata di domani**, ricalcolati ogni 15
  minuti in background e serviti da cache.
- Il **solare** nasce dall'irraggiamento previsto da open‑meteo moltiplicato per un
  coefficiente **imparato da questo impianto** (misurato: 6,19 W per W/m², R² **della
  taratura** 0,955 — quanto bene la retta spiega i giorni passati, non una precisione
  della previsione): la targa non sa nulla di orientamento, ombre e sporco, i dati
  dell'impianto sì.
- Il **consumo** viene dal profilo mediano per quarto d'ora, feriali e weekend separati,
  riscalato sui totali recenti dello stesso tipo di giorno.
- La **batteria non si prevede: si simula**, integrando `solare − consumo` dal livello di
  carica attuale. È da lì che escono le risposte utili — a che ora tocca il minimo, da
  quando si comincia a prelevare dalla rete, quanti kWh aspettarsi domani.
- **Si dà i voti da sola**: ogni mattina salva quello che ha previsto e il giorno dopo lo
  confronta con la realtà, mostrando l'errore **anche quando è brutto**. Non esiste
  nessuna «precisione dichiarata»: finché la pagella non c'è, la pagina dice che nessuno
  l'ha ancora misurata.
- Senza meteo **non prevede zero produzione**: ripiega sulla mediana di quanto questo
  impianto ha prodotto alla stessa ora nei 7 giorni scorsi, e lo dichiara con un banner.

**Valore in euro**
- Prezzi da `config.json` → blocco `tariff`. **Se manca, non compare nessun importo**:
  nessun prezzo di default, perché uno sbagliato spacciato per giusto è peggio di uno
  assente.
- Tre voci che seguono il periodo scelto nello storico — **speso**, **incassato** e
  soprattutto **risparmiato**, l'energia prodotta e consumata in casa: denaro non uscito,
  di norma la voce più grossa, e l'unica che nessuna bolletta mostra.

**Sicurezza**
- Bind su `127.0.0.1`, token bearer generato in `.env` (perm 600), cookie `HttpOnly;
  SameSite=Strict`, allow‑list esplicita dei file statici, **CSP severa senza CDN né
  inline**, nessun CORS wildcard, seriale dell'inverter mascherato nell'API.

## Installazione e avvio

### Prerequisiti

```bash
python3 --version        # 3.9+
pip install pymodbus     # v3.8 o v3.11+: entrambe supportate
```

### Setup

```bash
git clone https://github.com/ripu/EnergyFlow.git
cd EnergyFlow
cp config.example.json config.json
```

Compila `config.json` con i tuoi valori — coordinate, indirizzo dell'inverter sulla LAN,
capacità della batteria, porta del server:

```jsonc
{
  "location": { "latitude": 0.0, "longitude": 0.0, "timezone": "Europe/Rome" },
  "inverter": { "ip": "<ip-inverter-lan>", "port": 502 },
  "battery":  { "capacity_kwh": 0.0, "min_soc": 0 },
  "solar":    { "capacity_kwp": 0.0 },
  "history":  { "enabled": true, "retention_days": 90 },
  "tariff":   { "currency": "EUR",           // blocco FACOLTATIVO
                "import_eur_kwh": 0.30,      // prezzi DI ESEMPIO: metti i tuoi
                "export_eur_kwh": 0.10 },
  "server":   { "port": 8003 }
}
```

Sulla tariffa vale la pena essere precisi: va usato il **prezzo pieno della bolletta**
(energia + oneri + trasporto + imposte), non la sola componente energia, altrimenti il
risparmio esce sottostimato di parecchio. Se il blocco `tariff` manca, la dashboard non
mostra alcun importo invece di inventarsi un prezzo medio.

`config.json` e `.env` sono gitignorati: non finiscono mai nel repo.

### Avvio

```bash
python3 invert.py --serve            # porta da config.json (default 8003)
python3 invert.py                    # lettura singola a terminale, senza server
python3 invert.py --print-token      # stampa il token di accesso
python3 invert.py --validate --duration 600
python3 invert.py --forecast-backtest 5   # riprova la previsione sui 5 giorni scorsi
```

Poi apri `http://127.0.0.1:8003/` **sulla macchina che lo esegue**: il bind è su
loopback, quindi dalla LAN la pagina non risponde. Al primo avvio il token viene generato
in `.env` con permessi `600`; il browser lo riceve come cookie `HttpOnly` aprendo la
pagina, i client non‑browser leggono **indirizzo e token** da `$ENERGYFLOW_URL` /
`$ENERGYFLOW_TOKEN` oppure dai file `~/.config/energyflow/url` e
`~/.config/energyflow/token`.

Se la porta è occupata **il server non parte** e ti dice quale processo la tiene: non
cambia porta in silenzio.

### Servizio su Raspberry Pi

```bash
sudo cp energyflow.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now energyflow
systemctl status energyflow
```

Per il pannello a muro, `deploy/labwc-autostart` va copiato in
`~/.config/labwc/autostart`: ruota il monitor di 270° e lancia chromium in kiosk su
`http://localhost:8003/`.

Per l'accesso da telefono e da Mac — dentro casa e fuori, senza aprire porte su internet:

```bash
sudo tailscale serve --bg http://127.0.0.1:8003
```

Da lì in avanti la dashboard sta su `https://<rpi-host>.<tailnet>.ts.net/`, ed è quello
l'indirizzo da scrivere in `~/.config/energyflow/url` per i client macOS. Il tunnel SSH
(`ssh -N -L 8003:127.0.0.1:8003 <rpi-host>`) resta come via di riserva.

## Stack tecnologico

| Livello | Tecnologia |
|---|---|
| Backend | Python 3 (`http.server` / `ThreadingHTTPServer`), nessun framework |
| Protocollo | Modbus TCP via `pymodbus` (input register, function code 4) |
| Frontend | HTML5, CSS3, JavaScript classico — **nessun build step, nessun modulo ES** |
| 3D | three.js r159 **vendorizzata** (nessun CDN), caricata solo all'apertura |
| Font | Sora variabile, self‑hostato (~25 KB) |
| Meteo e previsione | Open‑Meteo (osservato + previsto), via proxy server‑side |
| Deploy | systemd su Raspberry Pi, kiosk labwc/Wayland + chromium |
| Accesso remoto | Tailscale (`tailscale serve`, HTTPS, tailnet‑only) |
| Client nativi | Swift (`macos-widget/`) |

## Scorciatoie da tastiera

| Tasto | Azione |
|---|---|
| `?` | Apre e chiude l'aiuto |
| `r` | Aggiorna i dati adesso |
| `a` | Aggiornamento automatico on/off |
| `t` | Tema: automatico → chiaro → scuro → automatico |
| `k` | Modalità kiosk / compatta |
| `1` | Vista flusso |
| `2` | Vista storico |
| `p` | Storico: giorno → settimana → mese → anno |
| `[` / `]` | Storico: periodo precedente / successivo |
| `3` | Vista 3D dell'impianto (apre e chiude) |
| `d` | Pannello registri |
| `f` | Schermo intero |
| `Esc` | Chiude l'overlay |

I tasti sono inerti mentre si scrive in un campo di testo.

## Log e debug

- **Log giornalieri** in `log/YYYY-MM-DD.txt` (cartella gitignorata: restano sulla
  macchina).
- **I log del browser finiscono nello stesso file**: `logger.js` intercetta
  `console.log/warn/error` e gli errori non catturati e li invia a `POST /log`, che li
  scrive con prefisso `[BROWSER:LEVEL]`. Il pannello a muro non ha una console
  raggiungibile, quindi è l'unico modo per vedere cosa è successo.
- **Timing su ogni poll**: durata in millisecondi, sorgente, valori sintetici e
  invarianti falliti, tutto su una riga.
- Su systemd i log sono in `journalctl -u energyflow -f` (`PYTHONUNBUFFERED=1` li rende
  visibili senza ritardo di buffering).
- **`/health`** è una sonda vera, non un ping: `200` se il poller è fresco e nessun
  invariante persiste in errore, `503 degraded` altrimenti, con l'elenco dei problemi.

```bash
curl -s http://127.0.0.1:8003/health | python3 -m json.tool
python3 invert.py --serve --debug        # dump dei registri non-zero ad ogni poll
```

## Documentazione

Lo stato completo del sistema — mappa registri, contratto API, convenzione dei segni,
sicurezza, deployment, go‑live — è in **[`SODE.md`](SODE.md)**.
Come si usa, giorno per giorno, è nella **[guida operativa](docs/guide/manuale.html)**;
cos'è e perché esiste, in dieci minuti, nella
**[presentazione](docs/slides/presentazione.html)**.

Vale la pena leggere almeno la sezione *Convenzione dei segni*: spiega perché
`grid_flow_w` ha il segno opposto al registro che lo produce, e perché il carico di casa
si calcola con la potenza AC **con segno**.

## Screenshots

**Desktop, tema scuro e tema chiaro**

![Dashboard desktop, tema scuro](docs/screenshots/desktop-scuro.png)
![Dashboard desktop, tema chiaro](docs/screenshots/desktop-chiaro.png)

**La previsione** — dopo la riga «adesso» la linea è tratteggiata, più chiara e senza
area sotto: da lì in poi è una previsione, non una misura. Sotto, gli stessi fatti a
parole, con l'errore di ieri dichiarato.

![Previsione fino a fine giornata di domani](docs/screenshots/previsione.png)

**Il valore in euro** — segue il periodo scelto nello storico; in evidenza il
*risparmiato*, l'energia presa dall'impianto invece che dalla rete.

![Valore dell'energia sull'anno](docs/screenshots/valore-anno.png)

**Kiosk verticale 1080×1920 — il pannello a muro**

<img src="docs/screenshots/kiosk-previsione.png" alt="Kiosk verticale con la riga di previsione" width="360">

**Mobile 360 px**

<img src="docs/screenshots/mobile.png" alt="Vista mobile" width="240">

**Stati di guasto** — dati vecchi, backend irraggiungibile, campo sospetto

<img src="docs/screenshots/stato-stale.png" alt="Stato: dati vecchi" width="260">
<img src="docs/screenshots/stato-offline.png" alt="Stato: backend offline" width="260">

![Campo marcato suspect dal watchdog](docs/screenshots/stato-suspect.png)

## Licenza

MIT — vedi [LICENSE](LICENSE).
