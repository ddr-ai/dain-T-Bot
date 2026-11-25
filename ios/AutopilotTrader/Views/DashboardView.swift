import SwiftUI
import Charts

struct DashboardView: View {
    @EnvironmentObject var state: AppState
    @State private var confirmStop = false
    @State private var sliderValue: Double = 1.5
    @State private var runMinutes: Int = 1440

    private static let durationOptions: [(Int, String)] = [
        (60, "1 hour"), (180, "3 hours"), (360, "6 hours"), (720, "12 hours"),
        (1440, "24 hours"), (4320, "3 days"), (10080, "7 days")
    ]

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 14) {
                    if let s = state.status {
                        header(s)
                        runControl(s)
                        statCards(s)
                        riskSlider(s)
                        positionsSection(s)
                        performanceSection
                        emergencyButton
                    } else {
                        ProgressView("Connecting to engine...")
                    }
                }
                .padding()
            }
            .background(Color(.systemGroupedBackground))
            .navigationTitle("Autopilot")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        Task { await state.refreshAll() }
                    } label: { Image(systemName: "arrow.clockwise") }
                }
            }
            .task {
                if let st = state.settings { sliderValue = st.riskReward }
            }
            .onChange(of: state.settings?.riskReward ?? 0) { v in sliderValue = v }
        }
        .overlay(alignment: .top) {
            if let toast = state.toast {
                Text(toast)
                    .font(.footnote)
                    .padding(10)
                    .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 10))
                    .padding(.top, 8)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
    }

    private func header(_ s: APIStatus) -> some View {
        VStack(spacing: 10) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Autopilot \(s.autopilotOn ? "ON" : "OFF")")
                        .font(.title2.bold())
                    Text(statusLine(s))
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Text(s.mode == "live" ? "LIVE MODE" : "PAPER MODE")
                    .font(.caption.bold())
                    .padding(.horizontal, 10).padding(.vertical, 5)
                    .background((s.mode == "live" ? Color.red : Color.cyan).opacity(0.2), in: Capsule())
                    .foregroundStyle(s.mode == "live" ? .red : .cyan)
            }
            HStack(spacing: 8) {
                Text(state.wsConnected ? "live feed" : "polling")
                    .font(.caption.bold())
                    .padding(.horizontal, 8).padding(.vertical, 5)
                    .background((state.wsConnected ? Color.green : Color.orange).opacity(0.2), in: Capsule())
                    .foregroundStyle(state.wsConnected ? .green : .orange)
                if s.hasCredentials {
                    Text("Gemini key saved")
                        .font(.caption.bold())
                        .padding(.horizontal, 8).padding(.vertical, 5)
                        .background(Color.green.opacity(0.2), in: Capsule())
                        .foregroundStyle(.green)
                } else {
                    Text("no Gemini key")
                        .font(.caption.bold())
                        .padding(.horizontal, 8).padding(.vertical, 5)
                        .background(Color.orange.opacity(0.2), in: Capsule())
                        .foregroundStyle(.orange)
                }
                if s.runActive == true, let ends = s.runEndsAt, ends > 0 {
                    Text("ends " + Self.hm.string(from: Date(timeIntervalSince1970: ends / 1000)))
                        .font(.caption.bold())
                        .padding(.horizontal, 8).padding(.vertical, 5)
                        .background(Color.cyan.opacity(0.2), in: Capsule())
                        .foregroundStyle(.cyan)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding()
        .background(RoundedRectangle(cornerRadius: 16).fill(s.autopilotOn ? Color.green.opacity(0.08) : Color(.secondarySystemBackground)))
    }

    // The headline control: pick a duration, START the run, watch the
    // countdown, STOP it whenever you like. The engine keeps running on the
    // server even with the app closed.
    private func runControl(_ s: APIStatus) -> some View {
        let active = (s.runActive ?? false) && s.autopilotOn
        return VStack(spacing: 12) {
            if active {
                VStack(spacing: 4) {
                    Text(Self.runCountdown(s))
                        .font(.system(size: 34, weight: .bold, design: .monospaced))
                        .foregroundStyle(.green)
                    Text("remaining in run of " + Self.humanDuration(s.runMinutes ?? runMinutes))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity)
            } else {
                Menu {
                    ForEach(durationOptions, id: \.0) { mins, label in
                        Button {
                            runMinutes = mins
                        } label: {
                            if runMinutes == mins { Label(label, systemImage: "checkmark") } else { Text(label) }
                        }
                    }
                } label: {
                    HStack {
                        Image(systemName: "clock")
                        Text("Run for: " + Self.humanDuration(runMinutes))
                        Image(systemName: "chevron.up.chevron.down")
                    }
                    .font(.subheadline.bold())
                    .frame(maxWidth: .infinity, minHeight: 44)
                }
            }

            Button {
                Task {
                    if active { await state.stopRun() } else { await state.startRun(minutes: runMinutes) }
                }
            } label: {
                Text(active ? "STOP RUN" : "START RUN")
                    .font(.title3.bold())
                    .frame(maxWidth: .infinity, minHeight: 54)
            }
            .buttonStyle(.borderedProminent)
            .tint(active ? .red : .green)
            Text(active
                 ? "Tapping STOP ends new entries; open positions keep being managed until they close."
                 : "START runs the engine on the server for the chosen window. You can close the app.")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding()
        .background(RoundedRectangle(cornerRadius: 16).fill(Color(.secondarySystemBackground)))
    }

    private static let hm: DateFormatter = {
        let f = DateFormatter()
        f.dateStyle = .none
        f.timeStyle = .short
        return f
    }()

    private static func humanDuration(_ minutes: Int) -> String {
        durationOptions.first(where: { $0.0 == minutes })?.1 ?? "\(minutes / 60) hours"
    }

    private static func runCountdown(_ s: APIStatus) -> String {
        let ms = max(0, Int(s.runRemainingMs ?? 0))
        let h = ms / 3_600_000
        let m = (ms % 3_600_000) / 60_000
        let sec = (ms % 60_000) / 1000
        if h > 0 { return String(format: "%02d:%02d:%02d", h, m, sec) }
        if m > 0 { return String(format: "%02d:%02d", m, sec) }
        return String(format: "%02ds", sec)
    }

    private func statusLine(_ s: APIStatus) -> String {
        if s.guardLock { return "Circuit breaker tripped - a fresh RUN resets it" }
        if s.haltNew { return "New entries paused today (\(s.haltReason ?? "")); positions managed" }
        if !s.autopilotOn { return "Off - scanning paused" }
        if !s.stalePrices.isEmpty { return "Scanning paused - stale prices: \(s.stalePrices.joined(separator: ", "))" }
        if !s.positions.isEmpty { return "Managing \(s.positions.count) open position\(s.positions.count > 1 ? "s" : ""), scanning" }
        return "Scanning for setups..."
    }

    private func statCards(_ s: APIStatus) -> some View {
        LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
            StatCard(title: "Equity", value: s.equity, format: .money)
            StatCard(title: "Cash available", value: s.usdAvailable, format: .money)
            StatCard(title: "Today P&L", value: s.pnlToday, format: .signed, suffix: String(format: " (%.1f%%)", s.pnlTodayPct))
            StatCard(title: "Day started at", value: s.dayStartEquity, format: .money)
        }
    }

    private func riskSlider(_ s: APIStatus) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Risk:reward slider").font(.headline)
                Spacer()
                Text("\(sliderValue, specifier: "%.1f")x").font(.title3.bold())
            }
            Text("Adjusts the take-profit distance only. Position size and stops stay risk-capped.")
                .font(.caption)
                .foregroundStyle(.secondary)
            Slider(
                value: $sliderValue,
                in: (state.settings?.riskRewardMin ?? 0.5)...(state.settings?.riskRewardMax ?? 3.0),
                step: 0.1
            ) { editing in
                if !editing { Task { await state.setRiskReward(sliderValue) } }
            }
        }
        .padding()
        .background(RoundedRectangle(cornerRadius: 16).fill(Color(.secondarySystemBackground)))
    }

    private func positionsSection(_ s: APIStatus) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Open positions (\(s.positions.count))").font(.headline)
            ForEach(s.positions) { p in
                PositionRow(p: p)
            }
            if s.positions.isEmpty {
                Text("No positions. The bot enters automatically when its setup fires.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding()
        .background(RoundedRectangle(cornerRadius: 16).fill(Color(.secondarySystemBackground)))
    }

    private var performanceSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Performance").font(.headline)
            if let p = state.perf {
                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 8) {
                    StatCard(title: "Win rate", value: (p.winRate ?? 0) * 100, format: .plain, suffix: "%", digits: 0)
                    StatCard(title: "Profit factor", value: p.profitFactor ?? 0, format: .plain, digits: 2)
                    StatCard(title: "Max drawdown", value: p.maxDrawdown, format: .money)
                    StatCard(title: "Fees paid", value: p.feesPaid, format: .money)
                }
                if p.equityCurve.count > 2 {
                    Chart(p.equityCurve, id: \.self) { v in
                        LineMark(x: .value("n", try! p.equityCurve.firstIndex(of: v) ?? 0), y: .value("USD", v))
                            .foregroundStyle(.cyan.gradient)
                    }
                    .frame(height: 80)
                    .chartXAxis(.hidden)
                }
                Text("\(p.trades) closed trades").font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding()
        .background(RoundedRectangle(cornerRadius: 16).fill(Color(.secondarySystemBackground)))
    }

    private var emergencyButton: some View {
        Button {
            if confirmStop {
                Task { await state.emergencyStop() }
                confirmStop = false
            } else {
                confirmStop = true
                Task {
                    try? await Task.sleep(nanoseconds: 5_000_000_000)
                    confirmStop = false
                }
            }
        } label: {
            Text(confirmStop ? "Tap again: cancel all, flatten, halt" : "EMERGENCY STOP ALL")
                .font(.headline)
                .frame(maxWidth: .infinity, minHeight: 54)
        }
        .buttonStyle(.borderedProminent)
        .tint(.red)
    }
}

