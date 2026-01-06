// EnergyFlow Widget for Scriptable
// To use: Copy code -> Open Scriptable -> New Script -> Paste -> Add Widget to Desktop

const API_URL = "http://localhost:8003/data";
const CACHE_KEY = "energy_flow_cache";

// --- Main Logic ---
let data = await fetchData();
let widget = await createWidget(data);

if (!config.runsInWidget) {
    await widget.presentMedium();
}

Script.setWidget(widget);
Script.complete();

// --- Functions ---

async function fetchData() {
    try {
        let req = new Request(API_URL);
        req.timeoutInterval = 3; // Short timeout for local
        let json = await req.loadJSON();
        // Cache successful data
        Keychain.set(CACHE_KEY, JSON.stringify(json));
        return json;
    } catch (e) {
        console.log("Fetch failed: " + e.message);
        // Try fallback to cache
        if (Keychain.contains(CACHE_KEY)) {
            let cached = Keychain.get(CACHE_KEY);
            return JSON.parse(cached);
        }
        return null;
    }
}

async function createWidget(data) {
    let w = new ListWidget();
    w.backgroundColor = new Color("#1a1a1a");

    // Header
    let headerStack = w.addStack();
    headerStack.centerAlignContent();

    let title = headerStack.addText("Energy Flow");
    title.font = Font.boldSystemFont(12);
    title.textColor = new Color("#888888");

    headerStack.addSpacer();

    let time = headerStack.addText(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    time.font = Font.systemFont(10);
    time.textColor = new Color("#666666");

    w.addSpacer(12);

    if (!data) {
        let err = w.addText("Offline / No Data");
        err.textColor = Color.red();
        return w;
    }

    // Grid Layout (2x2)
    let row1 = w.addStack();
    await addCard(row1, "sun.max.fill", Color.orange(), Math.round(data.solar.power_w) + " W", "Produzione");
    row1.addSpacer(8);
    await addCard(row1, "house.fill", Color.blue(), Math.round(data.home.power_w) + " W", "Consumo");

    w.addSpacer(8);

    let row2 = w.addStack();

    // Battery Status Logic
    let batIcon = "battery.100";
    let batColor = Color.green();
    let batLabel = "Standby";
    if (data.battery.power_w < -10) batLabel = "Carica";
    if (data.battery.power_w > 10) batLabel = "Scarica";

    await addCard(row2, batIcon, batColor, Math.round(data.battery.percent) + "%", batLabel);

    row2.addSpacer(8);

    // Grid Status Logic
    let gridIcon = "bolt.fill";
    let gridColor = data.grid.flow_w > 0 ? Color.red() : Color.purple();
    let gridLabel = data.grid.flow_w > 0 ? "Import" : "Export";

    await addCard(row2, gridIcon, gridColor, Math.abs(Math.round(data.grid.flow_w)) + " W", gridLabel);

    return w;
}

async function addCard(stack, iconName, color, valueText, labelText) {
    let card = stack.addStack();
    card.layoutVertically();
    card.backgroundColor = new Color("#2c2c2e");
    card.cornerRadius = 8;
    card.setPadding(8, 8, 8, 8);
    // Force equal width
    card.size = new Size(0, 60);

    // Icon
    let sf = SFSymbol.named(iconName);
    let img = card.addImage(sf.image);
    img.imageSize = new Size(16, 16);
    img.tintColor = color;

    card.addSpacer(4);

    // Value
    let val = card.addText(valueText);
    val.font = Font.boldSystemFont(14);
    val.textColor = Color.white();

    // Label
    let lab = card.addText(labelText);
    lab.font = Font.systemFont(10);
    lab.textColor = Color.gray();
}
