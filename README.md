# ⚡ Real-Time Inverter Dashboard

Dashboard in tempo reale per monitorare il mio impianto fotovoltaico domestico con visualizzazione dei flussi energetici, calcolo automatico dell'autonomia della batteria e previsioni meteo integrate.

![Dashboard Preview](https://img.shields.io/badge/status-active-success)
![License](https://img.shields.io/badge/license-MIT-blue)

## 🎯 Motivazione

Ho creato questo progetto perché volevo **vedere in tempo reale** cosa stesse facendo il mio impianto fotovoltaico:
- 📊 **Monitoraggio istantaneo** di produzione solare, consumo domestico e stato della batteria
- 🔋 **Calcolo rapido dell'autonomia**: quanto durano le batterie fino all'alba?
- ☀️ **Previsioni intelligenti**: il mio sistema coprirà tutta la notte senza dover prelevare dalla rete?
- 🌐 **Visualizzazione intuitiva** dei flussi energetici tra pannelli, inverter, batteria, casa e rete

## ✨ Caratteristiche Principali

### 📈 Monitoraggio Real-Time
- **Produzione solare** in tempo reale (W/kW)
- **Stato batteria** con percentuale e kWh disponibili
- **Consumo domestico** istantaneo
- **Scambio con la rete** (import/export)
- **Potenza inverter** e tensione di rete

### 🔋 Calcolo Autonomia Intelligente
- Stima runtime batteria basata sul carico attuale
- Calcolo automatico del tempo mancante all'alba
- Indicatore visivo: "Copre fino all'alba" o deficit energetico
- Batteria visiva con gradiente di colore (verde→giallo→rosso)

### 🌤️ Integrazione Meteo
- Previsioni meteo da Open-Meteo (temperatura, condizioni, icone)
- **Sun tracker visivo** stile iOS con arco solare animato
- Calcolo durata del giorno (ore di luce solare)
- Forecast a 2 giorni con icone meteo

### 🎨 Visualizzazione Dati
- **Vista 2D**: Flow diagram con linee animate SVG che mostrano i flussi energetici
- **Vista 3D**: Rappresentazione isometrica dell'impianto (Three.js)
- Nodi uniformi con icone moderne e pulite
- Animazioni fluide per tutte le transizioni

## 🛠️ Tech Stack

- **Frontend**: HTML5, CSS3, Vanilla JavaScript
- **3D Graphics**: Three.js
- **Backend**: Python 3 (`http.server`)
- **Protocollo**: Modbus TCP (via `pymodbus`)
- **Weather API**: [Open-Meteo](https://open-meteo.com)
- **Inverter**: Compatibile con registri Modbus standard

## 📦 Installazione

### Prerequisiti
```bash
# Python 3.7+
python3 --version

# Installare pymodbus
pip install pymodbus
```

### Setup
1. **Clona il repository**
   ```bash
   git clone https://github.com/ripu/realtime-inverter.git
   cd realtime-inverter
   ```

2. **Configura il mapping Modbus**
   
   Modifica `registers.json` con i registri specifici del tuo inverter:
   ```json
   {
     "grid_voltage": 0,
     "inverter_power": 2,
     "grid_power": 3,
     "battery_percent": 28,
     ...
   }
   ```

3. **Avvia il server backend**
   ```bash
   python3 invert.py --serve --port 8003
   ```

4. **Apri il browser**
   ```
   http://localhost:8003
   ```

## ⚙️ Configurazione

### Inverter Modbus
Nel file `invert.py`, configura l'IP e la porta del tuo inverter:
```python
INVERTER_IP = "192.168.1.124"
MODBUS_PORT = 502
```

### Coordinate GPS (per meteo)
Nel file `index.html` (riga ~1663), aggiorna le coordinate:
```javascript
const LAT = 37.003794;  // Siracusa, IT
const LON = 15.255515;
```

### Capacità Batteria
Modifica in `index.html` (riga ~1495):
```javascript
const DEFAULT_BATTERY_KWH = 5.12;  // kWh della tua batteria
```

## 📊 Funzionalità Avanzate

### Auto-Refresh
- **Auto ON/OFF**: Polling automatico ogni 3 secondi
- **Pull manuale**: Aggiorna i dati on-demand
- Timestamp ultimo aggiornamento sempre visibile

### Filtri Intelligenti
- Valori di rete < 50W vengono azzerati (riduce rumore)
- Gestione errori Modbus con fallback a dati di esempio

### Sunrise/Sunset Logic
- Calcolo preciso del prossimo evento solare
- Adattamento automatico giorno/notte
- Visualizzazione dinamica del punto solare sull'arco

## 🎨 Personalizzazione

### Colori Tema
Modifica le variabili CSS nel `<style>`:
```css
--bg: #f4f6fa;
--panel: #ffffff;
--accent: #0ea5e9;
--danger: #ef4444;
```

### Icone Nodi
Tutte le icone SVG sono inline e personalizzabili. Cerca `viewBox="0 0 70 60"` nel codice.

## 📸 Screenshot

*(Aggiungi screenshot del tuo dashboard qui)*

## 🚀 Roadmap

- [ ] Grafici storici per produzione/consumo
- [ ] Notifiche push per eventi critici
- [ ] Export dati CSV
- [ ] App mobile companion

## 🤝 Contributi

Contributi, issue e richieste di funzionalità sono benvenuti!

## 📄 Licenza

MIT License - Vedi [LICENSE](LICENSE) per dettagli

## 👤 Autore

**Ripu**
- 📍 Siracusa, Italia
- ⚡ Impianto: Fotovoltaico + Batteria di accumulo

---

⭐ Se questo progetto ti è utile, lascia una stella su GitHub!
