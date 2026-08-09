import argparse
import csv
import errno
import hmac
import json
import math
import re
import secrets
import socket
import subprocess
import sys
import time
import os
import threading
import urllib.error
import urllib.parse
import urllib.request
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Dict, List, Optional, Tuple

from pymodbus.client import ModbusTcpClient

# Versione applicativa esposta da /health. Va tenuta allineata al SODE (regola #3).
APP_VERSION = "2.0.0"
START_TIME = time.time()

# --- PATH ANCORATI ALLO SCRIPT ---
# Tutti i file (config, registri, .env, log, statici) si risolvono rispetto alla
# cartella dello script e MAI rispetto alla CWD del processo: il service imposta
# WorkingDirectory, un run manuale no, e far dipendere il serving statico dalla
# CWD è esattamente il difetto che ha reso scaricabile qualsiasi file (vedi
# STATIC_FILES più sotto).
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(BASE_DIR, "config.json")
REGISTERS_PATH = os.path.join(BASE_DIR, "registers.json")
ENV_PATH = os.path.join(BASE_DIR, ".env")
LOG_DIR = os.path.join(BASE_DIR, "log")

# Porta HTTP: unica fonte di verità (regola #6). Vedi resolve_port().
DEFAULT_HTTP_PORT = 8003


# --- LOG SU FILE GIORNALIERO (regole #7 e #10) ---
# Un file per giorno in log/YYYY-MM-DD.txt, accanto al SODE. Manda in pensione il
# vecchio frontend.log piatto, che cresceva senza rotazione. I print su stdout
# restano: il service gira con PYTHONUNBUFFERED=1 e journald li raccoglie, quindi
# la stessa riga è leggibile sia con `journalctl` sia nel file del giorno.
_log_lock = threading.Lock()


def log(msg: str, echo: bool = True, err: bool = False):
    """
    Stampa su stdout (→ journald) e appende al file del giorno.
    err=True dirotta su stderr: serve quando stdout è un canale dati e non deve
    essere sporcato (vedi --print-token). Il service ha StandardError=inherit,
    quindi in journald finisce comunque.
    """
    if echo:
        print(msg, file=sys.stderr if err else sys.stdout)
    line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}"
    try:
        with _log_lock:
            os.makedirs(LOG_DIR, exist_ok=True)
            with open(os.path.join(LOG_DIR, f"{date.today().isoformat()}.txt"), "a", encoding="utf-8") as f:
                f.write(line + "\n")
    except OSError as exc:
        # Il log su file non deve mai far cadere il servizio (SD card piena/ro).
        print(f"⚠️ Log su file non riuscito: {exc}")


# --- CONFIGURAZIONE ---
# Load configuration from config.json
def load_config():
    try:
        with open(CONFIG_PATH, "r") as f:
            return json.load(f)
    except FileNotFoundError:
        print("⚠️  config.json not found, using defaults")
        return {
            "inverter": {"ip": "192.168.x.x", "port": 502}
        }


config = load_config()
INVERTER_IP = config["inverter"]["ip"]
MODBUS_PORT = config["inverter"]["port"]
SLAVE_ID = 1

# --- LETTURA A BLOCCHI ---
# Modbus TCP ammette al massimo 125 registri per singola read (il PDU di risposta
# ha un byte-count a 8 bit): la vecchia read unica da 90 registri stava sotto il
# limite solo perché la mappa era corta, e non poteva arrivare ai registri 148-282
# dove vivono i contatori giornalieri e lo stato del pacco batteria.
# Ogni blocco è indipendente: se uno fallisce si riempie di zeri, si annota in
# meta.blocks_failed e il poll NON fallisce — perdere il blocco 250-374 (diagnostica
# batteria) non deve spegnere la dashboard, che vive sui registri 0-90.
REG_BLOCKS: List[Tuple[int, int]] = [(0, 125), (125, 125), (250, 125)]
REG_SPAN = REG_BLOCKS[-1][0] + REG_BLOCKS[-1][1]
# Riduzione automatica su errore: alcuni gateway Modbus/RTU rifiutano i 125 registri
# pieni. Si scende 125 → 50 → 25 e si memorizza il massimo range che ha funzionato,
# così il costo della scoperta si paga una volta sola.
COUNT_LADDER: Tuple[int, ...] = (125, 50, 25)
_max_count_ok = COUNT_LADDER[0]
_read_kwarg: Optional[str] = None  # 'device_id' (pymodbus ≥3.11), 'slave', o 'unit'

# Identificazione del dispositivo: holding register 0-20, ASCII big-endian.
# Si legge UNA VOLTA all'avvio (e dopo una riconnessione), non ad ogni poll: è
# informazione statica e ogni read in più è una connessione in più verso un
# inverter che ne accetta poche.
_device_info: Dict[str, str] = {}
_device_info_stale = True

DEVICE_HOLDING_COUNT = 21
DEVICE_SERIAL_REGS = (0, 7)   # [start, end) → 14 caratteri
DEVICE_BRAND_REGS = (7, 14)
DEVICE_MODEL_REGS = (14, 21)
RTC_HOLDING_START = 133  # sec, min, ora, giorno, mese, anno−2000


# --- TOKEN DI ACCESSO (regola #17: default-deny) ---
# Protegge /data, /log, /api/*. /health e i file statici della allow-list restano
# aperti: il kiosk deve poter caricare la pagina prima di avere qualsiasi
# credenziale, e il token gli arriva col cookie settato proprio da GET /.
TOKEN_ENV_KEY = "ENERGYFLOW_TOKEN"
COOKIE_NAME = "ef_token"
AUTH_TOKEN = ""  # popolato da serve() → load_or_create_token()


