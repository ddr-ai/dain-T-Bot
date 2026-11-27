import SwiftUI

struct SettingsView: View {
    @EnvironmentObject var state: AppState
    @State private var apiKey = ""
    @State private var apiSecret = ""
    @State private var token = ""
    @State private var backend = ""

    var body: some View {
        NavigationStack {
            Form {
                if let s = state.settings {
                    Section("Trading mode") {
                        Toggle(s.paper ? "PAPER (simulated)" : "LIVE (real funds)", isOn: Binding(
                            get: { s.paper },
                            set: { paper in Task { await state.toggleMode(paper: paper) } }
                        ))
                        .tint(s.paper ? .cyan : .red)
                        if !s.paper {
                            Text("LIVE trades real money automatically. Validate in paper first!")
                                .font(.caption)
                                .foregroundStyle(.red)
                        }
                    }

                    Section("Risk") {
                        Stepper(value: Binding(
                            get: { s.riskPct },
                            set: { v in Task { await state.updateSetting(patch: ["riskPct": v]) } }
                        ), in: 0.1...(s.maxRiskPct ?? 3), step: 0.1) {
                            Text(String(format: "Risk per trade: %.1f%%", s.riskPct))
                        }
                        Stepper(value: Binding(
                            get: { Double(s.maxTradesPerSymbolPerDay) },
                            set: { v in Task { await state.updateSetting(patch: ["maxTradesPerSymbolPerDay": Int(v)]) } }
                        ), in: 1...10) {
                            Text("Max trades/symbol/day: \(s.maxTradesPerSymbolPerDay)")
                        }
                        Stepper(value: Binding(
                            get: { s.dailyLossWarnPct },
                            set: { v in Task { await state.updateSetting(patch: ["dailyLossWarnPct": v]) } }
                        ), in: 0.5...10, step: 0.5) {
                            Text(String(format: "Daily loss warning: %.1f%%", s.dailyLossWarnPct))
                        }
                        Stepper(value: Binding(
                            get: { s.dailyLossLimitPct },
                            set: { v in Task { await state.updateSetting(patch: ["dailyLossLimitPct": v]) } }
                        ), in: 1...15, step: 0.5) {
                            Text(String(format: "Daily flatten limit: %.1f%%", s.dailyLossLimitPct))
                        }
                    }

                    Section("Notifications") {
                        Toggle("Fills and exits", isOn: Binding(
                            get: { s.notifyFills },
                            set: { v in Task { await state.updateSetting(patch: ["notifyFills": v]) } }
                        ))
                        Toggle("Stop / breakeven moves", isOn: Binding(
                            get: { s.notifyStops },
                            set: { v in Task { await state.updateSetting(patch: ["notifyStops": v]) } }
                        ))
                        Toggle("Circuit breaker events", isOn: Binding(
                            get: { s.notifyBreaker },
                            set: { v in Task { await state.updateSetting(patch: ["notifyBreaker": v]) } }
                        ))
                    }
                }

                Section("Gemini API credentials") {
                    if let s = state.status {
                        Label(s.hasCredentials ? "Credentials configured on backend" : "No credentials (paper mode OK)",
                              systemImage: s.hasCredentials ? "checkmark.circle.fill" : "xmark.circle")
                            .font(.callout)
                    }
                    SecureField("API key", text: $apiKey)
                        .textInputAutocapitalization(.never)
                    SecureField("API secret", text: $apiSecret)
                        .textInputAutocapitalization(.never)
                    Button("Save credentials") {
                        // Capture the typed values into locals FIRST: a Task
                        // reads @State when it RUNS, so clearing the fields
                        // before spawning it sends empty strings to the server.
                        let k = apiKey
                        let s = apiSecret
                        apiKey = ""
                        apiSecret = ""
                        Task { await state.saveCredentials(key: k, secret: s) }
                    }
                    .disabled(apiKey.count < 10 || apiSecret.count < 10)
                    Button("Remove credentials", role: .destructive) {
                        Task { await state.removeCredentials() }
                    }
                    Text("Key needs Balances + Orders permissions only. WITHDRAWALS MUST BE DISABLED on the Gemini key.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Section("Backend connection") {
                    TextField("Backend URL", text: $backend)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                    SecureField("API bearer token (optional)", text: $token)
                        .textInputAutocapitalization(.never)
                    Button("Save connection") {
                        state.setBackend(backend, token: token)
                    }
                    .disabled(backend.isEmpty)
                }

                Section {
                    Text("Weekly reset: daily counters and P&L tracking reset at 00:00 UTC automatically.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text("The bot holds a key that cannot withdraw. You can always pull funds from Gemini directly.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } header: {
                    Text("About")
                }
            }
            .navigationTitle("Settings")
            .onAppear {
                backend = state.backendURL
                token = state.token
            }
        }
    }
}
