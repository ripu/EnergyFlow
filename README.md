# ⚡ EnergyFlow

Real-time solar energy monitoring dashboard with animated flow visualization, intelligent battery autonomy calculation, and integrated weather forecasting.

![Dashboard Preview](https://img.shields.io/badge/status-active-success)
![License](https://img.shields.io/badge/license-MIT-blue)

## 📸 Dashboard Preview

![Dashboard Screenshot](screenshot.png)

*Real-time dashboard showing solar production, battery status, home consumption, and animated energy flows*

## 🎯 Motivation

I created this project because I wanted to **see in real-time** what my solar installation was doing:
- 📊 **Instant monitoring** of solar production, home consumption, and battery status
- 🔋 **Quick autonomy calculation**: how long will the batteries last until sunrise?
- ☀️ **Smart forecasting**: will my system cover the entire night without drawing from the grid?
- 🌐 **Intuitive visualization** of energy flows between panels, inverter, battery, home, and grid

## ✨ Key Features

### 📈 Real-Time Monitoring
- **Solar production** in real-time (W/kW)
- **Battery status** with percentage and available kWh
- **Home consumption** instantaneous
- **Grid exchange** (import/export)
- **Inverter power** and grid voltage

### 🔋 Intelligent Battery Autonomy
- Battery runtime estimation based on current load
- Automatic calculation of time until sunrise
- Visual indicator: "Covers until sunrise" or energy deficit
- Visual battery with color gradient (green→yellow→red)

### 🌤️ Weather Integration
- Weather forecast from Open-Meteo (temperature, conditions, icons)
- **iOS-style sun tracker** with animated solar arc
- Day length calculation (hours of sunlight)
- 2-day forecast with weather icons

### 🎨 Data Visualization
- **2D View**: Flow diagram with animated SVG lines showing energy flows
- **3D View**: Isometric representation of the system (Three.js)
- Uniform nodes with modern, clean icons
- Smooth animations for all transitions

## 🛠️ Tech Stack

- **Frontend**: HTML5, CSS3, Vanilla JavaScript
- **3D Graphics**: Three.js
- **Backend**: Python 3 (`http.server`)
- **Protocol**: Modbus TCP (via `pymodbus`)
- **Weather API**: [Open-Meteo](https://open-meteo.com)
- **Inverter**: Compatible with standard Modbus registers

## 📦 Installation

### Prerequisites
```bash
# Python 3.7+
python3 --version

# Install pymodbus
pip install pymodbus
```

### Setup
1. **Clone the repository**
   ```bash
   git clone https://github.com/ripu/EnergyFlow.git
   cd EnergyFlow
   ```

2. **Configure your settings**
   ```bash
   cp config.example.json config.json
   # Edit config.json with your data (GPS, inverter IP, battery capacity)
   ```

3. **Customize Modbus mapping** (optional)
   
   Edit `registers.json` only if your inverter uses different registers:
   ```json
   {
     "grid_voltage": 0,
     "inverter_power": 2,
     "grid_power": 3,
     "battery_percent": 28
   }
   ```

4. **Start the backend server**
   ```bash
   python3 invert.py --serve --port 8003
   ```

5. **Open your browser**
   ```
   http://localhost:8003
   ```

## ⚙️ Configuration

### Initial Setup

1. **Copy the example file**
   ```bash
   cp config.example.json config.json
   ```

2. **Edit `config.json` with your data**
   ```json
   {
     "location": {
       "latitude": 0.0,        // Your GPS coordinates
       "longitude": 0.0,
       "timezone": "Europe/Rome"
     },
     "inverter": {
       "ip": "192.168.1.100",  // Your inverter IP
       "port": 502
     },
     "battery": {
       "capacity_kwh": 5.0     // Your battery capacity in kWh
     },
     "server": {
       "port": 8003
     }
   }
   ```

3. **Customize Modbus mapping**
   
   Edit `registers.json` with your inverter's specific registers:
   ```json
   {
     "grid_voltage": 0,
     "inverter_power": 2,
     "grid_power": 3,
     "battery_percent": 28,
     "pv1_voltage": 70,
     "pv1_current": 71
   }
   ```

## 📊 Advanced Features

### Auto-Refresh
- **Auto ON/OFF**: Automatic polling every 3 seconds
- **Manual pull**: Update data on-demand
- Last update timestamp always visible

### Smart Filters
- Grid values < 50W are zeroed (reduces noise)
- Modbus error handling with fallback to example data

### Sunrise/Sunset Logic
- Precise calculation of next solar event
- Automatic day/night adaptation
- Dynamic visualization of sun position on arc

## 🎨 Customization

### Theme Colors
Modify CSS variables in the `<style>` section:
```css
--bg: #f4f6fa;
--panel: #ffffff;
--accent: #0ea5e9;
--danger: #ef4444;
```

### Node Icons
All SVG icons are inline and customizable. Search for `viewBox="0 0 70 60"` in the code.

## 🚀 Roadmap

- [ ] Historical charts for production/consumption
- [ ] Push notifications for critical events
- [ ] CSV data export
- [ ] Mobile companion app

## 🤝 Contributing

Contributions, issues, and feature requests are welcome!

## 📄 License

MIT License - See [LICENSE](LICENSE) for details

---

⭐ If you find this project useful, leave a star on GitHub!
