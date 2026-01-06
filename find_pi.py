import socket
import concurrent.futures
import subprocess
import re

def get_local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        local_ip = s.getsockname()[0]
        s.close()
        return local_ip
    except:
        return "192.168.1.119"

def ping_host(ip):
    try:
        subprocess.run(["ping", "-c", "1", "-W", "200", ip], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except:
        pass

def check_arp_for_pi():
    print("🔎 Scanning ARP table for Raspberry Pi...")
    # Ping sweep to populate ARP (optional, but good)
    local_ip = get_local_ip()
    base_ip = ".".join(local_ip.split(".")[:-1]) + "."
    
    with concurrent.futures.ThreadPoolExecutor(max_workers=50) as executor:
        list(executor.map(ping_host, [f"{base_ip}{i}" for i in range(1, 255)]))

    # Read ARP
    try:
        out = subprocess.check_output(["arp", "-a"]).decode()
    except:
        return []

    pis = []
    # RPi OUIs: b8:27:eb, dc:a6:32, e4:5f:01, 28:cd:c1
    pi_ouis = ["b8:27:eb", "dc:a6:32", "e4:5f:01", "28:cd:c1", "d8:3a:dd"]
    
    for line in out.splitlines():
        # Example: ? (192.168.1.124) at 68:b6:b3:c:95:26 on en0 ifscope [ethernet]
        match = re.search(r"\(([\d\.]+)\) at ([0-9a-f:]+)", line)
        if match:
            ip = match.group(1)
            mac = match.group(2).lower()
            # Normalize mac
            if len(mac.split(":")) == 6:
                for oui in pi_ouis:
                    if mac.startswith(oui):
                        pis.append((ip, mac))
                        print(f"🍓 FOUND RASPBERRY PI! IP: {ip} (MAC: {mac})")
    
    if not pis:
        print("❌ No Raspberry Pi found in ARP table.")
        print("Raw ARP dump for review:")
        print(out)
    
    return pis

if __name__ == "__main__":
    check_arp_for_pi()
