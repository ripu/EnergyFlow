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
    let home_load_w: Double?
    let inverter_power_w: Double? 
    let battery_power_w: Double?
}

// MARK: - Custom View (The HUD Face)
class EnergyView: NSView {
    var attrText: NSAttributedString?
    var isHovering = false
    
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        for trackingArea in self.trackingAreas {
            self.removeTrackingArea(trackingArea)
        }
        
        let options: NSTrackingArea.Options = [.mouseEnteredAndExited, .activeAlways, .inVisibleRect]
        let trackingArea = NSTrackingArea(rect: self.bounds, options: options, owner: self, userInfo: nil)
        self.addTrackingArea(trackingArea)
    }
    
    override func mouseEntered(with event: NSEvent) {
        isHovering = true
        self.needsDisplay = true
    }
    
    override func mouseExited(with event: NSEvent) {
        isHovering = false
        self.needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        // Background
        let bgPath = NSBezierPath(roundedRect: bounds, xRadius: 10, yRadius: 10)
        NSColor.black.withAlphaComponent(0.85).setFill()
        bgPath.fill()
        
        NSColor.white.withAlphaComponent(0.15).setStroke()
        bgPath.lineWidth = 1
        bgPath.stroke()
        
        // Text
        guard let ms = attrText else {
            // Draw Close Button if hovering even without text
            if isHovering { drawCloseButton() }
            return
        }
        
        let size = ms.size()
        let x = (bounds.width - size.width) / 2
        let y = (bounds.height - size.height) / 2
        ms.draw(at: NSPoint(x: x, y: y))
        
        if isHovering {
            drawCloseButton()
        }
    }
    
    func drawCloseButton() {
        let btnSize: CGFloat = 14
        let xPos: CGFloat = 8 // Left side
        // Vertically centered
        let yPos = (bounds.height - btnSize) / 2
        
        let btnRect = NSRect(x: xPos, y: yPos, width: btnSize, height: btnSize)
        
        NSColor.systemRed.setFill()
        let btnPath = NSBezierPath(ovalIn: btnRect)
        btnPath.fill()
        
        // Draw X
        let xPath = NSBezierPath()
        let inset: CGFloat = 4
        xPath.move(to: NSPoint(x: btnRect.minX + inset, y: btnRect.minY + inset))
        xPath.line(to: NSPoint(x: btnRect.maxX - inset, y: btnRect.maxY - inset))
        xPath.move(to: NSPoint(x: btnRect.maxX - inset, y: btnRect.minY + inset))
        xPath.line(to: NSPoint(x: btnRect.minX + inset, y: btnRect.maxY - inset))
        
        NSColor.white.withAlphaComponent(0.8).setStroke()
        xPath.lineWidth = 1.5
        xPath.lineCapStyle = .round
        xPath.stroke()
    }
    
    func update(attrText: NSAttributedString) {
        self.attrText = attrText
        self.needsDisplay = true
    }
    
    override func mouseDown(with event: NSEvent) {
        if isHovering {
            let loc = convert(event.locationInWindow, from: nil)
            
            // Hitbox setup (Left side)
            let btnSize: CGFloat = 20
            let xPos: CGFloat = 5
            let yPos = (bounds.height - btnSize) / 2
            let btnRect = NSRect(x: xPos, y: yPos, width: btnSize, height: btnSize)
            
            if btnRect.contains(loc) {
                NSApp.terminate(nil)
                return
            }
        }
        // Allow drag
        self.window?.performDrag(with: event)
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
        let rawGrid = Int(d.grid_flow_w) // Raw logic: Pos=Export
        let inverter = Int(d.inverter_power_w ?? 0)
        let batPower = Int(d.battery_power_w ?? 0) // Pos=Charge
        
        // --- Calculations matched to Dashboard ---
        // 1. Grid Flow: Raw from API is Positive=Import, Negative=Export
        // We do NOT need to invert it anymore.
        let gridFlow = rawGrid 
        let safeGrid = abs(gridFlow) < 20 ? 0 : gridFlow
        
        // 2. Home Load = Direct from API (or fallback)
        var load = Int(d.home_load_w ?? Double(inverter + safeGrid))
        if load < 0 { load = 0 }
        
        // 3. Battery Capacity
        let batteryWh = 12000.0 // 12 kWh
        let storedWh = batteryWh * (Double(bat) / 100.0)
        var timeString = ""
        if batPower < -20 && load > 0 {
             // Time to empty = Stored / Load
             let hours = storedWh / Double(load)
             if hours < 48 {
                 let h = Int(hours)
                 let m = Int((hours - Double(h)) * 60)
                 timeString = String(format: " (%dh%02dm)", h, m)
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
            return String(format: "%.1fkW", kw) // Compact, no padding
        }
        
        let fullStr = NSMutableAttributedString()
        
        // 1. GRID
        let gridIcon = "🗼"
        var gridColor = cDim
        var gridArrow = " "
        
        if safeGrid > 20 { 
            gridArrow = "↓" // Import
            gridColor = cRed 
        } else if safeGrid < -20 {
            gridArrow = "↑" // Export
            gridColor = cGreen 
        }
        
        fullStr.append(attr("\(gridArrow)\(gridIcon)\(fmtKw(abs(safeGrid)))", gridColor))
        fullStr.append(attr(" ", cDim)) // Minimal spacer

        // 2. HOME
        fullStr.append(attr("🏠\(fmtKw(load))", cWhite))
        fullStr.append(attr(" ", cDim)) // Minimal spacer
        
        // 3. SOLAR
        let sunIcon = solar > 0 ? "☀️" : "🌙"
        fullStr.append(attr("\(sunIcon)\(fmtKw(solar))", solar > 0 ? cGreen : cDim))
        
        // 4. BATTERY
        let batIcon = bat > 20 ? "🔋" : "🪫"
        var batColor = cWhite
        var batArrow = " "
        
        // Logic: Explicit Battery Power
        if batPower > 20 {
            batArrow = "↑" // Charging
            batColor = cGreen
        } else if batPower < -20 {
             batArrow = "↓" // Discharging
             batColor = cOrange
        }
        
        fullStr.append(attr(" ", cDim)) // Reduced spacer for Battery (was 2 spaces)
        fullStr.append(attr("\(batIcon)\(bat)%\(timeString)", batColor))
        fullStr.append(attr(" \(batArrow)", batColor))
        
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
