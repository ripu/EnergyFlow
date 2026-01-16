import WidgetKit
import SwiftUI

// MARK: - Data Models
struct QuickEnergyData: Codable {
    let derived: QuickDerived
}

struct QuickDerived: Codable {
    let solar_power_w: Double
    let battery_percent: Double
    let battery_power_w: Double? // Optional in API?
    let grid_flow_w: Double
    let home_load_w: Double
    
    // Inverter might be useful but redundant for simple view
}

// MARK: - Timeline Entry
struct EnergyEntry: TimelineEntry {
    let date: Date
struct EnergyEntry: TimelineEntry {
    let date: Date
    let data: QuickEnergyData?
    let error: String?
}
    let error: String?
}

// MARK: - Provider
struct Provider: TimelineProvider {
    func placeholder(in context: Context) -> EnergyEntry {
        EnergyEntry(date: Date(), data: sampleData, error: nil)
    }

    func getSnapshot(in context: Context, completion: @escaping (EnergyEntry) -> Void) {
        completion(EnergyEntry(date: Date(), data: sampleData, error: nil))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<EnergyEntry>) -> Void) {
        let url = URL(string: "http://localhost:8003/data")!
        
        let task = URLSession.shared.dataTask(with: url) { data, response, error in
            var entry: EnergyEntry
            let currentDate = Date()
            
            // Schedule next update in 5 minutes (macOS widget budget)
            let refreshDate = Calendar.current.date(byAdding: .minute, value: 5, to: currentDate)!
            
            if let error = error {
                entry = EnergyEntry(date: currentDate, data: nil, error: error.localizedDescription)
            } else if let data = data {
                do {
                    let decodedData = try JSONDecoder().decode(QuickEnergyData.self, from: data)
                    entry = EnergyEntry(date: currentDate, data: decodedData, error: nil)
                } catch {
                    entry = EnergyEntry(date: currentDate, data: nil, error: "Decode Error")
                }
            } else {
                entry = EnergyEntry(date: currentDate, data: nil, error: "No Data")
            }
            
            let timeline = Timeline(entries: [entry], policy: .after(refreshDate))
            completion(timeline)
        }
        task.resume()
    }
    
    var sampleData: QuickEnergyData {
        QuickEnergyData(
            derived: QuickDerived(
                solar_power_w: 2500,
                battery_percent: 75,
                battery_power_w: -500,
                grid_flow_w: -1000,
                home_load_w: 1000
            )
        )
    }
}

// MARK: - Widget View
struct EnergyFlowWidgetEntryView : View {
    var entry: Provider.Entry

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("EnergyFlow")
                    .font(.system(size: 10, weight: .bold))
                    .foregroundColor(.secondary)
                Spacer()
                Text(entry.date, style: .time)
                    .font(.caption2)
                    .foregroundColor(.secondary)
            }
            
            if let error = entry.error {
                Text("Offline: \(error)")
                    .font(.caption)
                    .foregroundColor(.red)
            } else if let root = entry.data {
                let data = root.derived
                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 12) {
                    
                    // Solar
                    StatusCard(
                        icon: "sun.max.fill",
                        color: .orange,
                        value: "\(Int(data.solar_power_w)) W",
                        label: "Produzione"
                    )
                    
                    // Home
                    StatusCard(
                        icon: "house.fill",
                        color: .blue,
                        value: "\(Int(data.home_load_w)) W",
                        label: "Consumo"
                    )
                    
                    // Battery
                    StatusCard(
                        icon: "battery.100",
                        color: .green,
                        value: "\(Int(data.battery_percent))%",
                        label: (data.battery_power_w ?? 0) > 0 ? "Carica" : "Scarica"
                    )
                    
                    // Grid
                    StatusCard(
                        icon: "bolt.fill",
                        color: data.grid_flow_w > 0 ? .red : .green,
                        value: "\(abs(Int(data.grid_flow_w))) W",
                        label: data.grid_flow_w > 0 ? "Import" : "Export"
                    )
                }
            } else {
                Text("Caricamento...")
            }
        }
        .padding()
        .containerBackground(for: .widget) {
            Color(NSColor.windowBackgroundColor)
        }
    }
}

struct StatusCard: View {
    let icon: String
    let color: Color
    let value: String
    let label: String
    
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Image(systemName: icon)
                    .foregroundColor(color)
                Spacer()
            }
            
            Text(value)
                .font(.system(size: 16, weight: .bold))
            
            Text(label)
                .font(.caption2)
                .foregroundColor(.secondary)
        }
        .padding(8)
        .background(Color.black.opacity(0.05))
        .cornerRadius(8)
    }
}

// MARK: - Main Configuration
@main
struct EnergyFlowWidget: Widget {
    let kind: String = "EnergyFlowWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: Provider()) { entry in
            EnergyFlowWidgetEntryView(entry: entry)
        }
        .configurationDisplayName("Energy Monitor")
        .description("Monitor your solar flow.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

// Preview Provider (Xcode)
struct EnergyFlowWidget_Previews: PreviewProvider {
    static var previews: some View {
        EnergyFlowWidgetEntryView(entry: EnergyEntry(date: Date(), data: nil, error: nil))
            .previewContext(WidgetPreviewContext(family: .systemSmall))
    }
}