enum StatFormat { case money, plain, signed }

struct StatCard: View {
    let title: String
    let value: Double
    let format: StatFormat
    var suffix: String = ""
    var digits: Int = 2

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.caption).foregroundStyle(.secondary)
            Text(display)
                .font(.title3.bold())
                .foregroundStyle(color)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 12).fill(Color(.tertiarySystemBackground)))
    }

    private var display: String {
        switch format {
        case .money: return "$" + String(format: "%.\(digits)f", value) + suffix
        case .plain: return String(format: "%.\(digits)f", value) + suffix
        case .signed: return (value >= 0 ? "+$" : "-$") + String(format: "%.\(digits)f", abs(value)) + suffix
        }
    }

    private var color: Color {
        if format == .signed { return value >= 0 ? .green : .red }
        return .primary
    }
}

struct PositionRow: View {
    let p: APIPosition

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text("\(p.symbol.uppercased()) long").font(.subheadline.bold())
                Spacer()
                Text(p.unrealizedPnl.map { String(format: "%@%.2f", $0 >= 0 ? "+" : "", $0) } ?? "-")
                    .font(.subheadline.bold())
                    .foregroundStyle((p.unrealizedPnl ?? 0) >= 0 ? .green : .red)
            }
            HStack(spacing: 12) {
                Text(entryLine)
                Text("stop \(p.stop, specifier: "%.2f")")
                Text("target \(p.target, specifier: "%.2f")")
            }
            .font(.caption2)
            .foregroundStyle(.secondary)
            HStack(spacing: 12) {
                Text(p.kind)
                Text(String(format: "risk $%.2f", p.riskUsd))
                if p.breakevenDone { Text("breakeven ✅").foregroundColor(.green) }
            }
            .font(.caption2)
            .foregroundStyle(.secondary)
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color(.tertiarySystemBackground)))
    }

    private var entryLine: String {
        let qty = String(format: "%.6g", p.remainingQty)
        return String(format: "%@ @ %.2f", qty, p.entry)
    }
}
