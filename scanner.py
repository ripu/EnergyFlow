
import argparse
from pymodbus.client import ModbusTcpClient
import json

# Config
with open("config.json", "r") as f:
    config = json.load(f)

IP = config["inverter"]["ip"]
PORT = config["inverter"]["port"]
SLAVE = 1

def scan():
    client = ModbusTcpClient(IP, port=PORT)
    client.connect()
    
    print(f"Scanning {IP}:{PORT} (Slave {SLAVE})...")
    print("Looking for values near: 637 (Solar), 1220 (Home), 0 (Battery)\n")
    
    # Read in chunks
    chunk = 100
    for start in range(0, 200, chunk):
        rr = client.read_input_registers(start, count=chunk, slave=SLAVE)
        if not rr.isError():
            for i, val in enumerate(rr.registers):
                reg = start + i
                if val != 0:
                    # Check signed
                    signed = val - 65536 if val > 32767 else val
                    print(f"Reg {reg:<3}: {val:<5} (Signed: {signed:<5})")
        else:
            print(f"Error reading {start}-{start+chunk}")

    client.close()

if __name__ == "__main__":
    scan()
