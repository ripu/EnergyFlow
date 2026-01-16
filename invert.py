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
    if home_load_w == 0 and values.get("inverter_power", 0) > 0:
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
                    
                    # DEBUG: Print all non-zero registers with mapping
                    print("\n--- DEBUG READ ---")
                    mapping = load_mapping()
                    inv_map = {}
                    if mapping and "registers" in mapping:
                        for k, v in mapping["registers"].items():
                            if "reg" in v:
                                inv_map[v["reg"]] = (k, v.get("scale", 1), v.get("unit", ""))

                    for i, val in enumerate(regs):
                        # Decode signed
                        signed_val = val - 65536 if val > 32767 else val
                        
                        # Check if mapped
                        extra = ""
                        if i in inv_map:
                            name, scale, unit = inv_map[i]
                            scaled = signed_val * scale
                            # Format nicely
                            if isinstance(scaled, float):
                                val_str = f"{scaled:.1f}"
                            else:
                                val_str = f"{scaled}"
                            extra = f"  -> {name}: {val_str}{unit}"
                        
                        if val != 0:
                            if val > 32767:
                                print(f"Reg {i}: {val} ({signed_val}){extra}")
                            else:
                                print(f"Reg {i}: {val}{extra}")
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
