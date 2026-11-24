import SwiftUI

struct TradesView: View {
    @EnvironmentObject var state: AppState

    var body: some View {
        NavigationStack {
            List(state.trades) { t in
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Text("\(t.symbol.uppercased()) (\(t.kind))")
                            .font(.subheadline.bold())
                        Spacer()
                        Text(String(format: "%@%.2f", t.pnlUsd >= 0 ? "+" : "", t.pnlUsd))
                            .font(.subheadline.bold())
                            .foregroundStyle(t.pnlUsd >= 0 ? .green : .red)
                    }
                    HStack(spacing: 10) {
                        Text(String(format: "%.6g in @ %.2f", t.qty, t.entry))
                        if let exit = t.exit {
                            Text(String(format: "out @ %.2f", exit))
                        } else {
                            Text("open").foregroundColor(.cyan)
                        }
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    Text("\(t.mode) - \(t.exitReason ?? (t.status == "open" ? "running" : "-"))")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Trade history")
            .refreshable { await state.loadOnce() }
        }
    }
}
