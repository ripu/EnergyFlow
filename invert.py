import argparse
import json
import socket
import time
import os
import threading
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Dict, List, Tuple

from pymodbus.client import ModbusTcpClient

# --- CONFIGURAZIONE ---
# Load configuration from config.json
def load_config():
    try:
        with open("config.json", "r") as f:
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
DEFAULT_COUNT = 90  # Extended to read PV registers (70+) and Energy (82)
# ----------------------


def signed16(value: int) -> int:
    """Converte un unsigned 16-bit in signed."""
    return value - 65536 if value > 32767 else value


def read_registers(count: int = DEFAULT_COUNT, ip: str = None, port: int = None) -> Tuple[List[int], str]:
    """
    Legge i registri Modbus dall'inverter.
    ip/port opzionali (default: config corrente) — usati dalla discovery per testare candidati.
    Ritorna (lista_registri, sorgente_utilizzata).
    """
    ip = ip or INVERTER_IP
    port = port or MODBUS_PORT
    # timeout=3s: evita che una read Modbus lenta/persa appenda il server (vedi poller in background)
    client = ModbusTcpClient(ip, port=port, timeout=3, retries=1)
    if not client.connect():
        raise ConnectionError(f"Impossibile connettersi a {ip}:{port}")

    try:
        # Try Input Registers FIRST (User confirmed this works for valid data)
        # Compatibility for different pymodbus versions
        # v3.11+ uses 'device_id', older v3.x uses 'slave', v2.x uses 'unit'
        # We try 'slave' first (local dev), then fallback to 'device_id' (RPi).
        try:
            rr = client.read_input_registers(0, count=count, slave=SLAVE_ID)
        except TypeError:
            try:
                 rr = client.read_input_registers(0, count=count, device_id=SLAVE_ID)
            except TypeError:
                 rr = client.read_input_registers(0, count=count, unit=SLAVE_ID)
        source = "input_registers"

        if rr.isError():
            print("⚠️ Input Registers failed, trying Holding Registers...")
            # NOTE: Holding registers might fail independently.
            try:
                rr = client.read_holding_registers(0, count=count, slave=SLAVE_ID)
            except TypeError:
                try:
                    rr = client.read_holding_registers(0, count=count, device_id=SLAVE_ID)
                except TypeError:
                    rr = client.read_holding_registers(0, count=count, unit=SLAVE_ID)
            source = "holding_registers"
            
        if rr.isError():
            raise IOError(f"Modbus Error: {rr}")
            
        return rr.registers, source

    finally:
        client.close()


def load_mapping():
    try:
        with open("registers.json", "r") as f:
            return json.load(f)
    except Exception as e:
        print(f"Error loading registers.json, using defaults: {e}")
        return None

