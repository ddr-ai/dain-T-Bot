import SwiftUI

struct ActivityView: View {
    @EnvironmentObject var state: AppState

    var body: some View {
        NavigationStack {
            List(state.activity) { item in
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Text(dateStr(item.ts))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text(item.kind.uppercased())
                            .font(.caption2.bold())
                            .padding(.horizontal, 6).padding(.vertical, 2)
                            .background(tagColor(item.kind).opacity(0.18), in: RoundedRectangle(cornerRadius: 5))
                            .foregroundStyle(tagColor(item.kind))
                    }
                    Text(item.msg)
                        .font(.footnote)
                }
            }
            .navigationTitle("Activity")
            .refreshable { await state.loadOnce() }
        }
    }

    private func dateStr(_ ts: Double) -> String {
        Date(timeIntervalSince1970: ts / 1000).formatted(date: .abbreviated, time: .shortened)
    }

    private func tagColor(_ kind: String) -> Color {
        switch kind {
        case "enter", "exit": return .cyan
        case "breaker", "emergency", "error": return .red
        case "stop", "protect": return .orange
        default: return .gray
        }
    }
}
