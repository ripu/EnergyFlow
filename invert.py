import argparse
import json
import time
import os
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Dict, List, Tuple

from pymodbus.client import ModbusTcpClient

# --- CONFIGURAZIONE ---
INVERTER_IP = "192.168.1.124"  # IP inverter (porta 502 aperta)
MODBUS_PORT = 502
SLAVE_ID = 1
DEFAULT_COUNT = 50
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
        rr = client.read_input_registers(address=0, count=count, slave=SLAVE_ID)
        source = "input_registers"

        if (rr is None) or rr.isError():
            rr = client.read_holding_registers(address=0, count=count, slave=SLAVE_ID)
            source = "holding_registers"

        if (rr is None) or rr.isError():
            raise RuntimeError("Errore nella lettura dei registri.")

        return rr.registers, source
    finally:
        client.close()


def decode_values(regs: List[int]) -> Dict[str, float]:
    """Deriva i valori principali dai registri grezzi."""

    def get(idx: int):
        return regs[idx] if idx < len(regs) else None

    battery_percent = get(28)
    inverter_power = signed16(get(2) or 0) if get(2) is not None else None
    grid_voltage = (get(0) / 10) if get(0) is not None else None
    grid_flow = signed16(get(21) or 0) if get(21) is not None else None
    battery_voltage = (get(33) / 10) if get(33) is not None else None

    return {
        "battery_percent": battery_percent,
        "inverter_power_w": inverter_power,
        "grid_voltage_v": grid_voltage,
        "grid_flow_w": grid_flow,
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
                    return self._send_json(build_payload(regs, source))
                except Exception as exc:
                    return self._send_json({"error": str(exc)}, code=500)

            # Static File Serving
            if self.path == "/" or self.path == "/index.html":
                return self._serve_file("index.html")
            
            # Basic allow-list for current dir files (css, js, maps)
            # Security: simple sanitization to prevent directory traversal
            clean_path = self.path.lstrip('/')
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
