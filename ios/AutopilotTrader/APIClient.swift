import Foundation

// Minimal async REST client for the backend.

actor HTTP {
    static func request(_ method: String, _ url: URL, body: [String: Any]?, token: String?) async throws -> Data {
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.timeoutInterval = 15
        if let token = token, !token.isEmpty {
            req.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        }
        if let body = body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, res) = try await URLSession.shared.data(for: req)
        guard let http = res as? HTTPURLResponse else {
            throw URLError(.badServerResponse)
        }
        guard (200..<300).contains(http.statusCode) else {
            let msg = String(data: data, encoding: .utf8) ?? String(http.statusCode)
            throw APIError.badRequest(msg)
        }
        return data
    }
}

struct APIError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    static func badRequest(_ body: String) -> APIError {
        // try to pull the {"error": "..."} field
        if let data = body.data(using: .utf8),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let msg = obj["error"] as? String {
            return APIError(msg)
        }
        return APIError(body)
    }
    var errorDescription: String? { message }
}

final class APIClient {
    var baseURL: URL
    var token: String

    init(baseURL: URL, token: String) {
        self.baseURL = baseURL
        self.token = token
    }

    private func url(_ path: String) -> URL {
        var u = baseURL
        u.appendPathComponent(path)
        return u
    }

    func getJSON<T: Decodable>(_ path: String) async throws -> T {
        let data = try await HTTP.request("GET", url(path), body: nil, token: token)
        return try JSONDecoder().decode(T.self, from: data)
    }

    func post(_ path: String, body: [String: Any]? = [:]) async throws -> Data {
        try await HTTP.request("POST", url(path), body: body == nil ? nil : (body ?? [:]), token: token)
    }

    func put(_ path: String, body: [String: Any]) async throws -> Data {
        try await HTTP.request("PUT", url(path), body: body, token: token)
    }

    // MARK: endpoints
    func status() async throws -> APIStatus { try await getJSON("api/status") }
    func settings() async throws -> APISettings { try await getJSON("api/settings") }
    func activity(limit: Int = 60) async throws -> [APIActivity] { try await getJSON("api/activity?limit=\(limit)") }
    func trades(limit: Int = 50) async throws -> [APITrade] { try await getJSON("api/trades?limit=\(limit)") }
    func performance() async throws -> APIPerformance { try await getJSON("api/performance") }

    func setAutopilot(_ on: Bool) async throws {
        _ = try await post("api/autopilot", body: ["enabled": on])
    }

    // Hosted run-window flow: START a run for N minutes (1h..7d), or STOP new
    // entries (open positions keep being managed until they close).
    func startRun(minutes: Int) async throws {
        _ = try await post("api/run", body: ["minutes": minutes])
    }

    func stopRun() async throws {
        _ = try await post("api/autopilot", body: ["enabled": false])
    }

    func updateSettings(_ patch: [String: Any]) async throws {
        _ = try await put("api/settings", body: patch)
    }

    func saveCredentials(key: String, secret: String) async throws {
        _ = try await post("api/credentials", body: ["key": key, "secret": secret])
    }

    func deleteCredentials() async throws {
        _ = try await HTTP.request("DELETE", url("api/credentials"), body: nil, token: token)
    }

    func emergencyStop() async throws {
        _ = try await post("api/emergency-stop")
    }
}