def decode_values(regs: List[int]) -> Dict[str, float]:
    """Deriva i valori principali dai registri grezzi usando registers.json."""
    mapping = load_mapping()
    
    # helper for safe access
    def get(idx: int):
        return regs[idx] if idx < len(regs) else 0

    # Default configuration if json missing
    registers_conf = {
        "grid_voltage": {"reg": 0, "scale": 0.1},
        "inverter_power": {"reg": 2, "scale": 1, "signed": True},
        "grid_flow": {"reg": 80, "scale": 10, "signed": True}, # Default updated to matches observation
        "battery_percent": {"reg": 28, "scale": 1},
        "battery_voltage": {"reg": 29, "scale": 0.1},
        "battery_power": {"reg": 22, "scale": 1, "signed": True},
        "daily_energy": {"reg": 82, "scale": 0.1},
        "home_load": {"reg": 38, "scale": 0.1}
    }

    if mapping and "registers" in mapping:
        registers_conf = mapping["registers"]

    values = {}
    
    # Dynamic Read
    for key, conf in registers_conf.items():
        reg_idx = conf.get("reg", 0)
        raw_val = get(reg_idx)
        
        # Apply Signed
        if conf.get("signed", False):
            raw_val = signed16(raw_val)
            
        # Apply Scale
        scale = conf.get("scale", 1)
        val = raw_val * scale
        
        values[key] = val

    # Helper accessors
    inverter_power = abs(values.get("inverter_power", 0))
    grid_flow = values.get("grid_flow", 0) * -1 # Invert logic: User wants Neg=Export? 
    # Logic note: original code had grid_flow = -1 * raw_grid.
    # registers.json note says: "Positive=Import, Negative=Export".
    # So if raw is +581 (Import), final should be +581.
    # But original code inverted it?
    # Original code: 
    #   raw_grid = signed16(get(80)) ...
    #   grid_flow = -1 * raw_grid
    # If reg 80 is 57 (Import), raw_grid=57. grid_flow=-57.
    # Wait. If I import from grid, I expect POSITIVE in most dashboards?
    # Let's check SODE logic: "Grid: Inverted logic (Negative = Export)."
    # If Import is Positive, then Export is Negative.
    # If Reg 80 is Positive for Import (57), then we should keep it Positive?
    # OLD CODE: grid_flow = -1 * raw_grid. So 57 becomes -57.
    # This implies OLD CODE treated Reg 80 as "Export is Positive"? 
    # Or OLD CODE wanted Import to be Negative?
    # Let's trust the JSON Note which I wrote/approved: "Positive=Import, Negative=Export".
    # If Reg 80 is 58 (Import), we want +580.
    # If OLD CODE did -1*, it was probably wrong or consistent with a different convention.
    # I will stick to "Positive = Import" for the dashboard logic unless proven otherwise.
    # BUT, to match existing flow logic (Home = Inverter + Grid):
    # If I consume 1000W house, Inverter 0W. Grid must be +1000W.
    # So grid_flow MUST be positive for Import.
    # So if Reg 80 is Positive for Import, we do NOT invert.
    
    grid_flow_w = values.get("grid_flow", 0) 
    
    # Special fix: if the user insisted on specific config in JSON, I should trust JSON.
    # But for now, let's assume JSON "Positive=Import" is correct and reg 80 is Import.
    
    battery_power = values.get("battery_power", 0)
    battery_percent = values.get("battery_percent", 0)
    daily_energy = values.get("daily_energy", 0)
    grid_voltage = values.get("grid_voltage", 0)
    battery_voltage = values.get("battery_voltage", 0)

    # Logic for Balance Formula:
    # Home Load is now DIRECTLY read from Reg 38 (User verified 12288 -> 1.22kW)
    # If not present, fallback to calculation? No, valid configuration should have it.
    home_load_w = values.get("home_load", 0)
    
    # If home_load is 0 (missing reg), fallback to old logic for safety?
    # Old logic: Inverter + Grid.
    if home_load_w == 0:
         home_load_w = inverter_power + grid_flow_w

    if home_load_w < 0: home_load_w = 0

    # Solar Derived: Solar = Home + Battery(Charge) - Grid
    # Battery Power: Positive = Charging (Load), Negative = Discharging (Source)
    # Grid Flow: Positive = Import (Source), Negative = Export (Load? No, Export is Flow OUT).
    #
    # Balance: Sources = Loads
    # Solar + Grid_Import + Battery_Discharge = Home + Grid_Export + Battery_Charge
    #
    # Let's map to our variables:
    # grid_flow_w: +Import, -Export.
    # battery_power: +Charge, -Discharge.
    # home_load: +Load.
    # solar: ?
    #
    # Solar + (grid_flow if >0) + (-battery if <0) = home_load + (-grid_flow if <0) + (battery if >0)
    # Solar + grid_flow - battery_power = home_load  (Simplified sign math)
    # Solar = home_load + battery_power - grid_flow
    #
    # Example:
    # Home 1228. Grid 580 (Import). Battery 0.
    # Solar = 1228 + 0 - 580 = 648. CORRECT.
    
    pv_power_w = home_load_w + battery_power - grid_flow_w
    if pv_power_w < 0: pv_power_w = 0

    return {
        "battery_percent": battery_percent,
        "battery_power_w": battery_power,
        "inverter_power_w": inverter_power,
        "grid_voltage_v": grid_voltage,
        "grid_flow_w": grid_flow_w,
        "home_load_w": home_load_w,
        "solar_power_w": pv_power_w,
        "daily_energy_kwh": daily_energy,
        "battery_voltage_v": battery_voltage,
    }


