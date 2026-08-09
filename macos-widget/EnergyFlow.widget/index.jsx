
// EnergyFlow Widget for Übersicht
// Place this folder in your Übersicht widgets folder (usually ~/Library/Application Support/Übersicht/widgets)

// 1. Fetch data using curl (robust local network access)
//    /data ora richiede il token di servizio (regola #17). Il token non sta qui dentro:
//    si legge da ~/.config/energyflow/token, che non è nel repo.
//      mkdir -p ~/.config/energyflow
//      python3 invert.py --print-token > ~/.config/energyflow/token && chmod 600 ~/.config/energyflow/token
//    Se il file manca, curl parte senza header: con l'auth accesa il server risponde
//    401 e il widget mostra l'errore, invece di restare misteriosamente vuoto.
//    L'indirizzo non è più fisso: il server sta sul Raspberry e ascolta solo in
//    loopback, quindi da qui ci si arriva via tailnet. Si configura una volta:
//      mkdir -p ~/.config/energyflow
//      echo "https://<host>.<tailnet>.ts.net" > ~/.config/energyflow/url
//      ssh <rpi-host> 'cd ~/EnergyFlow && ./venv/bin/python3 invert.py --print-token' \
//        > ~/.config/energyflow/token && chmod 600 ~/.config/energyflow/token
export const command =
  "U=$(cat ~/.config/energyflow/url 2>/dev/null || echo 'http://127.0.0.1:8003'); " +
  "T=$(cat ~/.config/energyflow/token 2>/dev/null); " +
  "curl -s --max-time 8 ${T:+-H \"Authorization: Bearer $T\"} \"${U%/}/data\"";

// 2. Refresh every 3 seconds
export const refreshFrequency = 3000;

// 3. Styling
export const className = `
  bottom: 20px;
  left: 20px;
  color: #fff;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  
  .container {
    background-color: rgba(0, 0, 0, 0.6);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    border-radius: 20px; 
    padding: 8px 16px;
    border: 1px solid rgba(255, 255, 255, 0.1);
    box-shadow: 0 4px 6px rgba(0,0,0,0.1);
    
    /* HORIZONTAL LAYOUT */
    display: flex;
    flex-direction: row;
    gap: 24px;
    width: auto;
    align-items: center;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .value {
    font-size: 14px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  .icon {
    font-size: 16px;
    width: 20px; /* Fixed width for alignment */
    text-align: center;
  }
  
  .solar { color: #f59e0b; }
  .grid-import { color: #ef4444; }
  .grid-export { color: #10b981; }
  .battery-high { color: #10b981; }
  .battery-low { color: #ef4444; }
  .home { color: #3b82f6; }
  
  .error { color: #ff4444; font-size: 12px; }
`;

// 4. Render Layout
export const render = ({ output, error }) => {
  if (error) {
    return <div className="container"><div className="error">Error: {error.message}</div></div>;
  }

  if (!output) return <div className="container">Loading...</div>;

  let data;
  try {
    data = JSON.parse(output);
  } catch (e) {
    return <div className="container"><div className="error">Parse Error (Inv JSON)</div></div>;
  }

  if (!data.derived) return <div className="container">No Data</div>;

  const d = data.derived;
  const solarW = Math.round(d.solar_power_w);
  const batPct = Math.round(d.battery_percent);
  const gridW = Math.round(d.grid_flow_w);
  const homeW = Math.round(d.home_load_w);

  const batColor = batPct > 20 ? "battery-high" : "battery-low";
  const gridColor = gridW > 0 ? "grid-import" : "grid-export";
  const gridLabel = gridW > 0 ? "Import" : "Export";

  return (
    <div className="container">
      {/* Solar */}
      <div className="row" title="Produzione Solare">
        <span className="icon solar">☀️</span>
        <span className="value">{solarW} W</span>
      </div>

      {/* Battery */}
      <div className="row" title="Batteria">
        <span className={`icon ${batColor}`}>🔋</span>
        <span className="value">{batPct}%</span>
      </div>

      {/* Home Load */}
      <div className="row" title="Consumo Casa">
        <span className="icon home">🏠</span>
        <span className="value">{homeW} W</span>
      </div>

      {/* Grid */}
      <div className="row" title="Rete Elettrica">
        <span className={`icon ${gridColor}`}>⚡</span>
        <span className="value">{Math.abs(gridW)} W</span>
      </div>
    </div>
  );
};
