import Foundation
import SwiftUI
import UserNotifications

// Central app state: REST polling + WebSocket push + local notifications.

@MainActor
final class AppState: ObservableObject {
    @Published var status: APIStatus?
    @Published var settings: APISettings?
    @Published var activity: [APIActivity] = []
    @Published var trades: [APITrade] = []
    @Published var perf: APIPerformance?
    @Published var backendURL: String = AppSettings.backendURL
    @Published var token: String = AppSettings.token
    @Published var lastError: String?
    @Published var toast: String?
    @Published var wsConnected = false

    private var client: APIClient?
    private var wsTask: URLSessionWebSocketTask?
    private var pollTask: Task<Void, Never>?

    var hasBackend: Bool { !backendURL.isEmpty }

    func makeClient() -> APIClient? {
        guard let url = URL(string: backendURL) else { return nil }
        return APIClient(baseURL: url, token: token)
    }

    func setBackend(_ url: String, token newToken: String) {
        backendURL = url.trimmingCharacters(in: .whitespacesAndNewlines)
        AppSettings.backendURL = backendURL
        token = newToken
        AppSettings.token = newToken
        client = nil
        refreshAll()
    }

    private func ensureClient() -> APIClient? {
        if client === nil { client = makeClient() }
        return client
    }

    func refreshAll() {
        pollTask?.cancel()
        pollTask = Task { [weak self] in
            guard let self = self else { return }
            await self.loadOnce()
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 12_000_000_000)
                if Task.isCancelled { break }
                await self.loadOnce()
            }
        }
    }

    func loadOnce() async {
        guard let c = ensureClient() else { return }
        do {
            let s = try await c.status()
            let set = try await c.settings()
            let a = try await c.activity()
            let t = try await c.trades()
            let p = try await c.performance()
            if !Task.isCancelled {
                status = s
                settings = set
                activity = a
                trades = t
                perf = p
                lastError = nil
            }
        } catch {
            lastError = error.localizedDescription
        }
    }

    // MARK: actions
    func toggleAutopilot() async {
        guard let c = ensureClient(), let s = status else { return }
        do {
            try await c.setAutopilot(!s.autopilotOn)
            showToast(s.autopilotOn ? "Autopilot OFF" : "Autopilot ON - it acts on its own now")
        } catch { showToast("Failed: " + error.localizedDescription) }
        await loadOnce()
    }

    // MARK: run-window flow (hosted engine)
    func startRun(minutes: Int) async {
        guard let c = ensureClient() else { return }
        do {
            try await c.startRun(minutes: minutes)
            let h = Double(minutes) / 60
            showToast(String(format: "RUN STARTED for %.1f hours - live autopilot running on the server", h))
        } catch { showToast("Start failed: " + error.localizedDescription) }
        await loadOnce()
    }

    func stopRun() async {
        guard let c = ensureClient() else { return }
        do {
            try await c.stopRun()
            showToast("Run stopped. Open positions keep being managed until they close.")
        } catch { showToast("Stop failed: " + error.localizedDescription) }
        await loadOnce()
    }

    func setRiskReward(_ v: Double) async {
        settings?.riskReward = v
        guard let c = ensureClient() else { return }
        do { try await c.updateSettings(["riskReward": v]) } catch {
            showToast("Slider save failed")
        }
    }

    func emergencyStop() async {
        guard let c = ensureClient() else { return }
        do {
            try await c.emergencyStop()
            showToast("Emergency stop: orders cancelled, everything flattened")
        } catch { showToast("Emergency stop failed: " + error.localizedDescription) }
        await loadOnce()
    }

    func saveCredentials(key: String, secret: String) async {
        guard let c = ensureClient() else { return }
        do {
            try await c.saveCredentials(key: key, secret: secret)
            showToast("Credentials saved (encrypted at rest)")
            await loadOnce()
        } catch { showToast("Save failed: " + error.localizedDescription) }
    }

    func removeCredentials() async {
        guard let c = ensureClient() else { return }
        do {
            try await c.deleteCredentials()
            showToast("Credentials removed")
            await loadOnce()
        } catch { showToast("Remove failed: " + error.localizedDescription) }
    }

    func toggleMode(paper: Bool) async {
        guard let c = ensureClient() else { return }
        do {
            try await c.updateSettings(["paper": paper])
            showToast(paper ? "Switched to PAPER mode" : "Switched to LIVE mode")
        } catch { showToast("Mode switch failed: " + error.localizedDescription) }
        await loadOnce()
    }

    func updateSetting(patch: [String: Any]) async {
        guard let c = ensureClient() else { return }
        do { try await c.updateSettings(patch) } catch {
            showToast("Update failed: " + error.localizedDescription)
        }
        await loadOnce()
    }

    func showToast(_ msg: String) {
        toast = msg
        Task {
            try? await Task.sleep(nanoseconds: 3_500_000_000)
            toast = nil
        }
    }

    // MARK: websocket
    private var wsFailures = 0
    private var wsReconnectTask: Task<Void, Never>?

    func connectWebSocket() {
        guard let base = URL(string: backendURL) else { return }
        var comps = URLComponents(url: base, resolvingAgainstBaseURL: false)!
        comps.scheme = comps.scheme == "https" ? "wss" : "ws"
        comps.path = "/ws"
        guard let wsURL = comps.url else { return }
        wsReconnectTask?.cancel()
        let task = URLSession.shared.webSocketTask(with: wsURL)
        wsTask = task
        task.resume()
        wsConnected = true
        wsFailures = 0
        receiveLoop()
        startHeartbeat()
    }

    // Reconnect with capped backoff: 2s -> 5s -> 12s -> 30s, stops after 5
    // straight failures (REST polling keeps the dashboard fresh anyway).
    private func scheduleWSReconnect() {
        guard wsReconnectTask == nil else { return }
        wsReconnectTask = Task { [weak self] in
            guard let self = self else { return }
            self.wsFailures += 1
            guard self.wsFailures <= 5 else { self.wsConnected = false; self.wsReconnectTask = nil; return }
            let delays: [UInt64] = [2, 5, 12, 30, 30]
            try? await Task.sleep(nanoseconds: delays[min(self.wsFailures - 1, 4)] * 1_000_000_000)
            self.wsReconnectTask = nil
            if !Task.isCancelled && self.hasBackend { self.connectWebSocket() }
        }
    }

    private func receiveLoop() {
        wsTask?.receive { [weak self] result in
            guard let self = self else { return }
            switch result {
            case .failure:
                Task { @MainActor in
                    self.wsConnected = false
                    self.scheduleWSReconnect()
                }
            case .success(let message):
                Task { @MainActor in
                    self.handleWS(message)
                    self.receiveLoop()
                }
            }
        }
    }

    private func startHeartbeat() {
        Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 25_000_000_000)
                guard let self = self, let ws = self.wsTask else { break }
                ws.sendPing { error in
                    if error != nil {
                        Task { @MainActor in
                            self.wsConnected = false
                            self.connectWebSocket()
                        }
                    }
                }
            }
        }
    }

    private func handleWS(_ message: URLSessionWebSocketTask.Message) {
        guard case .string(let text) = message else { return }
        guard let data = text.data(using: .utf8) else { return }
        guard let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return }
        guard let type = obj["t"] as? String, let payload = obj["data"] else { return }

        if type == "price",
           let p = payload as? [String: Any],
           let symbol = p["symbol"] as? String,
           let price = p["price"] as? Double {
            if status != nil {
                var prices = status!.prices
                prices[symbol] = APITick(price: price, at: Date().timeIntervalSince1970 * 1000)
                status!.prices = prices
            }
        } else if type == "trade" {
            let d = payload as? [String: Any]
            let kind = (d?["kind"] as? String) ?? ""
            if kind == "entry" || kind == "exit" || kind == "position-closed" {
                let msg = "\(d?["symbol"] as? String ?? "") \(kind): buy/sell executed"
                notifyLocal(title: "Autopilot trade", body: msg)
            }
            Task { await loadOnce() }
        } else if type == "status" {
            if let d = payload as? [String: Any], let kind = d["kind"] as? String, kind == "breaker" {
                notifyLocal(title: "Circuit breaker", body: (d["msg"] as? String) ?? "")
            }
            Task { await loadOnce() }
        } else if type == "activity" {
            if let d = payload as? [String: Any] {
                let item = APIActivity(ts: (d["ts"] as? Double) ?? 0,
                                       kind: (d["kind"] as? String) ?? "",
                                       msg: (d["msg"] as? String) ?? "",
                                       symbol: d["symbol"] as? String)
                activity.insert(item, at: 0)
                if activity.count > 300 { activity.removeLast(activity.count - 300) }
            }
        }
    }

    // MARK: notifications
    func askNotificationPermission() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
    }

    func notifyLocal(title: String, body: String) {
        guard let s = settings else { return }
        let isFill = body.contains("entry") || body.contains("exit")
        let isStop = body.lowercased().contains("stop")
        let isBreaker = title.contains("breaker")
        if (isFill && !s.notifyFills) || (isStop && !s.notifyStops) || (isBreaker && !s.notifyBreaker) { return }
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        let req = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(req)
    }
}