def build_payload(regs: List[int], source: str) -> Dict:
    """Crea il payload JSON con grezzi + derivati."""
    raw = {i: v for i, v in enumerate(regs)}
    derived = decode_values(regs)
    return {
        "raw": raw,
        "derived": derived,
        "meta": {
            "ip": INVERTER_IP,
            "port": MODBUS_PORT,
            "source": source,
            "count": len(regs),
            "timestamp": time.time(),
        },
    }


def print_table(regs: List[int], source: str):
    print(f"✅ Connesso! Sorgente: {source}")
    print("-" * 40)
    print(f"{'REGISTRO':<10} | {'VALORE (Grezzo)':<15}")
    print("-" * 40)
    for i, val in enumerate(regs):
        if val != 0:
            print(f"Reg {i:<6} | {val}")
    print("-" * 40)
    print("💡 SUGGERIMENTO: Cerca questi numeri nell'App Q.HOME.")
    print("Es: Se vedi 2230, potrebbe essere 2.23 kW.")
    print("Es: Se vedi 98, potrebbe essere la batteria al 98%.")


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
    """Firma anti falsi-positivi: reg 0 = tensione rete ~230V*10, reg 28 = SOC 0-100."""
    if len(regs) < 29:
        return False
    return 1800 <= regs[0] <= 2600 and 0 <= regs[28] <= 100


def _persist_inverter_ip(new_ip: str):
    """Riscrive config.json con il nuovo IP (preserva il resto della config)."""
    try:
        with open("config.json", "r") as f:
            cfg = json.load(f)
        cfg.setdefault("inverter", {})["ip"] = new_ip
        with open("config.json", "w") as f:
            json.dump(cfg, f, indent=4)
        print(f"💾 config.json aggiornato: inverter.ip = {new_ip}")
    except Exception as exc:
        # Non fatale: l'IP in memoria è già aggiornato, persiste solo fino al restart
        print(f"⚠️ Impossibile salvare config.json: {exc}")


def discover_inverter() -> str:
    """
    Sweep della subnet /24 sulla porta Modbus + verifica firma registri.
    Ritorna il nuovo IP se trovato, altrimenti None. Timing loggato (regola #7).
    """
    global INVERTER_IP
    t0 = time.time()
    prefix = _local_subnet_prefix()
    print(f"🔍 Discovery: sweep {prefix}0/24 porta {MODBUS_PORT}...")

    candidates = []
    with ThreadPoolExecutor(max_workers=64) as pool:
        ips = [f"{prefix}{i}" for i in range(1, 255)]
        for ip, is_open in zip(ips, pool.map(lambda ip: _port_open(ip, MODBUS_PORT), ips)):
            if is_open:
                candidates.append(ip)

    print(f"🔍 Discovery: {len(candidates)} candidati porta aperta: {candidates or 'nessuno'}")

    for ip in candidates:
        try:
            regs, _ = read_registers(count=30, ip=ip)
        except Exception:
            continue
        if _looks_like_inverter(regs):
            elapsed_ms = (time.time() - t0) * 1000
            print(f"✅ Discovery {elapsed_ms:.0f}ms: inverter trovato su {ip} (era {INVERTER_IP})")
            INVERTER_IP = ip
            _persist_inverter_ip(ip)
            return ip
        print(f"🔍 Discovery: {ip} ha porta {MODBUS_PORT} aperta ma firma registri non combacia, skip")

    elapsed_ms = (time.time() - t0) * 1000
    print(f"⚠️ Discovery {elapsed_ms:.0f}ms: inverter non trovato su {prefix}0/24")
    return None


