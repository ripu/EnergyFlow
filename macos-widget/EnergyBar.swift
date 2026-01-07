import Cocoa
import Foundation

// MARK: - Config
let API_URL = "http://127.0.0.1:8003/data"

// MARK: - Models
struct EnergyData: Codable { let derived: DerivedData }
struct DerivedData: Codable {
    let solar_power_w: Double
    let battery_percent: Double
    let grid_flow_w: Double
    let inverter_power_w: Double? 
}

// MARK: - Custom View (The HUD Face)
class EnergyView: NSView {
    var attrText: NSAttributedString?
    
    override func draw(_ dirtyRect: NSRect) {
        // Background
        let bgPath = NSBezierPath(roundedRect: bounds, xRadius: 10, yRadius: 10)
        NSColor.black.withAlphaComponent(0.85).setFill()
        bgPath.fill()
        
        NSColor.white.withAlphaComponent(0.15).setStroke()
        bgPath.lineWidth = 1
        bgPath.stroke()
        
        // Text
        guard let ms = attrText else { return }
        
        let size = ms.size()
        let x = (bounds.width - size.width) / 2
        let y = (bounds.height - size.height) / 2
        ms.draw(at: NSPoint(x: x, y: y))
    }
    
    func update(attrText: NSAttributedString) {
        self.attrText = attrText
        self.needsDisplay = true
    }
}

// MARK: - Draggable Window
class HUDWindow: NSPanel {
    override var canBecomeKey: Bool { return true }
    override func sendEvent(_ event: NSEvent) { super.sendEvent(event) }
    override func mouseDragged(with event: NSEvent) { self.performDrag(with: event) }
}

// MARK: - App Delegate
class AppDelegate: NSObject, NSApplicationDelegate {
    var window: HUDWindow!
    var hudView: EnergyView! // Explicitly unwrapped
    var timer: Timer?
    var lastUpdate: Date = Date.distantPast
    
    func applicationDidFinishLaunching(_ notification: Notification) {
        log("HUD Started (Colored Flow Mode + Check)")
        
        let w: CGFloat = 340 
        let h: CGFloat = 44
        let rect = NSRect(x: 100, y: 100, width: w, height: h)
        
        window = HUDWindow(
            contentRect: rect,
            styleMask: [.borderless, .nonactivatingPanel], 
            backing: .buffered,
            defer: false
        )
        
        window.level = .floating 
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = true
        window.isMovableByWindowBackground = true 
        
        hudView = EnergyView(frame: NSRect(x: 0, y: 0, width: w, height: h))
        window.contentView = hudView
        
        window.makeKeyAndOrderFront(nil)
        
        fetchData()
        
        // Timer checks data and also connection health
        timer = Timer.scheduledTimer(withTimeInterval: 3.0, repeats: true) { _ in 
            self.fetchData()
            self.checkConnection()
        }
    }

    @objc func fetchData() {
        guard let url = URL(string: API_URL) else { return }
        let task = URLSession.shared.dataTask(with: url) { data, response, error in
            if let _ = error {
                DispatchQueue.main.async { self.showLoading() }
                return
            }
            
            if let data = data, let decoded = try? JSONDecoder().decode(EnergyData.self, from: data) {
                DispatchQueue.main.async { 
                    self.lastUpdate = Date()
                    self.updateUI(data: decoded) 
                }
            } else {
                 DispatchQueue.main.async { self.showLoading() }
            }
        }
        task.resume()
    }
    
    func checkConnection() {
        // If no data for 6+ seconds, show loading
        if Date().timeIntervalSince(lastUpdate) > 6.0 {
            showLoading()
        }
    }
    
    func showLoading() {
        // Ensure white text
        let font = NSFont.monospacedSystemFont(ofSize: 13, weight: .bold)
        let attrText = NSAttributedString(string: "⏳ Connecting...", attributes: [
            .font: font, 
            .foregroundColor: NSColor.white // Explicit White
        ])
        hudView.update(attrText: attrText)
        
        // Reset/Standard width
        if window.frame.width > 200 {
             var frame = window.frame
             frame.size.width = 160
             window.setFrame(frame, display: true)
        }
    }

    func updateUI(data: EnergyData) {
        let d = data.derived
        let solar = Int(d.solar_power_w)
        let bat = Int(d.battery_percent)
        let grid = Int(d.grid_flow_w)
        let inverter = Int(d.inverter_power_w ?? 0)
        
        // --- Calculations ---
        let safeGrid = abs(grid) < 50 ? 0 : grid
        var load = inverter + safeGrid
        if load < 0 { load = 0 }
        
        let batteryWh = 5120.0
        let storedWh = batteryWh * (Double(bat) / 100.0)
        var timeString = ""
        if load > 200 { // Only show time if significant load
            let hours = storedWh / Double(load)
            if hours < 24 {
                let h = Int(hours)
                let m = Int((hours - Double(h)) * 60)
                timeString = " (\(h)h\(m))"
            }
        }

        // --- Flow State Determination ---
        let cWhite = NSColor.white
        let cGreen = NSColor.green
        let cOrange = NSColor.orange
        let cRed = NSColor.systemRed
        let cDim = NSColor.lightGray
        
        let font = NSFont.monospacedSystemFont(ofSize: 13, weight: .bold)
        
        func attr(_ s: String, _ c: NSColor) -> NSAttributedString {
            return NSAttributedString(string: s, attributes: [.font: font, .foregroundColor: c])
        }
        
        func fmtKw(_ w: Int) -> String {
            let kw = Double(w) / 1000.0
            return String(format: "%6.3fkW", kw)
        }
        
        let fullStr = NSMutableAttributedString()
        
        // 1. HOME
        fullStr.append(attr("🏠 \(fmtKw(load))  ", cWhite))
        
        // 2. SOLAR
        let sunIcon = solar > 0 ? "☀️" : "🌙"
        fullStr.append(attr("\(sunIcon) \(fmtKw(solar))", solar > 0 ? cGreen : cDim))
        
        // Solar Arrow
        if solar > 10 {
            fullStr.append(attr(" → ", cGreen))
        } else {
            fullStr.append(attr("   ", cDim))
        }
        
        // 3. BATTERY
        let batIcon = bat > 20 ? "🔋" : "🪫"
        var batColor = cWhite
        var batArrow = " "
        
        // Heuristic: Net Battery Flow
        if solar > load + 100 {
            batArrow = "↑" // Charging
            batColor = cGreen
        } else if load > solar + 50 && bat > 0 {
            batArrow = "↓" // Discharging
            batColor = cOrange
        }
        
        fullStr.append(attr("\(batIcon) \(bat)%\(timeString)", batColor))
        fullStr.append(attr(" \(batArrow) ", batColor))
        
        // 4. GRID
        let gridIcon = "🗼"
        var gridColor = cDim
        var gridArrow = " "
        
        if safeGrid > 50 { 
            gridArrow = "↓" // Import
            gridColor = cRed 
        } else if safeGrid < -50 {
            gridArrow = "↑" // Export
            gridColor = cGreen 
        }
        
        fullStr.append(attr("\(gridArrow) \(gridIcon) \(fmtKw(abs(grid)))", gridColor))
        
        log("HUD Updated")
        
        // Resize
        let newWidth = fullStr.size().width + 40
        if abs(window.frame.width - newWidth) > 5 {
             var frame = window.frame
             frame.size.width = newWidth
             window.setFrame(frame, display: true)
        }
        
        hudView.update(attrText: fullStr)
    }
}

func log(_ message: String) {
    print("\(Date()): \(message)")
    fflush(stdout)
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
