import argparse
import json
import time
import os
from http.server import BaseHTTPRequestHandler, HTTPServer
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
            "inverter": {"ip": "192.168.1.100", "port": 502}
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


def read_registers(count: int = DEFAULT_COUNT) -> Tuple[List[int], str]:
    """
    Legge i registri Modbus dall'inverter.
    Ritorna (lista_registri, sorgente_utilizzata).
    """
    client = ModbusTcpClient(INVERTER_IP, port=MODBUS_PORT)
    if not client.connect():
        raise ConnectionError(f"Impossibile connettersi a {INVERTER_IP}:{MODBUS_PORT}")

    try:
        # Try Input Registers FIRST (User confirmed this works for valid data)
        rr = client.read_input_registers(0, count=count, slave=SLAVE_ID)
        source = "input_registers"

        if rr.isError():
            print("⚠️ Input Registers failed, trying Holding Registers...")
            rr = client.read_holding_registers(0, count=count, slave=SLAVE_ID)
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
    """Deriva i valori principali dai registri grezzi."""
    mapping = load_mapping()
    
    def get(idx: int):
        return regs[idx] if idx < len(regs) else None

    # Defaults (hardcoded fallback)
    reg_map = {
        "grid_voltage": 0,
        "inverter_power": 2,
        "grid_flow": 3,
        "battery_percent": 28,
        "battery_voltage": 29,
        "daily_energy": 82
    }
    
    # Override defaults if mapping file exists
    if mapping and "registers" in mapping:
        for key, conf in mapping["registers"].items():
            if "reg" in conf:
                reg_map[key] = conf["reg"]

    # Decode using map
    grid_voltage = (get(reg_map["grid_voltage"]) / 10.0) if get(reg_map["grid_voltage"]) is not None else 0
    inverter_power = signed16(get(reg_map["inverter_power"]) or 0)
    grid_flow = signed16(get(reg_map["grid_flow"]) or 0)
    battery_percent = get(reg_map["battery_percent"]) or 0
    
    # PV Calculation (Reg 70-75) - Voltage x10, Current x10
    # Currently hardcoded logic because it involves math, but register IDs can be mapped if needed.
    pv1_v = (get(70) or 0) / 10.0
    pv1_a = (get(71) or 0) / 10.0
    pv2_v = (get(74) or 0) / 10.0
    pv2_a = (get(75) or 0) / 10.0
    
    pv_power_w = int((pv1_v * pv1_a) + (pv2_v * pv2_a))
    
    # Daily Energy
    daily_energy = (get(reg_map["daily_energy"]) or 0) / 10.0

    # Logic for 3D Dashboard:
    # Home Load = Inverter AC + Grid Flow
    home_load_w = inverter_power + grid_flow
    if home_load_w < 0: home_load_w = 0 # Safety clamp

    return {
        "battery_percent": battery_percent,
        "inverter_power_w": inverter_power,
        "grid_voltage_v": grid_voltage,
        "grid_flow_w": grid_flow,
        "home_load_w": home_load_w,
        "solar_power_w": pv_power_w,
        "daily_energy_kwh": daily_energy,
        "battery_voltage_v": (get(reg_map["battery_voltage"]) or 0) / 10.0,
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
                try:
                    regs, source = read_registers(count=count)
                    
                    # DEBUG: Print all non-zero registers to help mapping
                    print("\n--- DEBUG READ ---")
                    for i, val in enumerate(regs):
                        if val > 0 and val < 65000: # Filter likely valid positive values
                            print(f"Reg {i}: {val}")
                        elif val > 65000: # Python signed check
                            print(f"Reg {i}: {val} ({val-65536})")
                    print("------------------\n")

                    return self._send_json(build_payload(regs, source))
                except Exception as exc:
                    return self._send_json({"error": str(exc)}, code=500)

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


def serve(host: str, port: int, count: int):
    # Try to bind to port, if busy increment and retry
    max_retries = 10
    server = None
    current_port = port
    
    for i in range(max_retries):
        try:
            server = HTTPServer((host, current_port), make_handler(count))
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
    args = parser.parse_args()

    if args.serve:
        serve(args.host, args.port, args.count)
    else:
        print(f"Tentativo di connessione a {INVERTER_IP}...")
        try:
            regs, source = read_registers(count=args.count)
            print_table(regs, source)
        except Exception as exc:
            print(f"❌ {exc}")


if __name__ == "__main__":
    main()