# --- CACHE + POLLER (B) ---
# Il polling Modbus gira in un thread di background: l'inverter viene letto ogni
# POLL_INTERVAL secondi e il risultato salvato in cache. Le richieste HTTP /data
# servono SOLO la cache → mai bloccanti, anche se l'inverter non risponde.
POLL_INTERVAL = 5  # secondi tra una lettura inverter e la successiva

_cache = {"payload": None, "ts": 0.0, "error": None}
_cache_lock = threading.Lock()


def poll_loop(count: int, debug: bool = False):
    """Loop infinito: legge l'inverter e aggiorna la cache. Gira come daemon thread."""
    print(f"🔄 Poller avviato (intervallo {POLL_INTERVAL}s, count={count})")
    consecutive_fails = 0
    last_discovery = 0.0
    while True:
        t0 = time.time()
        try:
            regs, source = read_registers(count=count)
            payload = build_payload(regs, source)
            elapsed_ms = (time.time() - t0) * 1000
            with _cache_lock:
                _cache["payload"] = payload
                _cache["ts"] = time.time()
                _cache["error"] = None
            consecutive_fails = 0
            d = payload["derived"]
            # Log conciso + timing (regola #7: timing su operazioni pesanti)
            print(
                f"✅ Poll {elapsed_ms:.0f}ms src={source} "
                f"home={d['home_load_w']:.0f}W solar={d['solar_power_w']:.0f}W "
                f"grid={d['grid_flow_w']:.0f}W batt={d['battery_power_w']:.0f}W/{d['battery_percent']:.0f}%"
            )
            if debug:
                _print_debug_regs(regs)
        except Exception as exc:
            elapsed_ms = (time.time() - t0) * 1000
            consecutive_fails += 1
            with _cache_lock:
                _cache["error"] = str(exc)
            print(f"⚠️ Poll error dopo {elapsed_ms:.0f}ms (fail #{consecutive_fails}): {exc}")
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
    if mapping and "registers" in mapping:
        for k, v in mapping["registers"].items():
            if "reg" in v:
                inv_map[v["reg"]] = (k, v.get("scale", 1), v.get("unit", ""))
    for i, val in enumerate(regs):
        if val == 0:
            continue
        signed_val = val - 65536 if val > 32767 else val
        extra = ""
        if i in inv_map:
            name, scale, unit = inv_map[i]
            scaled = signed_val * scale
            val_str = f"{scaled:.1f}" if isinstance(scaled, float) else f"{scaled}"
            extra = f"  -> {name}: {val_str}{unit}"
        if val > 32767:
            print(f"Reg {i}: {val} ({signed_val}){extra}")
        else:
            print(f"Reg {i}: {val}{extra}")
    print("------------------\n")


