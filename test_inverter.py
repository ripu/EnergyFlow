from pymodbus.client import ModbusTcpClient
import time

# --- CONFIGURAZIONE ---
INVERTER_IP = '192.168.1.124' # <--- METTI QUI L'IP CHE HAI TROVATO CON LA PORTA 502 APERTA
PORT = 502
# ----------------------

def scan_registers():
    print(f"Tentativo di connessione a {INVERTER_IP}...")
    client = ModbusTcpClient(INVERTER_IP, port=PORT)
    
    if not client.connect():
        print("❌ Impossibile connettersi. Verifica l'IP.")
        return

    print("✅ Connesso! Leggo i dati grezzi...")
    
    try:
        # Leggiamo i primi 50 registri (Input Registers)
        # Molti inverter mettono qui i dati live (V, A, W)
        rr = client.read_input_registers(address=0, count=50, slave=1)
        
        if rr.isError():
            print("Errore lettura. Provo con Holding Registers...")
            # Alcuni inverter usano Holding invece di Input
            rr = client.read_holding_registers(address=0, count=50, slave=1)

        if not rr.isError():
            print("-" * 40)
            print(f"{'REGISTRO':<10} | {'VALORE (Grezzo)':<15}")
            print("-" * 40)
            for i, val in enumerate(rr.registers):
                # Filtriamo i valori a zero per pulizia, ma mostriamo i primi
                if val > 0: 
                    print(f"Reg {i:<6} | {val}")
            print("-" * 40)
            print("💡 SUGGERIMENTO: Cerca questi numeri nell'App Q.HOME.")
            print("Es: Se vedi 2230, potrebbe essere 2.23 kW.")
            print("Es: Se vedi 98, potrebbe essere la batteria al 98%.")
        else:
            print("❌ Errore nella lettura dei registri.")
            
    except Exception as e:
        print(f"Errore: {e}")
    
    client.close()

if __name__ == "__main__":
    scan_registers()