def _read_env_file(path: str) -> Dict[str, str]:
    """Parser .env minimale (KEY=VALUE): niente dipendenze esterne sul Raspberry."""
    values: Dict[str, str] = {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            for raw in f:
                raw = raw.strip()
                if not raw or raw.startswith("#") or "=" not in raw:
                    continue
                key, val = raw.split("=", 1)
                values[key.strip()] = val.strip().strip('"').strip("'")
    except FileNotFoundError:
        pass
    except OSError as exc:
        print(f"⚠️ Lettura {path} fallita: {exc}")
    return values


def load_or_create_token() -> str:
    """
    Ordine: variabile d'ambiente → .env → generazione al primo avvio.
    La generazione automatica è deliberata: il servizio sul Pi non deve rompersi
    al riavvio solo perché manca un file di secret (il pannello a muro resterebbe
    bianco senza che nessuno se ne accorga).
    """
    tok = os.environ.get(TOKEN_ENV_KEY, "").strip()
    if tok:
        return tok

    tok = _read_env_file(ENV_PATH).get(TOKEN_ENV_KEY, "").strip()
    if tok:
        return tok

    tok = secrets.token_urlsafe(32)
    try:
        # Preserva eventuali altre chiavi già presenti nel .env.
        existing = ""
        if os.path.exists(ENV_PATH):
            with open(ENV_PATH, "r", encoding="utf-8") as f:
                existing = f.read()
            if existing and not existing.endswith("\n"):
                existing += "\n"
        # os.open con 0o600: il file non deve mai esistere, nemmeno per un istante,
        # con permessi più larghi (regola #16.8).
        fd = os.open(ENV_PATH, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(existing + f"{TOKEN_ENV_KEY}={tok}\n")
        os.chmod(ENV_PATH, 0o600)
        # err=True: --print-token usa stdout come canale dati, questa nota va a stderr.
        log(f"🔑 Token assente: generato e salvato in {ENV_PATH} (perm 600). "
            f"Recuperalo con `python3 invert.py --print-token`.", err=True)
    except OSError as exc:
        log(f"⚠️ Impossibile scrivere il token in .env ({exc}): uso un token effimero, "
            f"cambierà ad ogni riavvio e i client dovranno essere riconfigurati.", err=True)
    return tok


def signed16(value: int) -> int:
    """Converte un unsigned 16-bit in signed."""
    return value - 65536 if value > 32767 else value


# =====================================================================
# MAPPA REGISTRI (registers.json)
# =====================================================================
# Niente default hardcoded. Prima ne esistevano due copie divergenti — una nel
# JSON e una nel codice come fallback — e la copia nel codice vinceva ogni volta
# che il JSON non caricava, in silenzio. Ora la mappa ha una sola fonte: se il
# file manca o è malformato il processo lo dice e si ferma, invece di servire
# numeri plausibili prodotti da una mappa che nessuno ha scelto.

class MappingError(RuntimeError):
    """registers.json assente, illeggibile o incoerente."""


_mapping: Optional[Dict] = None
_mapping_mtime: float = 0.0
_mapping_lock = threading.Lock()

VALID_TYPES = {"u16", "s16", "u32", "s32"}


def _validate_mapping(data: Dict) -> Dict:
    for key in ("map_version", "word_order", "fields"):
        if key not in data:
            raise MappingError(f"registers.json: manca la chiave '{key}'")
    if data["word_order"] not in ("low_first", "high_first"):
        raise MappingError(f"registers.json: word_order '{data['word_order']}' non valido")
    for name, conf in data["fields"].items():
        if not isinstance(conf, dict):
            raise MappingError(f"registers.json: campo '{name}' non è un oggetto")
        for key in ("reg", "type", "confidence"):
            if key not in conf:
                raise MappingError(f"registers.json: campo '{name}' senza '{key}'")
        if conf["type"] not in VALID_TYPES:
            raise MappingError(f"registers.json: campo '{name}' con type '{conf['type']}' sconosciuto")
    return data


def load_mapping(force: bool = False) -> Dict:
    """
    Carica (e ricarica a caldo, se il file cambia) la mappa registri.
    Il reload su mtime serve a poter verificare il watchdog senza riavviare il
    servizio: si sporca una scala nel JSON e il poll successivo deve accorgersene.
    """
    global _mapping, _mapping_mtime
    with _mapping_lock:
        try:
            mtime = os.path.getmtime(REGISTERS_PATH)
        except OSError as exc:
            raise MappingError(f"registers.json non leggibile: {exc}") from exc
        if _mapping is None or force or mtime != _mapping_mtime:
            try:
                with open(REGISTERS_PATH, "r", encoding="utf-8") as f:
                    data = json.load(f)
            except (OSError, ValueError) as exc:
                raise MappingError(f"registers.json non caricabile: {exc}") from exc
            _mapping = _validate_mapping(data)
            _mapping_mtime = mtime
        return _mapping


def _decimals_for(scale: float) -> int:
    """Quante cifre tenere dopo la virgola per una data scala (0.01 → 2)."""
    if scale >= 1:
        return 0
    return min(6, max(0, int(round(-math.log10(scale)))))


def _raw(regs: List[int], idx: int) -> Optional[int]:
    if 0 <= idx < len(regs):
        return regs[idx]
    return None


def decode_field(regs: List[int], conf: Dict, word_order: str) -> Optional[float]:
    """Decodifica un singolo campo secondo type/scale/word order. None se fuori range."""
    reg = conf["reg"]
    ftype = conf["type"]
    scale = conf.get("scale", 1)

    lo = _raw(regs, reg)
    if lo is None:
        return None

    if ftype == "u16":
        value = lo
    elif ftype == "s16":
        value = signed16(lo)
    else:
        hi = _raw(regs, reg + 1)
        if hi is None:
            return None
        if word_order == "low_first":
            value = lo | (hi << 16)
        else:
            value = hi | (lo << 16)
        if ftype == "s32" and value > 0x7FFFFFFF:
            value -= 0x100000000

    scaled = value * scale
    dec = _decimals_for(scale if scale > 0 else 1)
    return round(scaled, dec) if dec else float(scaled) if isinstance(scaled, float) else scaled


def decode_fields(regs: List[int]) -> Dict[str, Optional[float]]:
    """
    Tutti i campi della mappa con confidence != unknown, per nome.
    I campi `unknown` NON vengono decodificati: restano documentati nel JSON con
    la loro evidenza e non entrano mai nell'API. Un numero che non sappiamo cosa
    sia è peggio di un numero assente — assente si nota, sbagliato no.
    """
    mapping = load_mapping()
    word_order = mapping["word_order"]
    out: Dict[str, Optional[float]] = {}
    for name, conf in mapping["fields"].items():
        if conf.get("confidence") == "unknown":
            continue
        out[name] = decode_field(regs, conf, word_order)
    return out


# =====================================================================
# LETTURA MODBUS
# =====================================================================

def _call_read(fn, addr: int, count: int):
    """
    pymodbus ha cambiato il nome del parametro dello slave tre volte
    (unit → slave → device_id). Si prova una volta e si memorizza quello giusto.
    `fn` è già il metodo legato al client, quindi non serve passare anche il client.
    """
    global _read_kwarg
    if _read_kwarg:
        return fn(addr, count=count, **{_read_kwarg: SLAVE_ID})
    for kwarg in ("device_id", "slave", "unit"):
        try:
            res = fn(addr, count=count, **{kwarg: SLAVE_ID})
        except TypeError:
            continue
        _read_kwarg = kwarg
        return res
    return fn(addr, count=count)


def _ascii_from_regs(regs: List[int], span: Tuple[int, int]) -> str:
    """Registri ASCII big-endian → stringa (2 caratteri per registro)."""
    chars = []
    for idx in range(span[0], min(span[1], len(regs))):
        word = regs[idx]
        for byte in ((word >> 8) & 0xFF, word & 0xFF):
            chars.append(chr(byte) if 32 <= byte < 127 else " ")
    return " ".join("".join(chars).split())


def _mask_serial(serial: str) -> str:
    """
    Il seriale identifica univocamente l'apparecchio e in alcune procedure
    SolaX/Q.CELLS basta a rivendicarlo sul cloud del produttore: nell'API esce
    mascherato (regola #16.8). In chiaro resta solo nel log locale della macchina.
    """
    if len(serial) <= 6:
        return "…"
    return f"{serial[:3]}…{serial[-3:]}"


def _read_device_info(client) -> Dict[str, str]:
    """Holding 0-20: seriale + marca + modello in ASCII. Riusa la connessione aperta."""
    rr = _call_read(client.read_holding_registers, 0, DEVICE_HOLDING_COUNT)
    if rr.isError():
        raise IOError(f"holding registers: {rr}")
    regs = rr.registers
    serial = _ascii_from_regs(regs, DEVICE_SERIAL_REGS)
    brand = _ascii_from_regs(regs, DEVICE_BRAND_REGS)
    model = _ascii_from_regs(regs, DEVICE_MODEL_REGS)
    info: Dict[str, str] = {"model": " ".join(x for x in (brand, model) if x), "serial_full": serial}

    # Orologio interno (holding 133-138: sec, min, ora, giorno, mese, anno−2000).
    # Non serve alla dashboard: serve a sapere se inverter e Raspberry concordano
    # su che ore sono, perché i contatori giornalieri si azzerano sulla mezzanotte
    # DELL'INVERTER mentre l'invariante I8 la cerca su quella del Pi. Uno scarto
    # grosso spiegherebbe un falso allarme invece di farlo inseguire.
    try:
        rc = _call_read(client.read_holding_registers, RTC_HOLDING_START, 6)
        if not rc.isError():
            sec, minute, hour, day, month, year = rc.registers[:6]
            device_clock = datetime(2000 + year, month, day, hour, minute, sec)
            info["clock"] = device_clock.isoformat(timespec="seconds")
            info["clock_skew_s"] = str(int(round(device_clock.timestamp() - time.time())))
    except Exception as exc:
        log(f"ℹ️  Orologio inverter (holding 133-138) non letto: {exc}")
    return info


def read_registers(ip: str = None, port: int = None,
                   span: int = None) -> Tuple[List[int], str, List[int]]:
    """
    Legge gli input register a blocchi. Ritorna (registri, sorgente, blocchi_falliti).
    Un blocco fallito è riempito di zeri: il poll continua, la dashboard resta viva
    e meta.blocks_failed dice cosa manca (quality lo riporta campo per campo).
    """
    global _max_count_ok, _device_info, _device_info_stale
    ip = ip or INVERTER_IP
    port = port or MODBUS_PORT
    span = span or REG_SPAN

    # timeout=3s: evita che una read Modbus lenta/persa appenda il server (vedi poller).
    client = ModbusTcpClient(ip, port=port, timeout=3, retries=1)
    if not client.connect():
        # NIENTE IP nel messaggio: questo testo finisce in /data come last_error e
        # nel 503 servito al browser. L'indirizzo dell'inverter sulla LAN di casa
        # non è informazione da mandare a un client (regola #16.8).
        raise ConnectionError("connessione all'inverter non riuscita")

    try:
        regs = [0] * span
        blocks_failed: List[int] = []
        source = "input_registers"

        for start, count in REG_BLOCKS:
            if start >= span:
                break
            count = min(count, span - start)
            if not _read_block(client, regs, start, count):
                blocks_failed.append(start)

        if len(blocks_failed) == len(REG_BLOCKS):
            raise IOError("nessun blocco di registri leggibile")

        if _device_info_stale:
            try:
                info = _read_device_info(client)
                _device_info = info
                _device_info_stale = False
                log(f"🏷️  Dispositivo: {info['model']} · seriale {info['serial_full']}")
            except Exception as exc:
                log(f"⚠️ Lettura holding 0-20 (identificazione dispositivo) fallita: {exc}")

        return regs, source, blocks_failed

    finally:
        client.close()


def _read_block(client, regs: List[int], start: int, count: int) -> bool:
    """
    Riempie regs[start:start+count]. Su errore scende lungo COUNT_LADDER e
    memorizza il massimo range valido, così i poll successivi non ripagano il costo.
    """
    global _max_count_ok
    ladder = [c for c in COUNT_LADDER if c <= _max_count_ok] or [COUNT_LADDER[-1]]
    for chunk_size in ladder:
        ok = True
        for offset in range(0, count, chunk_size):
            n = min(chunk_size, count - offset)
            try:
                rr = _call_read(client.read_input_registers, start + offset, n)
            except Exception as exc:
                log(f"⚠️ Read {start + offset}+{n} eccezione: {exc}")
                ok = False
                break
            if rr.isError():
                ok = False
                break
            for i, value in enumerate(rr.registers):
                regs[start + offset + i] = value
        if ok:
            if chunk_size < _max_count_ok:
                log(f"ℹ️  Modbus: range massimo ridotto a {chunk_size} registri per read")
                _max_count_ok = chunk_size
            return True
    return False


# =====================================================================
# WATCHDOG DI PLAUSIBILITÀ
# =====================================================================
# Un campo fuori dal suo dominio fisico non viene nascosto né corretto: viene
# pubblicato e marcato `suspect` in quality, con un warning nel log. È il
# meccanismo che avrebbe intercettato subito i 1220,5 V di "tensione batteria" e
# i 4568,6 kWh di "energia giornaliera" della mappa v1.

_counter_state: Dict[str, float] = {}
_counter_lock = threading.Lock()
U32_MAX_RAW = 0xFFFFFFFF

# Un invariante che fallisce su UN campione non basta a dichiarare degraded: reg 2
# e reg 22 non sono letti nello stesso istante e su una rampa ripida il rendimento
# istantaneo può uscire di banda per un poll solo. Servono N poll consecutivi.
# I valori fuori dominio fisico restano invece immediati: lì non c'è rumore di
# campionamento, 452 kWh prodotti in un giorno sono sbagliati subito.
_invariant_strikes: Dict[str, int] = {}


def _update_strikes(failed: List[str], mapping: Dict) -> List[str]:
    """Aggiorna i contatori di fallimento consecutivo e ritorna quelli persistenti."""
    threshold = mapping.get("invariants", {}).get("i2_strikes_before_degraded", 2)
    for iid in list(_invariant_strikes):
        if iid not in failed:
            del _invariant_strikes[iid]
    for iid in failed:
        _invariant_strikes[iid] = _invariant_strikes.get(iid, 0) + 1
    return sorted(i for i, n in _invariant_strikes.items() if n >= threshold)


def check_plausibility(values: Dict[str, Optional[float]]) -> Tuple[Dict[str, str], List[str]]:
    """values: {nome_pubblicato: valore}. Ritorna (quality_override, warnings)."""
    mapping = load_mapping()
    domains = mapping.get("plausibility", {})
    quality: Dict[str, str] = {}
    warnings: List[str] = []
    for name, value in values.items():
        if value is None:
            continue
        domain = domains.get(name)
        if not domain:
            continue
        low, high = domain
        if not (low <= value <= high):
            quality[name] = "suspect"
            warnings.append(f"{name}={value} fuori dal dominio [{low}, {high}]")
    return quality, warnings


def check_counters(totals: Dict[str, Optional[float]]) -> Tuple[Dict[str, str], List[str]]:
    """
    I contatori totali non tornano indietro. Se uno diminuisce e NON siamo vicini
    al rollover del 32 bit, o l'inverter è stato sostituito o stiamo leggendo il
    registro sbagliato: in entrambi i casi è `suspect`, non un dato da mostrare.
    """
    quality: Dict[str, str] = {}
    warnings: List[str] = []
    mapping = load_mapping()
    with _counter_lock:
        for name, value in totals.items():
            if value is None:
                continue
            previous = _counter_state.get(name)
            if previous is not None and value < previous - 1e-9:
                conf = mapping["fields"].get(name, {})
                scale = conf.get("scale", 1)
                rollover_zone = U32_MAX_RAW * scale * 0.99
                if previous < rollover_zone:
                    quality[name] = "suspect"
                    warnings.append(
                        f"contatore {name} diminuito {previous} → {value} fuori dal rollover"
                    )
            if previous is None or value >= previous:
                _counter_state[name] = value
    return quality, warnings


# =====================================================================
# COSTRUZIONE DEL PAYLOAD
# =====================================================================
# CONTRATTO DA NON ROMPERE — i sei campi
#   derived.{solar_power_w, battery_percent, grid_flow_w, home_load_w,
#            inverter_power_w, battery_power_w}
# sono decodificati da tre client Swift/JSX in macos-widget/ come NON opzionali:
# un null li fa fallire in silenzio, senza un errore visibile. Quindi restano
# sempre presenti, numerici, con la stessa convenzione di segno. Swift ignora le
# chiavi che non conosce, perciò AGGIUNGERE campi è sicuro; rinominarli o
# annullarli no.

DERIVED_CONTRACT = (
    "solar_power_w", "battery_percent", "grid_flow_w",
    "home_load_w", "inverter_power_w", "battery_power_w",
)

STATUS_DEADBAND_W = 20.0


def _num(value: Optional[float], fallback: float = 0.0) -> float:
    return fallback if value is None else float(value)


def _publish_tree(fields: Dict[str, Optional[float]]) -> Tuple[Dict, Dict, Dict[str, str]]:
    """
    Distribuisce i campi decodificati nelle sezioni indicate da `publish`.
    Un campo `measured`/`energy` senza valore viene OMESSO (gli Optional Swift lo
    decodificano pulito) e quality dice il perché.
    """
    mapping = load_mapping()
    measured: Dict[str, float] = {}
    energy: Dict[str, Dict[str, float]] = {"today": {}, "total": {}}
    quality: Dict[str, str] = {}

    for name, conf in mapping["fields"].items():
        if conf.get("confidence") == "unknown":
            continue
        path = conf.get("publish") or ""
        if not path:
            continue
        value = fields.get(name)
        parts = path.split(".")
        leaf = parts[-1]
        if value is None:
            quality[leaf] = "unavailable"
            continue
        if parts[0] == "measured":
            measured[leaf] = value
        elif parts[0] == "energy" and len(parts) == 3:
            energy[parts[1]][leaf] = value
        quality[leaf] = "measured"

    return measured, energy, quality


def decode_values(regs: List[int]) -> Dict[str, float]:
    """
    Deriva i sei valori del contratto pubblico + i tre di comodo, dai registri
    grezzi e dalla mappa. Nessuna formula tautologica: solar_power_w viene dai
    registri di potenza DC delle stringhe (10, 11), non da un giro algebrico che
    si semplificava in `|inverter| + batteria` e quindi tornava con qualunque
    mappa, anche sbagliata.
    """
    fields = decode_fields(regs)

    inverter_signed = _num(fields.get("inverter_power_w"))
    # Convenzione dei segni sulla rete: vedi SODE, sezione «Convenzione dei segni
    # — decision record». Il registro grezzo (70,71) è positivo in immissione;
    # l'API pubblica grid_flow_w positivo in prelievo, quindi si inverte.
    grid_flow_w = -_num(fields.get("grid_feedin_power_w"))

    # home = potenza AC dell'inverter (CON segno) + flusso di rete. Il segno conta:
    # di notte, caricando la batteria da rete, l'inverter assorbe (reg 2 negativo)
    # e usare il modulo gonfiava il carico di casa del doppio della carica.
    home_load_w = inverter_signed + grid_flow_w
    if home_load_w < 0:
        home_load_w = 0.0

    solar_power_w = _num(fields.get("pv1_power_w")) + _num(fields.get("pv2_power_w"))

    return {
        # --- contratto pubblico, invariato per nome/tipo/segno ---
        "solar_power_w": round(solar_power_w, 1),
        "battery_percent": _num(fields.get("battery_percent")),
        "grid_flow_w": round(grid_flow_w, 1),
        "home_load_w": round(home_load_w, 1),
        "inverter_power_w": round(abs(inverter_signed), 1),   # modulo: come da contratto
        "battery_power_w": _num(fields.get("battery_power_w")),
        # --- già presenti, ora finalmente giusti ---
        "grid_voltage_v": _num(fields.get("inverter_voltage_v")),
        "battery_voltage_v": _num(fields.get("battery_voltage_v")),
        "daily_energy_kwh": _num(fields.get("solar_today_kwh")),
    }


def _status_block(fields: Dict[str, Optional[float]], derived: Dict[str, float]) -> Dict[str, str]:
    mapping = load_mapping()
    labels = mapping.get("run_mode_labels", {})
    battery = derived["battery_power_w"]
    grid = derived["grid_flow_w"]
    run_mode = fields.get("run_mode")
    return {
        "battery": "charging" if battery > STATUS_DEADBAND_W
        else "discharging" if battery < -STATUS_DEADBAND_W else "idle",
        "grid": "importing" if grid > STATUS_DEADBAND_W
        else "exporting" if grid < -STATUS_DEADBAND_W else "balanced",
        "system": labels.get(str(int(run_mode)), f"unknown({int(run_mode)})")
        if run_mode is not None else "unknown",
    }


def build_payload(regs: List[int], source: str, blocks_failed: List[int] = None) -> Dict:
    """Payload completo: derived (contratto) + measured + energy + status + quality + meta."""
    mapping = load_mapping()
    fields = decode_fields(regs)
    derived = decode_values(regs)
    measured, energy, quality = _publish_tree(fields)

    # Watchdog: prima sui derivati, poi sui misurati, poi sui contatori totali.
    warnings: List[str] = []
    for bucket in (derived, measured, energy["today"], energy["total"]):
        overrides, warns = check_plausibility(bucket)
        quality.update(overrides)
        warnings.extend(warns)

    total_names = {
        name: energy["total"].get(conf["publish"].split(".")[-1])
        for name, conf in mapping["fields"].items()
        if (conf.get("publish") or "").startswith("energy.total.")
        and conf.get("confidence") != "unknown"
    }
    overrides, warns = check_counters(total_names)
    for name, state in overrides.items():
        quality[mapping["fields"][name]["publish"].split(".")[-1]] = state
    warnings.extend(warns)

    for name in derived:
        quality.setdefault(name, "derived")
    for start in (blocks_failed or []):
        warnings.append(f"blocco registri {start}-{start + 124} non letto")

    if warnings:
        for warn in warnings:
            log(f"⚠️ PLAUSIBILITY {warn}")

    # Invarianti valutabili su un singolo campione: girano ad ogni poll ed è ciò
    # che rende /health una sonda vera e non un ping al processo.
    invariants = evaluate_invariants([{"ts": time.time(), "regs": regs}], payload_derived=derived)
    failed = [inv["id"] for inv in invariants if inv["status"] == "fail"]
    persistent = _update_strikes(failed, mapping)

    device = {}
    if _device_info:
        device = {
            "model": _device_info.get("model", ""),
            "serial": _mask_serial(_device_info.get("serial_full", "")),
            "serial_masked": True,
        }
        if "clock_skew_s" in _device_info:
            device["clock_skew_s"] = int(_device_info["clock_skew_s"])

    return {
        "raw": {i: v for i, v in enumerate(regs)},
        "derived": derived,
        "measured": measured,
        "energy": energy,
        "status": _status_block(fields, derived),
        "quality": quality,
        "meta": {
            # NIENTE `ip`: nessun client lo usava e la telemetria di casa non deve
            # portarsi dietro l'indirizzo di un dispositivo sulla LAN (regola #16.8).
            "port": MODBUS_PORT,
            "source": source,
            "count": len(regs),
            "blocks_failed": blocks_failed or [],
            "map_version": mapping.get("map_version", "?"),
            "device": device,
            "validation": {
                "invariants_failed": failed,
                "invariants_failed_persistent": persistent,
                "warnings": warnings,
            },
            "timestamp": time.time(),
        },
    }


def print_table(regs: List[int], source: str):
    print(f"✅ Connesso! Sorgente: {source}")
    if _device_info:
        print(f"🏷️  {_device_info.get('model', '')} · seriale {_device_info.get('serial_full', '')}")
    print("-" * 64)
    mapping = load_mapping()
    by_reg = {}
    for name, conf in mapping["fields"].items():
        by_reg.setdefault(conf["reg"], []).append(name)
    print(f"{'REG':<6} | {'GREZZO':<10} | CAMPO")
    print("-" * 64)
    for i, val in enumerate(regs):
        if val == 0 and i not in by_reg:
            continue
        if val == 0:
            continue
        names = ", ".join(by_reg.get(i, [])) or "—"
        print(f"{i:<6} | {val:<10} | {names}")
    print("-" * 64)


# --- AUTO-DISCOVERY INVERTER ---
# Se l'inverter sparisce (es. DHCP gli cambia IP), il poller dopo
# DISCOVERY_FAIL_THRESHOLD poll falliti consecutivi fa uno sweep della subnet
# sulla porta Modbus, verifica il candidato leggendo i registri-firma e
# aggiorna config.json. Vedi SODE §2.1.
DISCOVERY_FAIL_THRESHOLD = 5   # poll falliti consecutivi prima dello sweep (~40s)
DISCOVERY_MIN_INTERVAL = 60    # secondi minimi tra due sweep consecutivi


def _local_subnet_prefix() -> str:
    """Prefisso /24 della LAN locale (es. '192.168.1.'). Fallback: subnet dell'ultimo IP noto."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(("8.8.8.8", 80))  # nessun pacchetto inviato: serve solo a scegliere l'interfaccia
            return s.getsockname()[0].rsplit(".", 1)[0] + "."
        finally:
            s.close()
    except OSError:
        return INVERTER_IP.rsplit(".", 1)[0] + "."


def _port_open(ip: str, port: int, timeout: float = 0.6) -> bool:
    try:
        with socket.create_connection((ip, port), timeout=timeout):
            return True
    except OSError:
        return False


def _looks_like_inverter(regs: List[int]) -> bool:
    """Firma anti falsi-positivi: reg 0 = tensione AC ~230V*10, reg 28 = SOC 0-100."""
    if len(regs) < 29:
        return False
    return 1800 <= regs[0] <= 2600 and 0 <= regs[28] <= 100


def _persist_inverter_ip(new_ip: str):
    """Riscrive config.json con il nuovo IP (preserva il resto della config)."""
    try:
        with open(CONFIG_PATH, "r") as f:
            cfg = json.load(f)
        cfg.setdefault("inverter", {})["ip"] = new_ip
        with open(CONFIG_PATH, "w") as f:
            json.dump(cfg, f, indent=4)
        log("💾 config.json aggiornato con il nuovo IP dell'inverter")
    except Exception as exc:
        # Non fatale: l'IP in memoria è già aggiornato, persiste solo fino al restart
        log(f"⚠️ Impossibile salvare config.json: {exc}")


def discover_inverter() -> str:
    """
    Sweep della subnet /24 sulla porta Modbus + verifica firma registri.
    Ritorna il nuovo IP se trovato, altrimenti None. Timing loggato (regola #7).
    """
    global INVERTER_IP, _device_info_stale
    t0 = time.time()
    prefix = _local_subnet_prefix()
    log(f"🔍 Discovery: sweep {prefix}0/24 porta {MODBUS_PORT}...")

    candidates = []
    with ThreadPoolExecutor(max_workers=64) as pool:
        ips = [f"{prefix}{i}" for i in range(1, 255)]
        for ip, is_open in zip(ips, pool.map(lambda ip: _port_open(ip, MODBUS_PORT), ips)):
            if is_open:
                candidates.append(ip)

    log(f"🔍 Discovery: {len(candidates)} candidati con porta aperta")

    for ip in candidates:
        try:
            regs, _, _ = read_registers(ip=ip, span=30)
        except Exception:
            continue
        if _looks_like_inverter(regs):
            elapsed_ms = (time.time() - t0) * 1000
            log(f"✅ Discovery {elapsed_ms:.0f}ms: inverter ritrovato a un nuovo indirizzo")
            INVERTER_IP = ip
            _device_info_stale = True  # nuova connessione → rileggi l'identificazione
            _persist_inverter_ip(ip)
            return ip
        log("🔍 Discovery: candidato con porta aperta ma firma registri non combaciante, skip")

    elapsed_ms = (time.time() - t0) * 1000
    log(f"⚠️ Discovery {elapsed_ms:.0f}ms: inverter non trovato sulla subnet")
    return None


# =====================================================================
# INVARIANTI
# =====================================================================
# Il test che la versione precedente non poteva fallire: `solare = casa + batteria
# − rete` con `casa = |inverter| + rete` si semplifica in `solare = |inverter| +
# batteria`. È un'identità algebrica — torna anche con registri estratti a caso,
# quindi non validava niente. Qui ogni invariante confronta grandezze che arrivano
# da REGISTRI DIVERSI, così un errore di mappa o di scala non può cancellarsi da solo.
#
# I1 è di natura diversa dagli altri e va detto: `home` è DEFINITO come
# inverter+rete, quindi I1 non è un test di fisica ma un test del codice — ricalcola
# il valore atteso dai registri grezzi e lo confronta con quello pubblicato, così
# un'inversione di segno introdotta in futuro in decode_values viene vista subito.
# La verifica fisica vera la fanno I2, I3, I4 e soprattutto I6.


def _fields_of(regs: List[int]) -> Dict[str, Optional[float]]:
    return decode_fields(regs)


def _pct_err(a: float, b: float) -> float:
    return abs(a - b) / abs(b) if b else float("inf")


def _inv(iid: str, name: str, status: str, detail: str) -> Dict:
    return {"id": iid, "name": name, "status": status, "detail": detail}


def _i1(f, cfg, derived) -> Dict:
    ac = _num(f.get("inverter_power_w"))
    grid_in = -_num(f.get("grid_feedin_power_w"))
    expected = max(0.0, ac + grid_in)
    if derived is None:
        return _inv("I1", "home = inverter_ac + grid_flow", "skip", "nessun derivato da confrontare")
    got = derived["home_load_w"]
    tol = max(cfg["i1_home_balance_w"], abs(expected) * cfg["i1_home_balance_pct"])
    status = "pass" if abs(got - expected) <= tol else "fail"
    return _inv("I1", "home = inverter_ac + grid_flow", status,
                f"atteso {expected:.0f} W (reg2 {ac:.0f} + rete {grid_in:.0f}), "
                f"pubblicato {got:.0f} W, tolleranza ±{tol:.0f} W")


def _i2(f, cfg, _derived) -> Dict:
    pv = _num(f.get("pv1_power_w")) + _num(f.get("pv2_power_w"))
    ac = _num(f.get("inverter_power_w"))
    batt = _num(f.get("battery_power_w"))
    if pv < cfg["i2_min_pv_w"]:
        return _inv("I2", "rendimento ac/(pv−batt)", "skip", f"pv {pv:.0f} W sotto {cfg['i2_min_pv_w']} W")
    denom = pv - batt
    if denom <= 0 or ac <= 0:
        return _inv("I2", "rendimento ac/(pv−batt)", "skip", f"denominatore {denom:.0f} W non utilizzabile")
    eta = ac / denom
    # Due bande, non una. A batteria ferma il percorso è solo PV→AC e il rendimento
    # misurato sta in una forchetta strettissima (0.913-0.924 su 34 campioni): lì la
    # banda [0.90, 0.99] ha valore. Con la batteria attiva reg 2 e reg 22 non sono
    # letti nello stesso istante e in rampa il rapporto sfonda l'unità (1.015
    # osservato): tenere la banda stretta produrrebbe un allarme che scatta per la
    # fisica dello strumento, e uno strumento che grida al lupo viene spento.
    active = abs(batt) > cfg["i2_battery_deadband_w"]
    lo, hi = cfg["i2_efficiency_range_battery_active"] if active else cfg["i2_efficiency_range"]
    status = "pass" if lo <= eta <= hi else "fail"
    return _inv("I2", "rendimento ac/(pv−batt)", status,
                f"η = {ac:.0f}/({pv:.0f}−{batt:.0f}) = {eta:.3f}, atteso [{lo}, {hi}] "
                f"(batteria {'attiva' if active else 'ferma'})")


def _i3(f, cfg, _derived) -> Dict:
    """
    V×I contro P sulle tre coppie, ma con due accorgimenti che vengono dai dati e
    non dalla teoria:
    · le correnti sono TRONCATE, non arrotondate (su 34 campioni V×I risulta
      sistematicamente più bassa di P, mediana −2.8%, mai sopra +0.3%): la corrente
      vera sta in [I, I+LSB), quindi il test verifica che P cada in quella fascia
      invece di confrontarlo con un punto solo;
    · sul lato AC V×I è potenza APPARENTE e P è attiva: il loro rapporto è il fattore
      di potenza (0.979-1.005 misurato), non un errore da azzerare.
    """
    mapping = load_mapping()

    def lsb(field_name: str) -> float:
        return mapping["fields"].get(field_name, {}).get("scale", 0.1)

    details, failed, checked = [], 0, 0
    tol = cfg["i3_tolerance_pct"]

    # --- AC: rapporto attiva/apparente = fattore di potenza ---
    v, i, p = f.get("inverter_voltage_v"), f.get("inverter_current_a"), f.get("inverter_power_w")
    if v and i and p and abs(p) >= cfg["i3_min_power_w"]:
        checked += 1
        apparent = abs(v * i)
        pf = abs(p) / apparent if apparent else 0
        lo, hi = cfg["i3_ac_pf_range"]
        bad = not (lo <= pf <= hi)
        failed += bad
        details.append(f"AC (0,1,2): {v:.1f}×{abs(i):.1f}={apparent:.0f} VA vs {abs(p):.0f} W → pf {pf:.3f}")
    else:
        details.append("AC (0,1,2): skip")

    # --- PV: DC puro, P deve cadere nella fascia [V·I, V·(I+LSB)] ---
    for v_key, i_key, p_key, label in (
        ("pv1_voltage_v", "pv1_current_a", "pv1_power_w", "PV1 (3,5,10)"),
        ("pv2_voltage_v", "pv2_current_a", "pv2_power_w", "PV2 (4,6,11)"),
    ):
        v, i, p = f.get(v_key), f.get(i_key), f.get(p_key)
        if v is None or i is None or p is None or abs(p) < cfg["i3_min_power_w"]:
            details.append(f"{label}: skip")
            continue
        checked += 1
        low = abs(v * i) * (1 - tol)
        high = abs(v * (abs(i) + lsb(i_key))) * (1 + tol)
        bad = not (low <= abs(p) <= high)
        failed += bad
        details.append(f"{label}: {abs(p):.0f} W in [{low:.0f}, {high:.0f}] "
                       f"({v:.1f} V × {abs(i):.1f}–{abs(i) + lsb(i_key):.1f} A)")

    if not checked:
        return _inv("I3", "V×I ≈ P", "skip", "; ".join(details))
    return _inv("I3", "V×I ≈ P", "fail" if failed else "pass", "; ".join(details))


def _i4(f, cfg, _derived) -> Dict:
    """
    Rendimento della giornata: la resa AC (reg 80) non può superare l'energia DC
    che le è arrivata, cioè produzione solare (150) più scarica batteria (32) meno
    carica (35). Quattro contatori distinti, quattro scale fissate insieme: se una
    sola fosse sbagliata di 10× il rapporto uscirebbe dalla banda o il denominatore
    diventerebbe negativo.
    Sostituisce l'ancoraggio del SOC su reg 280/282 previsto in origine: quei due
    registri sono stati declassati a `unknown` perché tutti i campioni disponibili
    sono allo stesso SOC (99%) e con un punto solo la coincidenza aritmetica non è
    distinguibile dal caso.
    """
    yield_today = f.get("yield_today_kwh")
    solar_today = f.get("solar_today_kwh")
    charge = f.get("battery_charge_today_kwh")
    discharge = f.get("battery_discharge_today_kwh")
    if None in (yield_today, solar_today, charge, discharge):
        return _inv("I4", "rendimento giornaliero AC/DC", "skip", "contatori 80/150/32/35 non disponibili")
    dc = solar_today + discharge - charge
    if dc < cfg["i4_min_dc_kwh"]:
        return _inv("I4", "rendimento giornaliero AC/DC", "skip",
                    f"energia DC del giorno {dc:.2f} kWh sotto {cfg['i4_min_dc_kwh']} kWh")
    ratio = yield_today / dc
    lo, hi = cfg["i4_daily_efficiency_range"]
    status = "pass" if lo <= ratio <= hi else "fail"
    return _inv("I4", "rendimento giornaliero AC/DC", status,
                f"{yield_today:.1f} / ({solar_today:.1f} + {discharge:.1f} − {charge:.1f}) = "
                f"{ratio:.3f}, atteso [{lo}, {hi}]")


def _i11(f, cfg, _derived) -> Dict:
    """
    Bilancio al contatore, oggi: quello che è uscito dall'inverter, meno quello
    immesso in rete, più quello prelevato, più l'EPS, è il consumo di casa. Sul
    portale ufficiale questa somma dà 38.0 − 16.7 + 0.1 + 0 = 21.4 kWh, cioè
    esattamente il «Daily consumption» mostrato. Fissa insieme le scale di 80
    (×0.1) e di 152/154 (×0.01): se export e import fossero ×0.1 il consumo
    uscirebbe negativo.
    """
    fields = [f.get(k) for k in ("yield_today_kwh", "grid_export_today_kwh",
                                 "grid_import_today_kwh", "eps_yield_today_kwh")]
    if any(v is None for v in fields):
        return _inv("I11", "consumo di casa oggi dai contatori", "skip", "contatori 80/152/154/144 non disponibili")
    y, exp, imp, eps = fields
    consumption = y - exp + imp + eps
    lo, hi = cfg["i11_consumption_range_kwh"]
    status = "pass" if lo <= consumption <= hi else "fail"
    return _inv("I11", "consumo di casa oggi dai contatori", status,
                f"{y:.1f} − {exp:.2f} + {imp:.2f} + {eps:.1f} = {consumption:.2f} kWh, atteso [{lo}, {hi}]")


def _i12(f, cfg, _derived) -> Dict:
    """Stesso bilancio sui contatori totali: 4569.6 − 2126.00 + 242.30 + 87.1 = 2773.0
    contro i 2770.18 kWh del portale (0.1%). Chiude scale e ruolo di 72/74 a vita."""
    fields = [f.get(k) for k in ("yield_total_kwh", "grid_export_total_kwh",
                                 "grid_import_total_kwh", "eps_yield_total_kwh")]
    if any(v is None for v in fields):
        return _inv("I12", "consumo di casa totale dai contatori", "skip", "contatori 82/72/74/142 non disponibili")
    y, exp, imp, eps = fields
    consumption = y - exp + imp + eps
    if y <= 0:
        return _inv("I12", "consumo di casa totale dai contatori", "skip", "resa totale nulla")
    ratio = consumption / y
    lo, hi = cfg["i12_total_ratio_range"]
    status = "pass" if consumption > 0 and lo <= ratio <= hi else "fail"
    return _inv("I12", "consumo di casa totale dai contatori", status,
                f"{y:.1f} − {exp:.2f} + {imp:.2f} + {eps:.1f} = {consumption:.2f} kWh "
                f"({ratio:.2f}× la resa, atteso [{lo}, {hi}])")


def _i5(f, cfg, _derived) -> Dict:
    pack = f.get("battery_voltage_v")
    cmax = f.get("battery_cell_voltage_max_v")
    cmin = f.get("battery_cell_voltage_min_v")
    if not pack or not cmax or not cmin:
        return _inv("I5", "tensione pacco / cella ≈ intero", "skip", "registri 20/188/189 non disponibili")
    avg = (cmax + cmin) / 2
    n = pack / avg
    nearest = round(n)
    lo, hi = cfg["i5_cell_count_range"]
    ok = lo <= nearest <= hi and abs(n - nearest) / nearest <= cfg["i5_tolerance_pct"]
    return _inv("I5", "tensione pacco / cella ≈ intero", "pass" if ok else "fail",
                f"{pack:.1f} V / {avg:.3f} V = {n:.2f} celle (intero più vicino {nearest}, "
                f"range ammesso {lo}-{hi})")


def _i9(f, cfg, _derived, ts=None) -> Dict:
    if ts is None:
        return _inv("I9", "di notte pv ≈ 0", "skip", "nessun timestamp")
    hour = datetime.fromtimestamp(ts).hour
    start, end = cfg["i9_night_hours"]
    is_night = hour >= start or hour < end
    if not is_night:
        return _inv("I9", "di notte pv ≈ 0", "skip", f"ora locale {hour}, fuori dalla finestra notturna")
    pv = _num(f.get("pv1_power_w")) + _num(f.get("pv2_power_w"))
    status = "pass" if pv < cfg["i9_max_pv_w"] else "fail"
    return _inv("I9", "di notte pv ≈ 0", status, f"ora {hour}, pv {pv:.0f} W (max {cfg['i9_max_pv_w']} W)")


def _i10(f, cfg, derived) -> Dict:
    soc = f.get("battery_percent")
    pv = _num(f.get("pv1_power_w")) + _num(f.get("pv2_power_w"))
    if derived is None:
        return _inv("I10", "SOC 100 + surplus ⇒ batteria ferma ed export", "skip", "nessun derivato")
    home = derived["home_load_w"]
    if soc is None or soc < 100 or pv <= home:
        return _inv("I10", "SOC 100 + surplus ⇒ batteria ferma ed export", "skip",
                    f"condizione non verificata (soc {soc}, pv {pv:.0f} W, casa {home:.0f} W)")
    batt = derived["battery_power_w"]
    grid = derived["grid_flow_w"]
    ok = abs(batt) <= cfg["i10_deadband_w"] and grid < 0
    return _inv("I10", "SOC 100 + surplus ⇒ batteria ferma ed export", "pass" if ok else "fail",
                f"batteria {batt:.0f} W, rete {grid:.0f} W (atteso |batt| ≤ {cfg['i10_deadband_w']} e rete < 0)")


def _i6(snapshots, cfg) -> Dict:
    """
    L'invariante decisivo: integra la potanza istantanea delle stringhe (reg 10, 11)
    e la confronta con l'avanzamento del contatore giornaliero (reg 150). Due
    percorsi indipendenti dentro il firmware — una misura di potenza e un
    accumulatore di energia — che devono arrivare allo stesso numero. Fissa
    insieme entrambe le scale: se una delle due è sbagliata di 10×, qui si vede.
    """
    if len(snapshots) < 3:
        return _inv("I6", "∫pv·dt ≈ Δ contatore giornaliero", "skip", "meno di 3 campioni")
    series = []
    for snap in snapshots:
        f = _fields_of(snap["regs"])
        pv = _num(f.get("pv1_power_w")) + _num(f.get("pv2_power_w"))
        today = f.get("solar_today_kwh")
        series.append((snap["ts"], pv, today))
    series.sort(key=lambda x: x[0])

    delta = (series[-1][2] or 0) - (series[0][2] or 0)
    if delta < 0:
        return _inv("I6", "∫pv·dt ≈ Δ contatore giornaliero", "skip",
                    "il contatore si è azzerato nella finestra (mezzanotte)")
    if delta < cfg["i6_min_delta_kwh"]:
        return _inv("I6", "∫pv·dt ≈ Δ contatore giornaliero", "skip",
                    f"Δ contatore {delta:.2f} kWh sotto la soglia {cfg['i6_min_delta_kwh']} kWh "
                    f"(finestra {(series[-1][0] - series[0][0]) / 60:.0f} min: troppo corta per la "
                    f"risoluzione di {cfg['i6_counter_resolution_kwh']} kWh)")

    integral_wh = 0.0
    for (t0, p0, _), (t1, p1, _) in zip(series, series[1:]):
        dt = t1 - t0
        if dt <= 0 or dt > 600:  # buco nei dati: non si integra sopra un vuoto
            continue
        integral_wh += (p0 + p1) / 2 * dt / 3600
    integral = integral_wh / 1000

    # La tolleranza include la quantizzazione del contatore (0,1 kWh): su finestre
    # corte è il termine dominante e ignorarla produrrebbe falsi allarmi (#29.3).
    tol = max(cfg["i6_tolerance_pct"], 2 * cfg["i6_counter_resolution_kwh"] / delta)
    err = _pct_err(integral, delta)
    status = "pass" if err <= tol else "fail"
    return _inv("I6", "∫pv·dt ≈ Δ contatore giornaliero", status,
                f"∫ = {integral:.3f} kWh su {(series[-1][0] - series[0][0]) / 60:.0f} min, "
                f"Δ reg150 = {delta:.2f} kWh, scarto {err * 100:.1f}% (tolleranza {tol * 100:.1f}%)")


TOTAL_COUNTER_FIELDS = (
    "battery_discharge_total_kwh", "battery_charge_total_kwh",
    "grid_export_total_kwh", "grid_import_total_kwh",
    "yield_total_kwh", "solar_total_kwh",
)
DAILY_COUNTER_FIELDS = (
    "solar_today_kwh", "yield_today_kwh", "grid_export_today_kwh",
    "grid_import_today_kwh", "battery_charge_today_kwh", "battery_discharge_today_kwh",
)


def _i7(snapshots, _cfg) -> Dict:
    if len(snapshots) < 2:
        return _inv("I7", "contatori totali monotoni", "skip", "meno di 2 campioni")
    problems = []
    previous: Dict[str, float] = {}
    for snap in sorted(snapshots, key=lambda s: s["ts"]):
        f = _fields_of(snap["regs"])
        for name in TOTAL_COUNTER_FIELDS:
            value = f.get(name)
            if value is None:
                continue
            if name in previous and value < previous[name] - 1e-9:
                problems.append(f"{name}: {previous[name]} → {value}")
            previous[name] = max(previous.get(name, value), value)
    return _inv("I7", "contatori totali monotoni", "fail" if problems else "pass",
                "; ".join(problems) if problems else f"{len(TOTAL_COUNTER_FIELDS)} contatori, nessuna diminuzione")


def _i8(snapshots, _cfg) -> Dict:
    ordered = sorted(snapshots, key=lambda s: s["ts"])
    problems, crossings = [], 0
    for prev, cur in zip(ordered, ordered[1:]):
        d0 = datetime.fromtimestamp(prev["ts"])
        d1 = datetime.fromtimestamp(cur["ts"])
        if d0.date() == d1.date():
            continue
        crossings += 1
        if not (d1.hour == 0 and d1.minute <= 10):
            continue
        f = _fields_of(cur["regs"])
        for name in DAILY_COUNTER_FIELDS:
            value = f.get(name)
            if value is not None and value > 0.2:
                problems.append(f"{name} = {value} dopo la mezzanotte")
    if not crossings:
        return _inv("I8", "contatori giornalieri azzerati a mezzanotte", "skip",
                    "la finestra di campionamento non attraversa la mezzanotte")
    return _inv("I8", "contatori giornalieri azzerati a mezzanotte",
                "fail" if problems else "pass", "; ".join(problems) or f"{crossings} passaggi di giorno, tutti puliti")


def evaluate_invariants(snapshots: List[Dict], payload_derived: Dict = None) -> List[Dict]:
    """
    snapshots: [{"ts": float, "regs": [int, ...]}, ...]
    Gli invarianti puntuali girano su OGNI campione e si aggregano (basta un fail);
    quelli di serie (I6, I7, I8) sull'intera finestra.
    """
    mapping = load_mapping()
    cfg = mapping.get("invariants", {})
    if not snapshots:
        return []

    point_checks = (("I1", _i1), ("I2", _i2), ("I3", _i3), ("I4", _i4), ("I5", _i5),
                    ("I10", _i10), ("I11", _i11), ("I12", _i12))
    aggregated: Dict[str, Dict] = {}

    for snap in snapshots:
        f = _fields_of(snap["regs"])
        derived = payload_derived if len(snapshots) == 1 and payload_derived else decode_values(snap["regs"])
        results = [fn(f, cfg, derived) for _, fn in point_checks]
        results.append(_i9(f, cfg, derived, ts=snap.get("ts")))
        for res in results:
            current = aggregated.get(res["id"])
            # priorità: fail > pass > skip — l'ultimo dettaglio utile vince
            rank = {"fail": 2, "pass": 1, "skip": 0}
            if current is None or rank[res["status"]] > rank[current["status"]]:
                aggregated[res["id"]] = res

    series = [_i6(snapshots, cfg), _i7(snapshots, cfg), _i8(snapshots, cfg)]
    for res in series:
        aggregated[res["id"]] = res

    return [aggregated[k] for k in sorted(aggregated, key=lambda x: int(x[1:]))]


# --- CACHE + POLLER ---
# Il polling Modbus gira in un thread di background: l'inverter viene letto ogni
# POLL_INTERVAL secondi e il risultato salvato in cache. Le richieste HTTP /data
# servono SOLO la cache → mai bloccanti, anche se l'inverter non risponde.
POLL_INTERVAL = 5  # secondi tra una lettura inverter e la successiva

_cache = {"payload": None, "ts": 0.0, "error": None}
_cache_lock = threading.Lock()


# =====================================================================
# STORICO PERSISTENTE
# =====================================================================
# Il vincolo che decide ogni scelta di questo modulo non è la CPU né la RAM: è
# il supporto. Il Raspberry scrive su una microSD, dove ogni write costa un ciclo
# di cancellazione di un blocco e i cicli sono finiti. Il poller gira ogni 5 s:
# appendere ad ogni poll significherebbe ~17.000 scritture al giorno, cioè il
# modo più rapido per trasformare un pannello a muro in una SD morta.
#
# Quindi la telemetria si stratifica in tre livelli, dal più caro al più duraturo:
#
#   1. anello in RAM  — 60 minuti a 5 s (720 punti). Zero scritture. Serve la
#      vista live e, soprattutto, è la sorgente da cui si media il minuto: un
#      punto al minuto preso "al volo" sarebbe un'istantanea rumorosa, la media
#      di 12 campioni è il valore che quel minuto ha davvero avuto.
#   2. CSV al minuto  — log/energy/YYYY-MM-DD.csv, UN SOLO append al minuto,
#      SENZA fsync. Il fsync è il punto chiave: forzare il flush a ogni riga
#      annullerebbe il buffering del kernel e riporterebbe il costo su ogni
#      singola scrittura. Il prezzo di non farlo è perdere fino a qualche
#      minuto di storico in caso di stacco brutale della corrente — che su un
#      grafico di consumi domestici è un danno accettabile, la SD bruciata no.
#      ~1440 righe/giorno ≈ 45 kB: rumore di fondo per il wear leveling.
#   3. daily.csv      — un rigo al giorno (~60 byte), scritto una volta alle
#      00:05. Si tiene per sempre: 365 righe l'anno sono 22 kB.
#
# I file al minuto si cancellano dopo `history.retention_days` giorni, MA solo
# dopo che il loro rollup è finito in daily.csv: il dettaglio si perde, il
# bilancio del giorno no. E ogni cancellazione viene loggata con nome e peso —
# nessun taglio silenzioso.
HISTORY_DIR = os.path.join(LOG_DIR, "energy")
HISTORY_DAILY_PATH = os.path.join(HISTORY_DIR, "daily.csv")

# Nome del file al minuto: SOLO questa forma. La regex non è cosmetica, è la
# difesa contro il path traversal (vedi _history_parse_day).
HISTORY_DAY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

HISTORY_MINUTE_HEADER = ["ts", "pv_w", "home_w", "grid_w", "batt_w", "soc", "pv_kwh_today"]
HISTORY_DAILY_HEADER = ["date", "pv_kwh", "home_kwh", "import_kwh", "export_kwh",
                        "charge_kwh", "discharge_kwh", "peak_pv_w", "min_soc"]

# `ts` è l'ora locale HH:MM, non un epoch: il giorno sta già nel nome del file,
# e l'asse x di ogni grafico è proprio il minuto locale. Un epoch costringerebbe
# chiunque apra il CSV a riconvertirlo per sapere a che ora è successo qualcosa,
# e triplicherebbe i byte della colonna. Caveat noto e accettato: nella notte in
# cui l'ora legale torna indietro, un'ora HH:MM compare due volte.
HISTORY_RING_SECONDS = 3600

# Per disegnare una giornata bastano ~288 punti (uno ogni 5 minuti): oltre, i
# segmenti sono più fitti dei pixel disponibili e si paga banda per nulla.
HISTORY_MAX_POINTS = 288
HISTORY_MAX_RANGE_DAYS = 366   # oltre, /history/range è una richiesta sbagliata

# Il rollup gira alle 00:05, non a mezzanotte netta: i contatori giornalieri
# dell'inverter si azzerano intorno alle 00:00 e cinque minuti di margine
# evitano di leggere un giorno a metà del suo reset.
HISTORY_ROLLUP_HOUR = 0
HISTORY_ROLLUP_MINUTE = 5
HISTORY_MAINTENANCE_TICK = 300  # ogni 5 minuti si guarda l'orologio, vedi loop

_hist_cfg = config.get("history")
if not isinstance(_hist_cfg, dict):
    _hist_cfg = {}
HISTORY_ENABLED = bool(_hist_cfg.get("enabled", True))
try:
    HISTORY_RETENTION_DAYS = int(_hist_cfg.get("retention_days", 90))
except (TypeError, ValueError):
    HISTORY_RETENTION_DAYS = 90
if HISTORY_RETENTION_DAYS < 1:
    # 0 o negativo cancellerebbe il file del giorno in corso mentre lo si scrive.
    HISTORY_RETENTION_DAYS = 1

# Stato condiviso. Due lock distinti e non uno solo: `_history_lock` protegge le
# strutture in memoria (anello + secchiello del minuto) e viene preso dal poller
# e dalle richieste HTTP; `_history_io_lock` protegge le scritture su file. Se
# fossero lo stesso lock, una SD lenta bloccherebbe una richiesta HTTP per tutta
# la durata della write.
_history_lock = threading.Lock()
_history_io_lock = threading.Lock()
_history_ring = deque(maxlen=max(1, HISTORY_RING_SECONDS // POLL_INTERVAL))
_history_bucket = {"key": None, "day": None, "minute": 0, "n": 0,
                   "pv": 0.0, "home": 0.0, "grid": 0.0, "batt": 0.0, "soc": 0.0,
                   "pv_kwh": None}
_history_stats = {"rows_written": 0, "write_errors": 0, "last_write": None,
                  "last_error": None}
_history_warn_ts = 0.0  # rate-limit dei warning di scrittura


def _history_day_path(day: date) -> str:
    """
    Path del file al minuto. `day` è SEMPRE un oggetto date già validato: il nome
    non si compone mai concatenando la stringa arrivata dall'utente.
    """
    return os.path.join(HISTORY_DIR, f"{day.isoformat()}.csv")


def _history_parse_day(raw: str) -> Optional[date]:
    """
    Valida una data presa dall'URL. Due controlli in fila, non uno:
      1. la regex impone esattamente 10 cifre e trattini — "..", "%2e%2e",
         "2026-08-09/../.." e qualunque separatore di path cadono qui;
      2. strptime impone che la data ESISTA davvero — 2026-13-99 supera la
         regex ma non il calendario.
    Il valore di ritorno è un `date`, non la stringa: da lì in poi il path si
    ricostruisce da zero e l'input dell'utente non tocca più il filesystem.
    """
    if not raw or not HISTORY_DAY_RE.match(raw):
        return None
    try:
        return datetime.strptime(raw, "%Y-%m-%d").date()
    except ValueError:
        return None


def _history_append_row(path: str, header: List[str], row: List) -> bool:
    """
    Un append e via: niente fsync (vedi il commento in testa alla sezione),
    niente riscrittura del file. L'header si scrive solo alla creazione.
    Ritorna False se il disco non collabora — e non solleva mai: una SD piena
    deve degradare lo storico, non fermare il poller (regola: la scrittura non
    fa mai fallire un poll).
    """
    global _history_warn_ts
    try:
        with _history_io_lock:
            os.makedirs(HISTORY_DIR, exist_ok=True)
            need_header = not os.path.exists(path)
            with open(path, "a", encoding="utf-8", newline="") as f:
                writer = csv.writer(f)
                if need_header:
                    writer.writerow(header)
                writer.writerow(row)
        _history_stats["rows_written"] += 1
        return True
    except OSError as exc:
        _history_stats["write_errors"] += 1
        _history_stats["last_error"] = str(exc)
        # Rate-limit: se la SD è in sola lettura il problema si ripresenta ogni
        # minuto, e un log che si riempie di righe identiche nasconde tutto il resto.
        now = time.time()
        if now - _history_warn_ts > 300:
            _history_warn_ts = now
            log(f"⚠️ Storico: scrittura su {os.path.basename(path)} fallita: {exc} "
                f"(i dati live continuano a essere serviti)")
        return False


def _history_bucket_reset(key, day: date, minute: int):
    b = _history_bucket
    b["key"] = key
    b["day"] = day
    b["minute"] = minute
    b["n"] = 0
    b["pv"] = b["home"] = b["grid"] = b["batt"] = b["soc"] = 0.0
    b["pv_kwh"] = None


def _history_bucket_row() -> Optional[Tuple[date, List]]:
    """Chiude il minuto in corso e ne restituisce la riga (media dei campioni)."""
    b = _history_bucket
    if not b["n"] or b["day"] is None:
        return None
    n = float(b["n"])
    hh, mm = divmod(int(b["minute"]), 60)
    row = [
        f"{hh:02d}:{mm:02d}",
        int(round(b["pv"] / n)),
        int(round(b["home"] / n)),
        int(round(b["grid"] / n)),
        int(round(b["batt"] / n)),
        int(round(b["soc"] / n)),
        # Contatore, non potenza: è monotono nel giorno, quindi si tiene
        # l'ultimo valore visto, non la media.
        "" if b["pv_kwh"] is None else round(b["pv_kwh"], 2),
    ]
    return b["day"], row


def history_record(payload: Dict):
    """
    Chiamata dal poller ad ogni lettura riuscita. Costo per poll: un append su
    un deque. La scrittura su disco avviene UNA volta al minuto, quando il
    minuto cambia — cioè si scrive il minuto appena concluso, mai quello in corso.
    """
    if not HISTORY_ENABLED:
        return
    derived = payload.get("derived") or {}
    energy_today = ((payload.get("energy") or {}).get("today") or {})

    now = time.time()
    lt = time.localtime(now)
    day = date(lt.tm_year, lt.tm_mon, lt.tm_mday)
    minute = lt.tm_hour * 60 + lt.tm_min
    key = (day, minute)

    point = {
        "ts": now,
        "t": round(minute + lt.tm_sec / 60.0, 3),
        "pv": _num(derived.get("solar_power_w")),
        "home": _num(derived.get("home_load_w")),
        "grid": _num(derived.get("grid_flow_w")),
        "batt": _num(derived.get("battery_power_w")),
        "soc": _num(derived.get("battery_percent")),
    }
    pv_kwh = energy_today.get("solar_kwh")
    if pv_kwh is None:
        pv_kwh = derived.get("daily_energy_kwh")

    pending = None
    with _history_lock:
        _history_ring.append(point)
        b = _history_bucket
        if b["key"] is not None and b["key"] != key:
            pending = _history_bucket_row()
        if b["key"] != key:
            _history_bucket_reset(key, day, minute)
        b["n"] += 1
        for field in ("pv", "home", "grid", "batt", "soc"):
            b[field] += point[field]
        if pv_kwh is not None:
            b["pv_kwh"] = float(pv_kwh)

    # L'I/O sta FUORI dal lock: chi legge l'anello non deve aspettare la SD.
    if pending is not None:
        pending_day, row = pending
        if _history_append_row(_history_day_path(pending_day), HISTORY_MINUTE_HEADER, row):
            _history_stats["last_write"] = f"{pending_day.isoformat()} {row[0]}"


# --- LETTURA ---

def _history_read_minutes(day: date) -> List[Dict]:
    """
    Legge un file al minuto. Le righe malformate si SALTANO invece di far
    fallire la richiesta: uno stacco di corrente a metà append lascia in coda
    una riga tronca, e un giorno intero di storico non deve sparire per gli
    ultimi 12 byte.
    """
    path = _history_day_path(day)
    out: List[Dict] = []
    try:
        with open(path, "r", encoding="utf-8", newline="") as f:
            for row in csv.reader(f):
                if not row or row[0] == "ts":
                    continue
                try:
                    hh, mm = row[0].split(":")
                    point = {
                        "t": int(hh) * 60 + int(mm),
                        "pv": float(row[1]),
                        "home": float(row[2]),
                        "grid": float(row[3]),
                        "batt": float(row[4]),
                        "soc": float(row[5]),
                    }
                    point["pv_kwh"] = float(row[6]) if len(row) > 6 and row[6] != "" else None
                except (ValueError, IndexError):
                    continue
                out.append(point)
    except FileNotFoundError:
        return []
    except OSError as exc:
        log(f"⚠️ Storico: lettura di {os.path.basename(path)} fallita: {exc}")
        return []

    # Un minuto, una riga. Il duplicato non è teorico: basta una seconda
    # istanza avviata a mano sulla stessa cartella (un `--port 8010` di prova
    # accanto al service) perché due processi appendano lo stesso minuto. Senza
    # questo collasso il grafico raddoppierebbe i punti e — molto peggio — il
    # rollup conterebbe due volte l'energia di quei minuti. Vince l'ultima
    # riga scritta, che è quella del processo che sta ancora girando.
    unici: Dict[int, Dict] = {}
    for point in out:
        unici[point["t"]] = point
    return [unici[t] for t in sorted(unici)]


def _history_downsample(points: List[Dict], max_points: int = HISTORY_MAX_POINTS) -> Tuple[List[Dict], int]:
    """
    Media a blocchi fino a scendere sotto `max_points`. Media e non
    decimazione: buttare via 4 punti su 5 farebbe sparire i picchi, mentre qui
    il picco resta dentro la media del blocco. Il fattore usato viene dichiarato
    nella risposta, così chi legge sa a che risoluzione sta guardando.
    """
    n = len(points)
    if n <= max_points:
        return points, 1
    factor = int(math.ceil(n / float(max_points)))
    out: List[Dict] = []
    for i in range(0, n, factor):
        chunk = points[i:i + factor]
        size = float(len(chunk))
        agg = {
            "t": round(sum(p["t"] for p in chunk) / size, 1),
            "pv": round(sum(p["pv"] for p in chunk) / size, 1),
            "home": round(sum(p["home"] for p in chunk) / size, 1),
            "grid": round(sum(p["grid"] for p in chunk) / size, 1),
            "batt": round(sum(p["batt"] for p in chunk) / size, 1),
            "soc": round(sum(p["soc"] for p in chunk) / size, 1),
        }
        # Il contatore non si media: è monotono, quindi del blocco vale
        # l'ultimo valore letto (il massimo).
        counters = [p["pv_kwh"] for p in chunk if p.get("pv_kwh") is not None]
        agg["pv_kwh"] = max(counters) if counters else None
        out.append(agg)
    return out, factor


def _history_read_daily() -> Dict[str, Dict]:
    """daily.csv → {'YYYY-MM-DD': {colonna: valore}}. Righe rotte: saltate."""
    out: Dict[str, Dict] = {}
    try:
        with open(HISTORY_DAILY_PATH, "r", encoding="utf-8", newline="") as f:
            for row in csv.reader(f):
                if not row or row[0] == "date" or not HISTORY_DAY_RE.match(row[0]):
                    continue
                entry = {"date": row[0]}
                for idx, name in enumerate(HISTORY_DAILY_HEADER[1:], start=1):
                    try:
                        entry[name] = float(row[idx])
                    except (ValueError, IndexError):
                        entry[name] = None
                out[row[0]] = entry
    except FileNotFoundError:
        return {}
    except OSError as exc:
        log(f"⚠️ Storico: lettura di daily.csv fallita: {exc}")
        return {}
    return out


# --- ROLLUP E RETENTION ---

def history_rollup_day(day: date, force: bool = False) -> Optional[Dict]:
    """
    Comprime un giorno di righe al minuto in una riga di daily.csv.

    L'integrazione è una somma semplice perché ogni riga È GIÀ la media del suo
    minuto: energia = media_W × (1/60) h. I minuti mancanti (Raspberry spento,
    inverter irraggiungibile) semplicemente non contribuiscono — non si
    interpola sopra un buco, perché l'energia consumata mentre il sistema era
    spento non la sa nessuno e inventarla renderebbe il bilancio una bugia
    plausibile.

    pv_kwh fa eccezione: è il contatore dell'inverter, quindi si prende il suo
    valore massimo del giorno (esatto) e si ripiega sull'integrazione solo se
    la colonna manca.
    """
    rows = _history_read_minutes(day)
    if not rows:
        return None

    existing = _history_read_daily()
    key = day.isoformat()
    if key in existing and not force:
        return existing[key]

    home_wh = imp_wh = exp_wh = chg_wh = dis_wh = pv_wh = 0.0
    peak_pv = 0.0
    min_soc = None
    pv_counter = None
    for p in rows:
        pv_wh += p["pv"] / 60.0
        home_wh += p["home"] / 60.0
        if p["grid"] > 0:
            imp_wh += p["grid"] / 60.0
        else:
            exp_wh += -p["grid"] / 60.0
        if p["batt"] > 0:
            chg_wh += p["batt"] / 60.0
        else:
            dis_wh += -p["batt"] / 60.0
        if p["pv"] > peak_pv:
            peak_pv = p["pv"]
        if min_soc is None or p["soc"] < min_soc:
            min_soc = p["soc"]
        if p["pv_kwh"] is not None and (pv_counter is None or p["pv_kwh"] > pv_counter):
            pv_counter = p["pv_kwh"]

    entry = {
        "date": key,
        "pv_kwh": round(pv_counter if pv_counter is not None else pv_wh / 1000.0, 2),
        "home_kwh": round(home_wh / 1000.0, 2),
        "import_kwh": round(imp_wh / 1000.0, 2),
        "export_kwh": round(exp_wh / 1000.0, 2),
        "charge_kwh": round(chg_wh / 1000.0, 2),
        "discharge_kwh": round(dis_wh / 1000.0, 2),
        # Picco sulle medie al minuto: il picco istantaneo vero è più alto, e
        # dichiararlo come tale sarebbe scorretto. Qui è "il minuto più forte".
        "peak_pv_w": int(round(peak_pv)),
        "min_soc": int(round(min_soc)) if min_soc is not None else 0,
    }

    if key in existing and force:
        # Riscrittura completa: daily.csv è di poche decine di kB, riscriverlo
        # una volta ogni tanto non è un problema di usura come lo sarebbe farlo
        # ad ogni minuto. Il caso normale resta l'append puro.
        existing[key] = entry
        _history_rewrite_daily(existing)
    else:
        _history_append_row(HISTORY_DAILY_PATH, HISTORY_DAILY_HEADER,
                            [entry[c] for c in HISTORY_DAILY_HEADER])

    log(f"📒 Rollup {key}: pv {entry['pv_kwh']}kWh · casa {entry['home_kwh']}kWh · "
        f"import {entry['import_kwh']}kWh · export {entry['export_kwh']}kWh · "
        f"carica {entry['charge_kwh']}kWh · scarica {entry['discharge_kwh']}kWh "
        f"(da {len(rows)}/1440 minuti coperti)")
    return entry


def _history_rewrite_daily(entries: Dict[str, Dict]):
    """Riscrive daily.csv ordinato per data. Scrittura atomica via file temporaneo."""
    tmp = HISTORY_DAILY_PATH + ".tmp"
    try:
        with _history_io_lock:
            os.makedirs(HISTORY_DIR, exist_ok=True)
            with open(tmp, "w", encoding="utf-8", newline="") as f:
                writer = csv.writer(f)
                writer.writerow(HISTORY_DAILY_HEADER)
                for key in sorted(entries):
                    e = entries[key]
                    writer.writerow([e.get(c, "") for c in HISTORY_DAILY_HEADER])
            os.replace(tmp, HISTORY_DAILY_PATH)
    except OSError as exc:
        _history_stats["write_errors"] += 1
        log(f"⚠️ Storico: riscrittura di daily.csv fallita: {exc}")


def _history_minute_files() -> List[Tuple[date, str]]:
    """Elenco dei file al minuto presenti, ordinato. Ignora tutto ciò che non
    ha esattamente la forma YYYY-MM-DD.csv (daily.csv compreso)."""
    out: List[Tuple[date, str]] = []
    try:
        names = os.listdir(HISTORY_DIR)
    except OSError:
        return out
    for name in names:
        if not name.endswith(".csv"):
            continue
        day = _history_parse_day(name[:-4])
        if day is not None:
            out.append((day, name))
    out.sort()
    return out


def history_catchup(today: Optional[date] = None) -> List[str]:
    """
    Rollup di tutti i giorni chiusi che non hanno ancora una riga in daily.csv.

    Non è una comodità: senza, basta che il Raspberry sia spento alle 00:05
    (blackout, manutenzione, kiosk staccato) perché quel giorno non venga mai
    consolidato e sparisca alla prima retention. Con il catch-up, il rollup
    mancato si recupera al primo avvio successivo.
    """
    today = today or date.today()
    done: List[str] = []
    existing = _history_read_daily()
    for day, _name in _history_minute_files():
        if day >= today or day.isoformat() in existing:
            continue
        if history_rollup_day(day) is not None:
            done.append(day.isoformat())
    return done


def history_retention(today: Optional[date] = None) -> List[str]:
    """
    Cancella i file al minuto più vecchi di `retention_days`.

    Due garanzie, in quest'ordine:
      1. non si cancella nulla che non sia già in daily.csv — se il rollup
         manca lo si fa adesso, e se non riesce il file resta dov'è;
      2. ogni cancellazione finisce nel log con nome e peso. Un taglio
         silenzioso è indistinguibile da una perdita di dati.
    """
    today = today or date.today()
    cutoff = today - timedelta(days=HISTORY_RETENTION_DAYS)
    removed: List[str] = []
    existing = _history_read_daily()
    for day, name in _history_minute_files():
        if day >= cutoff:
            continue
        if day.isoformat() not in existing:
            if history_rollup_day(day) is None:
                log(f"⚠️ Storico: {name} è scaduto ma il rollup non è riuscito — non lo cancello")
                continue
            existing[day.isoformat()] = {}
        path = _history_day_path(day)
        try:
            size = os.path.getsize(path)
            os.remove(path)
        except OSError as exc:
            log(f"⚠️ Storico: cancellazione di {name} fallita: {exc}")
            continue
        removed.append(name)
        log(f"🧹 Storico: cancellato {name} ({size} byte, più vecchio di "
            f"{HISTORY_RETENTION_DAYS} giorni · il rollup resta in daily.csv)")
    if not removed:
        log(f"🧹 Storico: nessun file al minuto oltre i {HISTORY_RETENTION_DAYS} giorni "
            f"(taglio al {cutoff.isoformat()})")
    return removed


def history_maintenance(today: Optional[date] = None) -> Dict:
    """Un giro completo: rollup dei giorni chiusi + retention. Idempotente."""
    if not HISTORY_ENABLED:
        return {"enabled": False, "rolled": [], "removed": []}
    rolled = history_catchup(today)
    removed = history_retention(today)
    return {"enabled": True, "rolled": rolled, "removed": removed}


def history_maintenance_loop():
    """
    Thread di manutenzione. Non calcola "quanti secondi mancano alle 00:05" e
    poi dorme: il Raspberry non ha un RTC, quindi all'avvio l'orologio può
    essere sbagliato di ore finché NTP non lo corregge, e una sleep lunga
    calcolata su un'ora falsa manderebbe il rollup a un orario a caso. Si
    guarda l'orologio ogni 5 minuti e si decide sul momento — costa nulla ed è
    immune ai salti di orologio.
    """
    log(f"📚 Storico attivo · dettaglio al minuto in log/energy/ · "
        f"retention {HISTORY_RETENTION_DAYS} giorni · rollup alle "
        f"{HISTORY_ROLLUP_HOUR:02d}:{HISTORY_ROLLUP_MINUTE:02d}")
    # Giro d'avvio: recupera i rollup saltati mentre il servizio era fermo.
    try:
        history_maintenance()
    except Exception as exc:
        log(f"⚠️ Storico: manutenzione d'avvio fallita: {exc}")
    last_run = date.today()
    while True:
        time.sleep(HISTORY_MAINTENANCE_TICK)
        try:
            now = datetime.now()
            past_rollup = (now.hour, now.minute) >= (HISTORY_ROLLUP_HOUR, HISTORY_ROLLUP_MINUTE)
            if now.date() != last_run and past_rollup:
                last_run = now.date()
                history_maintenance(now.date())
        except Exception as exc:
            log(f"⚠️ Storico: manutenzione fallita: {exc}")


# --- PAYLOAD PER GLI ENDPOINT ---

def history_day_payload(day: date) -> Tuple[Dict, int]:
    """
    Punti al minuto di un giorno. `day` arriva già validato da _history_parse_day.
    """
    if not HISTORY_ENABLED:
        return {"error": "storico disabilitato (config.json history.enabled=false)"}, 404

    today = date.today()
    exists = os.path.exists(_history_day_path(day))
    if not exists and day != today:
        # Giorno senza file: 404 con un corpo che dice quale giorno, non un 500
        # e nemmeno una curva piatta a zero (che sarebbe un dato inventato).
        return {"error": "nessun dato per questo giorno", "date": day.isoformat()}, 404

    points = _history_read_minutes(day) if exists else []
    samples, factor = _history_downsample(points)
    payload = {
        "date": day.isoformat(),
        "count": len(samples),
        "raw_count": len(points),
        # Il fattore è dichiarato: chi legge sa se sta guardando il minuto vero
        # o una media a 5 minuti.
        "downsample_factor": factor,
        "resolution_s": 60 * factor,
        "retention_days": HISTORY_RETENTION_DAYS,
        "samples": samples,
    }
    if not points:
        payload["note"] = ("giornata in corso: nessun minuto ancora consolidato"
                           if day == today else "nessun campione")
    return payload, 200


def history_range_payload(day_from: date, day_to: date) -> Tuple[Dict, int]:
    """Aggregati giornalieri da daily.csv, estremi inclusi."""
    if not HISTORY_ENABLED:
        return {"error": "storico disabilitato (config.json history.enabled=false)"}, 404
    if day_from > day_to:
        return {"error": "intervallo invertito: la data iniziale è dopo la finale"}, 400
    span = (day_to - day_from).days + 1
    if span > HISTORY_MAX_RANGE_DAYS:
        return {"error": f"intervallo troppo ampio ({span} giorni, massimo "
                         f"{HISTORY_MAX_RANGE_DAYS})"}, 400

    entries = _history_read_daily()
    days = []
    for key in sorted(entries):
        parsed = _history_parse_day(key)
        # `parsed` può essere None se in daily.csv è finita una data che supera
        # la regex ma non il calendario (2026-13-99): si salta invece di
        # confrontarla e far esplodere la richiesta con un 500.
        if parsed is not None and day_from <= parsed <= day_to:
            days.append(entries[key])
    payload = {
        "from": day_from.isoformat(),
        "to": day_to.isoformat(),
        "count": len(days),
        "days": days,
    }
    if not days:
        # Vuoto onesto: 200 con zero giorni è una risposta legittima a "cosa
        # hai fra queste due date". Il 404 è per la risorsa che non c'è.
        payload["note"] = "nessun giorno consolidato in questo intervallo"
    return payload, 200


def history_live_payload() -> Tuple[Dict, int]:
    """Anello in RAM: ultimi 60 minuti a risoluzione di poll. Zero I/O."""
    if not HISTORY_ENABLED:
        return {"error": "storico disabilitato (config.json history.enabled=false)"}, 404
    with _history_lock:
        points = [{k: p[k] for k in ("t", "pv", "home", "grid", "batt", "soc")}
                  for p in _history_ring]
    return {
        "window_s": HISTORY_RING_SECONDS,
        "resolution_s": POLL_INTERVAL,
        "count": len(points),
        "samples": points,
    }, 200


def history_health() -> Dict:
    """Riassunto per /health: dice se lo storico sta davvero scrivendo."""
    with _history_lock:
        buffered = len(_history_ring)
    return {
        "enabled": HISTORY_ENABLED,
        "retention_days": HISTORY_RETENTION_DAYS,
        "ring_points": buffered,
        "rows_written": _history_stats["rows_written"],
        "write_errors": _history_stats["write_errors"],
        "last_write": _history_stats["last_write"],
    }


def poll_loop(debug: bool = False):
    """Loop infinito: legge l'inverter e aggiorna la cache. Gira come daemon thread."""
    global _device_info_stale
    log(f"🔄 Poller avviato (intervallo {POLL_INTERVAL}s, blocchi {REG_BLOCKS})")
    consecutive_fails = 0
    last_discovery = 0.0
    while True:
        t0 = time.time()
        try:
            regs, source, blocks_failed = read_registers()
            payload = build_payload(regs, source, blocks_failed)
            elapsed_ms = (time.time() - t0) * 1000
            with _cache_lock:
                _cache["payload"] = payload
                _cache["ts"] = time.time()
                _cache["error"] = None
            consecutive_fails = 0
            # Storico: costa un append in RAM per poll, una riga su disco al
            # minuto. try/except suo: un guasto nello storico NON deve contare
            # come poll fallito, o dopo tre minuti farebbe partire l'auto-discovery
            # dell'inverter per un problema che sta sul disco.
            try:
                history_record(payload)
            except Exception as exc:
                log(f"⚠️ Storico: registrazione del campione fallita: {exc}")
            d = payload["derived"]
            v = payload["meta"]["validation"]
            # Log conciso + timing (regola #7: timing su operazioni pesanti)
            log(
                f"✅ Poll {elapsed_ms:.0f}ms src={source} "
                f"home={d['home_load_w']:.0f}W solar={d['solar_power_w']:.0f}W "
                f"grid={d['grid_flow_w']:.0f}W batt={d['battery_power_w']:.0f}W/{d['battery_percent']:.0f}% "
                f"today={d['daily_energy_kwh']:.1f}kWh"
                + (f" ⚠️ invarianti KO: {','.join(v['invariants_failed'])}" if v["invariants_failed"] else "")
            )
            if debug:
                _print_debug_regs(regs)
        except MappingError as exc:
            # Senza mappa non si inventa nulla: si smette di aggiornare la cache e
            # lo si dice. Un fallback silenzioso qui è il difetto che ha prodotto
            # la mappa v1 (JSON e default nel codice divergenti).
            consecutive_fails += 1
            with _cache_lock:
                _cache["error"] = f"mappa registri non valida: {exc}"
            log(f"❌ {exc}")
        except Exception as exc:
            elapsed_ms = (time.time() - t0) * 1000
            consecutive_fails += 1
            _device_info_stale = True  # alla prossima connessione rileggi l'identificazione
            with _cache_lock:
                _cache["error"] = str(exc)
            log(f"⚠️ Poll error dopo {elapsed_ms:.0f}ms (fail #{consecutive_fails}): {exc}")
            # Auto-discovery: l'inverter potrebbe aver cambiato IP (DHCP).
            if (
                consecutive_fails >= DISCOVERY_FAIL_THRESHOLD
                and time.time() - last_discovery >= DISCOVERY_MIN_INTERVAL
            ):
                last_discovery = time.time()
                if discover_inverter():
                    consecutive_fails = 0
                    continue  # riprova subito col nuovo IP, senza aspettare POLL_INTERVAL
        time.sleep(POLL_INTERVAL)


def _print_debug_regs(regs: List[int]):
    """Dump verboso dei registri non-zero con mapping (solo se --debug)."""
    print("\n--- DEBUG READ ---")
    mapping = load_mapping()
    inv_map = {}
    for name, conf in mapping["fields"].items():
        inv_map.setdefault(conf["reg"], []).append(
            (name, conf.get("scale", 1), conf.get("unit", ""), conf.get("confidence", "?"))
        )
    for i, val in enumerate(regs):
        if val == 0:
            continue
        signed_val = signed16(val)
        extra = ""
        for name, scale, unit, conf in inv_map.get(i, []):
            extra += f"  -> {name}: {signed_val * scale:g}{unit} [{conf}]"
        print(f"Reg {i}: {val}" + (f" ({signed_val})" if val > 32767 else "") + extra)
    print("------------------\n")


# --- SERVING STATICO: ALLOW-LIST ESPLICITA ---
# Prima si serviva QUALSIASI file esistente nella CWD (`os.path.exists(clean_path)`):
# erano scaricabili senza credenziali config.json (coordinate GPS di casa + IP
# dell'inverter), .git/config, frontend.log e registers.json. Il controllo su ".."
# non c'entra nulla — il problema non era il traversal, era che la regola di default
# fosse "consenti". Ora la regola di default è "nega": esiste solo questa lista,
# le chiavi sono nomi letterali (nessuna concatenazione di input utente nel path),
# tutto il resto è 404.
STATIC_FILES = {
    "index.html": "text/html; charset=utf-8",
    "logger.js": "application/javascript; charset=utf-8",
    "logo.png": "image/png",
    # Icone e manifest del go-live (regola #16.1): i browser le chiedono a path
    # fissi della root, quindi devono stare in lista o darebbero 404.
    "favicon.ico": "image/x-icon",
    "favicon.svg": "image/svg+xml",
    "apple-touch-icon.png": "image/png",
    "icon-192.png": "image/png",
    "icon-512.png": "image/png",
    "site.webmanifest": "application/manifest+json",
    # Font Sora self-hosted (variable font, copre tutti i pesi in un file):
    # serve a togliere la dipendenza da Google Fonts e quindi i CDN dalla CSP.
    # Elencato esplicitamente di proposito — una regola a prefisso su "static/"
    # riaprirebbe la porta al traversal che l'allow-list chiude per costruzione.
    "static/fonts/sora-latin-var.woff2": "font/woff2",
    # NB: assets/branding/ NON è in lista ed è giusto così — è materiale sorgente
    # del repo (logo.svg, PNG master), non roba che la dashboard debba scaricare.
}

# --- static/: cartella servita per intero, ma per COSTRUZIONE ---
# L'allow-list a chiavi letterali va benissimo per i file di root, che sono pochi e
# stabili; per la cartella static/ no: ogni foglio di stile o modulo aggiunto dal
# frontend richiederebbe una riga qui, e finché non c'è la pagina arriva senza CSS
# (successo davvero: 10 file su 10 a 404 mentre la dashboard sembrava rotta).
# La regola di default resta però "nega", perché il difetto originale non era il
# path traversal ma il fatto che si servisse qualsiasi file esistente nella CWD:
#   1. il path deve iniziare per "static/";
#   2. l'estensione deve essere in STATIC_MIME (niente .py, .json di config, .env,
#      niente file senza estensione, quindi nemmeno .DS_Store);
#   3. il realpath deve cadere DENTRO static/ — confronto col separatore in coda,
#      così "static-altro/" non passa per prefisso;
#   4. deve essere un file regolare: le directory non si servono e non si listano.
# `config.json`, `.env`, `.git/`, `invert.py` e `registers.json` restano 404 perché
# non soddisfano né la 1 né la 3.
STATIC_DIR = os.path.join(BASE_DIR, "static")
STATIC_MIME = {
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".woff2": "font/woff2",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".webp": "image/webp",
    ".json": "application/json",
    ".ico": "image/x-icon",
    ".map": "application/json",
}


def resolve_static(rel_path: str) -> Optional[Tuple[str, str]]:
    """Ritorna (path_assoluto, mime) se `rel_path` è servibile da static/, altrimenti None."""
    if not rel_path.startswith("static/") or "\x00" in rel_path or "\\" in rel_path:
        return None
    mime = STATIC_MIME.get(os.path.splitext(rel_path)[1].lower())
    if not mime:
        return None
    root = os.path.realpath(STATIC_DIR)
    candidate = os.path.realpath(os.path.join(BASE_DIR, rel_path))
    if not candidate.startswith(root + os.sep):
        return None
    if not os.path.isfile(candidate):
        return None
    return candidate, mime

# CSP stretta: la dashboard non carica più NULLA da fuori.
# Il TODO della versione precedente è chiuso — il frontend è stato riscritto e ora:
#   font    → static/fonts/sora-latin-var.woff2 self-hostato (niente fonts.gstatic.com)
#   3D      → three.js rimossa (niente unpkg.com, che era il rischio peggiore: un
#             compromesso del CDN avrebbe iniettato script nel pannello di casa)
#   meteo   → /api/weather, proxy server-side (niente api.open-meteo.com dal browser,
#             ed è anche ciò che tiene le coordinate di casa fuori dal browser)
#   inline  → zero script e style inline; gli stili a runtime passano dal CSSOM,
#             che la CSP non governa, quindi cade anche 'unsafe-inline'.
# Verificata sui 4 viewport in entrambi i temi: zero violazioni in console.
CSP = "; ".join([
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "font-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'self'",
    "form-action 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
])

# Cap rigido sul body di POST /log. Prima `self.rfile.read(length)` allocava in RAM
# quanto DICHIARAVA il client: su un Pi con 1 GB di RAM bastava un Content-Length
# generoso per farlo sudare, e la write finiva su SD card senza alcun limite.
MAX_LOG_BODY = 4096


def _ui_config() -> Dict:
    """
    Config per l'interfaccia: SOLO i parametri di dimensionamento che servono a
    disegnare le barre. Niente `location` — l'endpoint /config precedente mandava
    latitudine e longitudine di casa dentro il browser perché la pagina chiamava
    open-meteo da sé; ora il meteo lo prende /api/weather lato server e le
    coordinate non lasciano più il Raspberry (regola #16.8). Niente `inverter`.
    """
    battery = config.get("battery", {})
    solar = config.get("solar", {})
    server = config.get("server", {})
    return {
        "battery": {
            "capacity_kwh": battery.get("capacity_kwh"),
            "min_soc": battery.get("min_soc"),
        },
        "solar": {"capacity_kwp": solar.get("capacity_kwp")},
        "server": {"poll_interval_s": server.get("poll_interval_s", POLL_INTERVAL)},
    }


# --- METEO: PROXY SERVER-SIDE (cache 15 minuti) ---
# Il browser non parla più con open-meteo: chiama /api/weather e il Raspberry fa
# la richiesta con le coordinate di config.json. Due motivi, in quest'ordine:
# le coordinate di casa non finiscono in una richiesta uscente dal browser (e
# quindi nella cronologia, nei log del kiosk, in un eventuale proxy), e il pannello
# a muro non dipende più dalla connettività del browser verso un terzo host.
WEATHER_URL = "https://api.open-meteo.com/v1/forecast"
WEATHER_TTL = 15 * 60
WEATHER_TIMEOUT = 8
_weather_cache = {"payload": None, "ts": 0.0, "error": None}
_weather_lock = threading.Lock()


def _weather_fetch() -> Dict:
    loc = config.get("location", {})
    lat, lon = loc.get("latitude"), loc.get("longitude")
    if lat is None or lon is None:
        raise ValueError("coordinate assenti in config.json")
    params = urllib.parse.urlencode({
        "latitude": lat,
        "longitude": lon,
        "timezone": loc.get("timezone", "auto"),
        "current": "temperature_2m,weather_code,is_day",
        "hourly": "temperature_2m,weather_code,shortwave_radiation",
        "daily": "weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset",
        "forecast_days": 2,
    })
    req = urllib.request.Request(f"{WEATHER_URL}?{params}", headers={"User-Agent": "EnergyFlow"})
    with urllib.request.urlopen(req, timeout=WEATHER_TIMEOUT) as resp:
        data = json.loads(resp.read().decode("utf-8"))

    current = data.get("current", {})
    daily = data.get("daily", {})
    hourly = data.get("hourly", {})

    def _first(key, default=None):
        seq = daily.get(key) or []
        return seq[0] if seq else default

    sunrise, sunset = _first("sunrise"), _first("sunset")
    # Finestra fotovoltaica: dall'alba al tramonto, con un'ora di margine per
    # lato — è l'intervallo in cui shortwave_radiation dice qualcosa di utile.
    window = []
    times = hourly.get("time") or []
    for i, stamp in enumerate(times):
        if sunrise and sunset and not (sunrise[:13] <= stamp[:13] <= sunset[:13]):
            continue
        window.append({
            "time": stamp,
            "temperature_c": (hourly.get("temperature_2m") or [None] * len(times))[i],
            "weather_code": (hourly.get("weather_code") or [None] * len(times))[i],
            "shortwave_radiation_wm2": (hourly.get("shortwave_radiation") or [None] * len(times))[i],
        })

    return {
        "current": {
            "temperature_c": current.get("temperature_2m"),
            "weather_code": current.get("weather_code"),
            "is_day": bool(current.get("is_day")),
            "time": current.get("time"),
        },
        "today": {
            "sunrise": sunrise,
            "sunset": sunset,
            "weather_code": _first("weather_code"),
            "temp_max_c": _first("temperature_2m_max"),
            "temp_min_c": _first("temperature_2m_min"),
        },
        "solar_window": window,
        "meta": {"source": "open-meteo", "timezone": data.get("timezone")},
    }


def weather_payload() -> Tuple[Dict, int]:
    """
    Ritorna (payload, http_code). Se open-meteo non risponde si serve l'ultima
    risposta buona marcata `stale`: una previsione di un'ora fa vale più di un
    buco nell'interfaccia.
    """
    now = time.time()
    with _weather_lock:
        cached = _weather_cache["payload"]
        age = now - _weather_cache["ts"]
        if cached is not None and age < WEATHER_TTL:
            out = dict(cached)
            out["meta"] = dict(cached["meta"], age_s=round(age, 1), stale=False, cached=True)
            return out, 200

    try:
        fresh = _weather_fetch()
    except Exception as exc:
        log(f"⚠️ Meteo non aggiornato ({exc})")
        with _weather_lock:
            cached = _weather_cache["payload"]
            age = now - _weather_cache["ts"]
            _weather_cache["error"] = str(exc)
        if cached is None:
            return {"error": "meteo non disponibile", "detail": str(exc)}, 503
        out = dict(cached)
        out["meta"] = dict(cached["meta"], age_s=round(age, 1), stale=True,
                           cached=True, error=str(exc))
        return out, 200

    with _weather_lock:
        _weather_cache["payload"] = fresh
        _weather_cache["ts"] = time.time()
        _weather_cache["error"] = None
    out = dict(fresh)
    out["meta"] = dict(fresh["meta"], age_s=0.0, stale=False, cached=False)
    return out, 200


def _parse_client_log(raw: str) -> Tuple[str, str]:
    """
    logger.js manda JSON {level, msg, url}; il vecchio formato era testo semplice.
    Si accettano entrambi per non rompere una pagina non ancora ricaricata.
    """
    raw = raw.strip()
    if raw.startswith("{"):
        try:
            obj = json.loads(raw)
            # Il livello finisce dentro le parentesi quadre del prefisso: va ridotto
            # ad alfanumerico, altrimenti il client può forgiare il prefisso stesso.
            level = "".join(c for c in str(obj.get("level", "log")) if c.isalnum())[:8].upper()
            msg = str(obj.get("msg", ""))
            url = obj.get("url")
            if url:
                msg = f"{msg} @ {url}"
            return (level or "LOG"), msg
        except (ValueError, TypeError):
            pass
    return "LOG", raw


def health_payload() -> Tuple[Dict, int]:
    """
    /health come sonda vera: non dice solo «il processo è vivo», dice se l'ultima
    lettura è fresca, se qualche campo è fuori dal dominio fisico e quali
    invarianti stanno fallendo. 200 se ok, 503 se degraded — così un monitoring
    esterno se ne accorge senza leggere il payload.
    """
    with _cache_lock:
        ts = _cache["ts"]
        payload = _cache["payload"]
        err = _cache["error"]

    poller_ok = payload is not None and (time.time() - ts) < POLL_INTERVAL * 3
    warnings: List[str] = []   # fanno scattare degraded
    notes: List[str] = []      # informativi, non fanno scattare nulla
    invariants_failed: List[str] = []
    map_version = "?"

    if payload is not None:
        meta = payload.get("meta", {})
        map_version = meta.get("map_version", "?")
        validation = meta.get("validation", {})
        # Per lo STATO conta il fallimento persistente (vedi _update_strikes): un
        # singolo campione fuori banda non deve far lampeggiare rosso il pannello.
        # Quello transitorio si vede lo stesso, ma fra le note.
        invariants_failed = list(validation.get("invariants_failed_persistent", []))
        transient = [i for i in validation.get("invariants_failed", []) if i not in invariants_failed]
        if transient:
            notes.append(f"invarianti fuori banda su un solo poll: {', '.join(transient)}")
        warnings.extend(validation.get("warnings", []))
        suspects = [k for k, v in payload.get("quality", {}).items() if v == "suspect"]
        if suspects:
            warnings.append(f"campi suspect: {', '.join(sorted(suspects))}")
    if not poller_ok:
        warnings.append("poller fermo o dati stantii")
    if err:
        warnings.append(f"ultimo errore: {err}")

    ok = poller_ok and not warnings and not invariants_failed
    return {
        "status": "ok" if ok else "degraded",
        "version": APP_VERSION,
        "map_version": map_version,
        "uptime_s": round(time.time() - START_TIME, 1),
        "poller_ok": poller_ok,
        # Lo storico compare in /health perché un pannello che scrive su una SD
        # può smettere di scrivere senza che nulla si veda a schermo: i grafici
        # live continuano, e ci si accorge del buco solo il giorno dopo.
        "history": history_health(),
        "warnings": warnings,
        "notes": notes,
        "invariants_failed": invariants_failed,
    }, (200 if ok else 503)


def make_handler():
    class Handler(BaseHTTPRequestHandler):
        server_version = "EnergyFlow"
        sys_version = ""  # non pubblicare la versione di Python nell'header Server

        # --- helper comuni ---
        def _security_headers(self):
            """Header di sicurezza su OGNI risposta, compresi errori e 404."""
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("X-Frame-Options", "DENY")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Content-Security-Policy", CSP)

        def _authorized(self) -> bool:
            """
            Token accettato sia come `Authorization: Bearer <t>` (widget/CLI) sia come
            cookie (dashboard nel browser, che non può settare header da sola).
            Confronto con hmac.compare_digest: a tempo costante, così la latenza non
            racconta quanti caratteri iniziali sono giusti.
            """
            supplied = ""
            auth = self.headers.get("Authorization", "")
            if auth.startswith("Bearer "):
                supplied = auth[len("Bearer "):].strip()
            if not supplied:
                raw_cookie = self.headers.get("Cookie", "")
                if raw_cookie:
                    try:
                        jar = SimpleCookie()
                        jar.load(raw_cookie)
                        if COOKIE_NAME in jar:
                            supplied = jar[COOKIE_NAME].value
                    except Exception:
                        supplied = ""
            if not supplied or not AUTH_TOKEN:
                return False
            # encode: compare_digest rifiuta str non-ASCII, e l'header è input utente.
            return hmac.compare_digest(
                supplied.encode("utf-8", "replace"), AUTH_TOKEN.encode("utf-8")
            )

        def _deny(self):
            # Ogni 401 va loggato con IP e path (regola #17): è così che si vedono
            # gli scan prima che diventino un problema.
            log(f"🚫 401 {self.command} {self.path} da {self.client_address[0]}")
            self._send_error_json(401, "unauthorized")

        def _send_error_json(self, code: int, reason: str):
            """
            Risposta d'errore che NON legge il body della richiesta. Serve
            `Connection: close`: lasciare byte non letti nel socket corromperebbe
            la richiesta successiva sulla stessa connessione keep-alive.
            """
            body = json.dumps({"error": reason}).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Connection", "close")
            self._security_headers()
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            if self.path.split("?")[0] != "/log":
                return self._send_error_json(404, "not found")

            # Auth PRIMA di leggere il body: una write anonima e illimitata su una
            # SD card è un modo gratuito per riempire il disco del Raspberry.
            if not self._authorized():
                return self._deny()

            try:
                length = int(self.headers.get("Content-Length", 0))
            except (TypeError, ValueError):
                # Prima un Content-Length non numerico faceva esplodere int() e
                # abortiva il thread con un traceback in journald.
                return self._send_error_json(400, "content-length non valido")
            if length < 0:
                return self._send_error_json(400, "content-length negativo")
            if length > MAX_LOG_BODY:
                return self._send_error_json(413, f"body oltre {MAX_LOG_BODY} byte")

            # errors='replace': un byte non-UTF8 non deve sollevare eccezioni.
            data = self.rfile.read(length).decode("utf-8", errors="replace")
            level, msg = _parse_client_log(data)
            # Escape dei newline: senza, chiunque poteva forgiare righe di log
            # arbitrarie nel file giornaliero (log injection) e falsificare eventi.
            msg = msg.replace("\\", "\\\\").replace("\r", "\\r").replace("\n", "\\n")
            log(f"[BROWSER:{level}] {msg}")

            self.send_response(204)
            self._security_headers()
            self.end_headers()

        def _send_json(self, payload, code=200, extra_headers=None):
            body = json.dumps(payload).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            # Niente Access-Control-Allow-Origin. Con '*' qualunque sito aperto in un
            # browser della LAN poteva leggere la telemetria di casa. La dashboard è
            # same-origin e non ne ha bisogno; i widget macOS sono client nativi
            # (URLSession/curl), non browser, quindi il CORS non li riguarda.
            self._security_headers()
            for key, val in (extra_headers or []):
                self.send_header(key, val)
            self.end_headers()
            self.wfile.write(body)

        def do_OPTIONS(self):
            self.send_response(204)
            self.send_header("Allow", "GET, POST, OPTIONS")
            self._security_headers()
            self.end_headers()

        def do_GET(self):
            path = self.path.split("?")[0]

            # /health: unico endpoint senza auth (whitelist regola #17).
            # Non espone l'IP dell'inverter: a un monitoring serve sapere SE il
            # poller gira e se i dati sono attendibili, non l'indirizzo di un
            # dispositivo sulla LAN di casa.
            if path == "/health":
                payload, code = health_payload()
                return self._send_json(payload, code=code)

            if path == "/api/ui-config":
                if not self._authorized():
                    return self._deny()
                return self._send_json(_ui_config())

            if path == "/api/weather":
                if not self._authorized():
                    return self._deny()
                payload, code = weather_payload()
                return self._send_json(payload, code=code)

            if path == "/data":
                if not self._authorized():
                    return self._deny()
                # Serve SOLO dalla cache popolata dal poller in background: mai bloccante.
                with _cache_lock:
                    payload = _cache["payload"]
                    err = _cache["error"]
                    ts = _cache["ts"]

                if payload is None:
                    # Nessuna lettura riuscita ancora (avvio o inverter offline da subito).
                    # Il messaggio non contiene l'indirizzo dell'inverter.
                    return self._send_json(
                        {"error": err or "no data yet (poller in avvio)"}, code=503
                    )

                age = time.time() - ts
                # Copia superficiale + meta freschezza; non muto la cache condivisa
                out = dict(payload)
                out["meta"] = dict(
                    payload["meta"],
                    age_s=round(age, 1),
                    stale=age > POLL_INTERVAL * 3,
                    last_error=err,
                )
                return self._send_json(out)

            # --- Storico (regola #4: il giorno sta nell'URL, non in un query
            # parameter, così un link porta esattamente al giorno che mostra) ---
            if path == "/history" or path.startswith("/history/"):
                if not self._authorized():
                    return self._deny()
                return self._history_route(path)

            # --- File statici: allow-list letterale in root + cartella static/ ---
            # unquote PRIMA dei controlli: un "%2e%2e" deve essere valutato per quello
            # che diventa, non per come è scritto. La difesa non è sulla stringa, è
            # sul realpath (vedi resolve_static).
            name = "index.html" if path in ("/", "/index.html") else urllib.parse.unquote(path.lstrip("/"))
            mime = STATIC_FILES.get(name)
            if mime is None:
                resolved = resolve_static(name)
                if resolved is None:
                    return self._send_error_json(404, "not found")
                return self._serve_path(resolved[0], resolved[1], name)

            extra = None
            if name == "index.html":
                # Il token arriva al browser qui: la dashboard è same-origin e da
                # sola non potrebbe mettere un header Authorization sulle sue fetch.
                # HttpOnly: non leggibile da JS, quindi né esfiltrabile da uno script
                # iniettato né stampabile per errore in console.
                # SameSite=Strict: un altro sito non può farsi accompagnare il cookie.
                # NIENTE Secure: il kiosk carica http://localhost:8003 in chiaro e con
                # Secure il cookie non verrebbe mai settato. Il traffico non lascia il
                # loopback (o passa dentro tailscale), quindi il compromesso regge.
                extra = [("Set-Cookie",
                          f"{COOKIE_NAME}={AUTH_TOKEN}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000")]
            return self._serve_file(name, mime, extra)

        def _history_route(self, path: str):
            """
            /history/day/YYYY-MM-DD
            /history/range/YYYY-MM-DD/YYYY-MM-DD
            /history/live

            I segmenti si unquotano PRIMA di validarli — "%2e%2e" va giudicato
            per quello che diventa, non per come è scritto — e poi passano da
            _history_parse_day, che restituisce un `date`. Il path del file si
            ricostruisce da quell'oggetto: la stringa dell'utente non arriva
            mai al filesystem, quindi il traversal non è "filtrato", è
            impossibile per costruzione.
            """
            parts = [urllib.parse.unquote(p) for p in path.split("/") if p]
            # parts[0] == "history"
            if len(parts) == 2 and parts[1] == "live":
                payload, code = history_live_payload()
                return self._send_json(payload, code=code)

            if len(parts) == 3 and parts[1] == "day":
                day = _history_parse_day(parts[2])
                if day is None:
                    return self._send_error_json(400, "data non valida (attesa YYYY-MM-DD)")
                payload, code = history_day_payload(day)
                return self._send_json(payload, code=code)

            if len(parts) == 4 and parts[1] == "range":
                day_from = _history_parse_day(parts[2])
                day_to = _history_parse_day(parts[3])
                if day_from is None or day_to is None:
                    return self._send_error_json(400, "data non valida (attesa YYYY-MM-DD)")
                payload, code = history_range_payload(day_from, day_to)
                return self._send_json(payload, code=code)

            return self._send_error_json(404, "not found")

        def _serve_file(self, name, mime, extra_headers=None):
            # `name` viene sempre da una chiave di STATIC_FILES, mai dal path grezzo:
            # non c'è concatenazione di input utente, quindi niente traversal possibile.
            return self._serve_path(os.path.join(BASE_DIR, name), mime, name, extra_headers)

        def _serve_path(self, full_path, mime, name, extra_headers=None):
            try:
                with open(full_path, 'rb') as f:
                    content = f.read()
            except FileNotFoundError:
                # In lista ma assente dal disco: è un 404, non un 500. Succede
                # quando l'allow-list e i file divergono (rename di un asset), e
                # rispondere "500 internal error" manderebbe a cercare un guasto
                # del server invece del file che manca.
                log(f"⚠️ 404: {name} è in STATIC_FILES ma non esiste su disco")
                return self._send_error_json(404, "not found")
            except OSError as e:
                log(f"⚠️ Errore servendo {name}: {e}")
                return self._send_error_json(500, "internal error")

            self.send_response(200)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(len(content)))
            # Disable Caching
            self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
            self.send_header("Pragma", "no-cache")
            self.send_header("Expires", "0")
            self._security_headers()
            for key, val in (extra_headers or []):
                self.send_header(key, val)
            self.end_headers()
            self.wfile.write(content)

        def log_message(self, format, *args):
            # Silenzia il logging HTTP standard.
            return

    return Handler


def resolve_port(cli_port: Optional[int]) -> int:
    """
    Unica fonte di verità per la porta (regola #6):
    --port esplicito → config.json server.port → DEFAULT_HTTP_PORT.
    Prima i valori divergenti erano tre (8000 nel default argparse, 8003 nel
    service/kiosk/README, e un server.port in config che nessuno leggeva).
    """
    if cli_port is not None:
        return cli_port
    try:
        return int(config["server"]["port"])
    except (KeyError, TypeError, ValueError):
        return DEFAULT_HTTP_PORT


def _port_occupant(port: int) -> str:
    """Chi tiene occupata la porta — best effort, per rendere l'errore azionabile."""
    for cmd in (["lsof", "-i", f"tcp:{port}", "-sTCP:LISTEN", "-P", "-n"],
                ["ss", "-lptn", f"sport = :{port}"]):
        try:
            res = subprocess.run(cmd, capture_output=True, text=True, timeout=5)
        except (OSError, subprocess.SubprocessError):
            continue  # tool non installato su questa macchina, provo il prossimo
        if res.returncode == 0 and res.stdout.strip():
            return res.stdout.strip()
    return ""


def serve(host: str, port: int, debug: bool = False):
    global AUTH_TOKEN
    AUTH_TOKEN = load_or_create_token()

    # La mappa si carica PRIMA di aprire la porta: se registers.json è rotto è
    # meglio non partire che servire numeri da una mappa non scelta da nessuno.
    mapping = load_mapping()
    log(f"🗺️  Mappa registri v{mapping['map_version']} · {mapping['device']}")

    # Avvia il poller Modbus in un daemon thread PRIMA di aprire il server HTTP.
    poller = threading.Thread(target=poll_loop, args=(debug,), daemon=True)
    poller.start()

    # Manutenzione dello storico (rollup + retention) in un thread suo: è I/O
    # su SD e non deve mai incastrarsi nel ciclo di poll, che ha una scadenza
    # ogni 5 secondi.
    if HISTORY_ENABLED:
        threading.Thread(target=history_maintenance_loop, daemon=True).start()
    else:
        log("📚 Storico disattivato da config.json (history.enabled=false): "
            "nessuna scrittura su disco, sezione Storico nascosta nella dashboard.")

    # Nessun auto-incremento della porta. Prima, se la 8003 era occupata, il server
    # saliva in silenzio a 8004: il kiosk punta a 8003 hardcoded, quindi il pannello
    # a muro restava bianco senza un solo segnale d'errore. Meglio non partire
    # affatto e dirlo forte (regola #6: la porta non si cambia in silenzio).
    try:
        server = ThreadingHTTPServer((host, port), make_handler())
    except OSError as exc:
        if exc.errno == errno.EADDRINUSE:
            log(f"❌ Porta {port} già occupata: il server NON parte.")
            occupant = _port_occupant(port)
            if occupant:
                log(f"   Occupata da:\n{occupant}")
            else:
                log("   (impossibile identificare il processo: né lsof né ss disponibili)")
            log("   Libera la porta oppure passa un --port esplicito.")
            sys.exit(1)
        raise

    url = f"http://{host}:{port}/" if host not in ("0.0.0.0", "::") else f"http://localhost:{port}/"

    log(f"🌐 Server attivo su {url}")
    log("   🔒 Auth attiva su /data, /api/* e /log (Bearer o cookie). "
        "/health e i file statici restano aperti.")
    if host == "0.0.0.0":
        log("   ⚠️  Bind su 0.0.0.0: la dashboard è raggiungibile da tutta la LAN.")

    # Auto-open browser
    try:
        import webbrowser
        webbrowser.open(url)
    except Exception:
        pass

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nChiusura server...")
    finally:
        server.server_close()


# =====================================================================
# CLI: --validate / --capture
# =====================================================================

def _load_ndjson(path: str) -> List[Dict]:
    """
    Legge un file NDJSON di campioni. Formati accettati:
      {"ts": float, "regs": {"10": 608, ...}}   (sparso, gli assenti valgono 0)
      {"ts": float, "regs": [ ... ]}            (denso)
      {"meta": {"timestamp":...}, "raw": {...}} (payload di /data salvato)
    """
    snapshots = []
    with open(path, "r", encoding="utf-8") as f:
        for line_no, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except ValueError:
                print(f"⚠️ riga {line_no} non è JSON, saltata")
                continue
            raw = obj.get("regs")
            if raw is None:
                raw = obj.get("raw")
            ts = obj.get("ts") or obj.get("meta", {}).get("timestamp")
            if raw is None or ts is None:
                continue
            if isinstance(raw, dict):
                regs = [0] * REG_SPAN
                for key, value in raw.items():
                    idx = int(key)
                    if 0 <= idx < REG_SPAN:
                        regs[idx] = value
            else:
                regs = list(raw) + [0] * max(0, REG_SPAN - len(raw))
            snapshots.append({"ts": float(ts), "regs": regs})
    return snapshots


def _sample_series(duration: float, interval: float, out_path: str = None) -> List[Dict]:
    """Campiona l'inverter per `duration` secondi. Chiude sempre il client fra un campione e l'altro."""
    snapshots = []
    handle = open(out_path, "a", encoding="utf-8") if out_path else None
    deadline = time.time() + duration
    try:
        while time.time() < deadline:
            t0 = time.time()
            try:
                regs, _, failed = read_registers()
                snap = {"ts": time.time(), "regs": regs}
                snapshots.append(snap)
                if handle:
                    sparse = {i: v for i, v in enumerate(regs) if v}
                    handle.write(json.dumps({"ts": snap["ts"], "regs": sparse}) + "\n")
                    handle.flush()
                print(f"  campione {len(snapshots)} ok"
                      + (f" (blocchi falliti: {failed})" if failed else ""))
            except Exception as exc:
                print(f"  ⚠️ campione fallito: {exc}")
                time.sleep(2)
            time.sleep(max(0.0, interval - (time.time() - t0)))
    except KeyboardInterrupt:
        print("  interrotto")
    finally:
        if handle:
            handle.close()
    return snapshots


ICONS = {"pass": "✅", "fail": "❌", "skip": "⏭️ "}


def run_validation(snapshots: List[Dict]) -> int:
    mapping = load_mapping()
    print("=" * 78)
    print(f"VALIDAZIONE · mappa v{mapping['map_version']} · {len(snapshots)} campioni")
    if snapshots:
        span_min = (max(s["ts"] for s in snapshots) - min(s["ts"] for s in snapshots)) / 60
        print(f"finestra {span_min:.1f} minuti")
    print("=" * 78)
    results = evaluate_invariants(snapshots)
    for res in results:
        print(f"{ICONS[res['status']]} {res['id']:<4} {res['name']}")
        print(f"        {res['detail']}")
    failed = [r["id"] for r in results if r["status"] == "fail"]
    skipped = [r["id"] for r in results if r["status"] == "skip"]
    passed = [r["id"] for r in results if r["status"] == "pass"]
    print("-" * 78)
    print(f"pass: {', '.join(passed) or '—'}")
    print(f"skip: {', '.join(skipped) or '—'}")
    print(f"fail: {', '.join(failed) or '—'}")

    if snapshots:
        last = max(snapshots, key=lambda s: s["ts"])
        payload = build_payload(last["regs"], "input_registers", [])
        print("-" * 78)
        print("Derivati sull'ultimo campione:")
        for key, value in payload["derived"].items():
            print(f"  {key:<20} {value}")
        suspects = {k: v for k, v in payload["quality"].items() if v == "suspect"}
        print(f"Campi suspect: {suspects or 'nessuno'}")
    print("=" * 78)
    return 1 if failed else 0


def main():
    parser = argparse.ArgumentParser(description="Legge i registri dell'inverter e opzionalmente espone un'API HTTP.")
    parser.add_argument("--serve", action="store_true", help="Espone endpoint HTTP /data che legge i registri live.")
    parser.add_argument(
        "--host",
        default="127.0.0.1",
        help="Host su cui esporre l'API (default: 127.0.0.1, solo loopback). "
             "ATTENZIONE: 0.0.0.0 espone la telemetria di casa a CHIUNQUE sia sulla LAN "
             "(ospiti, IoT, chi conosce il wifi). Kiosk e tailscale serve usano già il loopback.",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=None,
        help=f"Porta API. Priorità: --port > config.json server.port > {DEFAULT_HTTP_PORT}. "
             "Se la porta è occupata il server NON parte (nessun auto-incremento).",
    )
    parser.add_argument("--debug", action="store_true", help="Dump verboso dei registri ad ogni poll (default: off).")
    parser.add_argument(
        "--print-token",
        action="store_true",
        help="Stampa il token di accesso (generandolo se manca) ed esce. "
             "Serve a configurare i client non-browser, es. i widget macOS.",
    )
    parser.add_argument(
        "--validate",
        action="store_true",
        help="Verifica gli invarianti fisici della mappa registri. "
             "Dal vivo campiona per --duration secondi; con --from li valuta su un NDJSON.",
    )
    parser.add_argument("--from", dest="from_file", default=None,
                        help="File NDJSON di campioni da validare offline (vedi --capture).")
    parser.add_argument("--capture", default=None,
                        help="Registra i campioni in un file NDJSON mentre li legge.")
    parser.add_argument("--duration", type=float, default=60.0,
                        help="Durata in secondi del campionamento live (default: 60).")
    parser.add_argument("--interval", type=float, default=5.0,
                        help="Intervallo in secondi fra due campioni (default: 5).")
    parser.add_argument(
        "--history-maintenance",
        action="store_true",
        help="Esegue subito rollup dei giorni chiusi + retention dello storico ed esce. "
             "Serve a verificare la manutenzione senza aspettare le 00:05 "
             "(il servizio la fa da solo, questo è per il collaudo).",
    )
    args = parser.parse_args()

    if args.history_maintenance:
        result = history_maintenance()
        if not result["enabled"]:
            print("📚 Storico disabilitato da config.json (history.enabled=false).")
        else:
            print(f"📒 Rollup eseguiti: {result['rolled'] or 'nessuno'}")
            print(f"🧹 File cancellati: {result['removed'] or 'nessuno'}")
        return

    if args.print_token:
        # Stampa su stdout e basta: il token NON finisce nel log giornaliero.
        print(load_or_create_token())
        return

    try:
        load_mapping()
    except MappingError as exc:
        print(f"❌ {exc}")
        sys.exit(2)

    if args.validate:
        if args.from_file:
            snapshots = _load_ndjson(args.from_file)
            print(f"📂 {len(snapshots)} campioni letti da {args.from_file}")
        else:
            print(f"🎬 Campionamento live: {args.duration:.0f}s ogni {args.interval:.0f}s")
            snapshots = _sample_series(args.duration, args.interval, args.capture)
        if not snapshots:
            print("❌ nessun campione da validare")
            sys.exit(2)
        sys.exit(run_validation(snapshots))

    if args.capture:
        print(f"🎬 Cattura in {args.capture}: {args.duration:.0f}s ogni {args.interval:.0f}s")
        snaps = _sample_series(args.duration, args.interval, args.capture)
        print(f"✅ {len(snaps)} campioni scritti")
        return

    if args.serve:
        serve(args.host, resolve_port(args.port), debug=args.debug)
    else:
        print("Lettura registri dall'inverter...")
        try:
            regs, source, failed = read_registers()
            if failed:
                print(f"⚠️ blocchi non letti: {failed}")
            print_table(regs, source)
        except Exception as exc:
            print(f"❌ {exc}")


if __name__ == "__main__":
    main()