def make_handler(count: int):
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            if self.path == "/log":
                length = int(self.headers.get('content-length', 0))
                data = self.rfile.read(length).decode('utf-8')
                with open("frontend.log", "a") as f:
                    f.write(f"[{time.ctime()}] {data}\n")
                self.send_response(200)
                self.end_headers()
                return
            self.send_response(404)
            self.end_headers()

        def _send_json(self, payload, code=200):
            body = json.dumps(payload).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            # CORS: Allow all
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "*")
            self.end_headers()
            self.wfile.write(body)

        def do_OPTIONS(self):
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.end_headers()

        def do_GET(self):
            if self.path.startswith("/health"):
                return self._send_json({"status": "ok", "ip": INVERTER_IP})

            if self.path.startswith("/data"):
                # Serve SOLO dalla cache popolata dal poller in background: mai bloccante.
                with _cache_lock:
                    payload = _cache["payload"]
                    err = _cache["error"]
                    ts = _cache["ts"]

                if payload is None:
                    # Nessuna lettura riuscita ancora (avvio o inverter offline da subito)
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

            # Static File Serving
            if self.path == "/" or self.path == "/index.html":
                return self._serve_file("index.html")
            
            # Basic allow-list for current dir files (css, js, maps)
            # Security: simple sanitization to prevent directory traversal
            # Remove query string if present
            clean_path = self.path.split('?')[0].lstrip('/')
            
            if ".." not in clean_path and os.path.exists(clean_path) and os.path.isfile(clean_path):
                 return self._serve_file(clean_path)

            self.send_response(404)
            self.end_headers()

        def _serve_file(self, filename):
            try:
                with open(filename, 'rb') as f:
                    content = f.read()
                
                # MIME Types
                if filename.endswith(".html"): mime = "text/html"
                elif filename.endswith(".css"): mime = "text/css"
                elif filename.endswith(".js"): mime = "application/javascript"
                elif filename.endswith(".json"): mime = "application/json"
                elif filename.endswith(".png"): mime = "image/png"
                elif filename.endswith(".jpg"): mime = "image/jpeg"
                elif filename.endswith(".svg"): mime = "image/svg+xml"
                else: mime = "application/octet-stream"

                self.send_response(200)
                self.send_header("Content-Type", mime)
                self.send_header("Content-Length", str(len(content)))
                # Disable Caching
                self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
                self.send_header("Pragma", "no-cache")
                self.send_header("Expires", "0")
                self.end_headers()
                self.wfile.write(content)
            except Exception as e:
                print(f"Error serving {filename}: {e}")
                self.send_response(500)
                self.end_headers()

        def log_message(self, format, *args):
            # Silenzia il logging HTTP standard.
            return

    return Handler


def serve(host: str, port: int, count: int, debug: bool = False):
    # Avvia il poller Modbus in un daemon thread PRIMA di aprire il server HTTP (B).
    poller = threading.Thread(target=poll_loop, args=(count, debug), daemon=True)
    poller.start()

    # Try to bind to port, if busy increment and retry
    max_retries = 10
    server = None
    current_port = port
    
    for i in range(max_retries):
        try:
            server = ThreadingHTTPServer((host, current_port), make_handler(count))
            break # Success
        except OSError as e:
            if e.errno == 48: # Address already in use
                print(f"⚠️  Porta {current_port} occupata, provo {current_port + 1}...")
                current_port += 1
            else:
                raise e
    
    if server is None:
        print(f"❌ Impossibile trovare una porta libera dopo {max_retries} tentativi.")
        return

    url = f"http://{host}:{current_port}/" if host != "0.0.0.0" else f"http://localhost:{current_port}/"
    
    print(f"🌐 Server attivo su {url}")
    print(f"   Modbus Target: {INVERTER_IP}:{MODBUS_PORT}")
    
    # Auto-open browser
    try:
        import webbrowser
        webbrowser.open(url)
    except:
        pass

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nChiusura server...")
    finally:
        server.server_close()


def main():
    parser = argparse.ArgumentParser(description="Legge i registri dell'inverter e opzionalmente espone un'API HTTP.")
    parser.add_argument("--serve", action="store_true", help="Espone endpoint HTTP /data che legge i registri live.")
    parser.add_argument("--host", default="0.0.0.0", help="Host su cui esporre l'API (default: 0.0.0.0).")
    parser.add_argument("--port", type=int, default=8000, help="Porta API (default: 8000).")
    parser.add_argument("--count", type=int, default=DEFAULT_COUNT, help="Quanti registri leggere (default: 50).")
    parser.add_argument("--debug", action="store_true", help="Dump verboso dei registri ad ogni poll (default: off).")
    args = parser.parse_args()

    if args.serve:
        serve(args.host, args.port, args.count, debug=args.debug)
    else:
        print(f"Tentativo di connessione a {INVERTER_IP}...")
        try:
            regs, source = read_registers(count=args.count)
            print_table(regs, source)
        except Exception as exc:
            print(f"❌ {exc}")


if __name__ == "__main__":
    main()
