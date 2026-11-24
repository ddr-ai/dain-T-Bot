import SwiftUI

struct WatchlistView: View {
    @EnvironmentObject var state: AppState

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(Array((state.status?.prices ?? [:]).keys).sorted(), id: \.self) { symbol in
                        HStack {
                            Text(symbol.uppercased())
                                .font(.headline)
                            Spacer()
                            VStack(alignment: .trailing) {
                                Text(price(symbol))
                                    .font(.title3.bold())
                                Text(time(symbol))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                } footer: {
                    Text("Prices stream live over WebSocket from Gemini market data.")
                }
            }
            .navigationTitle("Watchlist")
            .refreshable { await state.loadOnce() }
        }
    }

    private func price(_ symbol: String) -> String {
        guard let t = state.status?.prices[symbol] else { return "-" }
        if t.price >= 1000 { return String(format: "$%.0f", t.price) }
        if t.price >= 1 { return String(format: "$%.2f", t.price) }
        return String(format: "$%.4f", t.price)
    }

    private func time(_ symbol: String) -> String {
        guard let t = state.status?.prices[symbol] else { return "" }
        let date = Date(timeIntervalSince1970: t.at / 1000)
        return date.formatted(date: .omitted, time: .standard)
    }
}
