import Foundation

// Codable models mirroring the backend REST payloads (camelCase keys).

struct APIStatus: Codable {
    var running: Bool
    var autopilotOn: Bool
    var mode: String
    var hasCredentials: Bool
    var equity: Double
    var usdAvailable: Double
    var pnlToday: Double
    var pnlTodayPct: Double
    var dayStartEquity: Double
    var haltNew: Bool
    var haltReason: String?
    var guardLock: Bool
    var lastScanAt: Double
    var stalePrices: [String]
    var positions: [APIPosition]
    var prices: [String: APITick]
}

struct APITick: Codable {
    var price: Double
    var at: Double
}

struct APIPosition: Codable, Identifiable {
    var id: String
    var symbol: String
    var mode: String
    var qty: Double
    var remainingQty: Double
    var entry: Double
    var stop: Double
    var target: Double
    var riskUsd: Double
    var openedAt: Double
    var kind: String
    var breakevenDone: Bool
    var currentPrice: Double?
    var unrealizedPnl: Double?
}

struct APISettings: Codable {
    var autopilotOn: Bool
    var riskReward: Double
    var riskPct: Double
    var paper: Bool
    var maxTradesPerSymbolPerDay: Int
    var dailyLossWarnPct: Double
    var dailyLossLimitPct: Double
    var notifyFills: Bool
    var notifyStops: Bool
    var notifyBreaker: Bool
    var riskRewardMin: Double?
    var riskRewardMax: Double?
    var maxRiskPct: Double?
}

struct APIActivity: Codable, Identifiable {
    var id: String { "\(ts)-\(kind)" }
    var ts: Double
    var kind: String
    var msg: String
    var symbol: String?
}

struct APITrade: Codable, Identifiable {
    var id: String
    var symbol: String
    var mode: String
    var status: String
    var qty: Double
    var entry: Double
    var exit: Double?
    var exitReason: String?
    var feesUsd: Double
    var pnlUsd: Double
    var openedAt: Double
    var closedAt: Double?
    var planStop: Double
    var planTarget: Double
    var riskUsd: Double
    var kind: String
}

struct APIPerformance: Codable {
    var trades: Int
    var openTrades: Int
    var winRate: Double?
    var profitFactor: Double?
    var avgWin: Double?
    var avgLoss: Double?
    var totalPnl: Double
    var maxDrawdown: Double
    var feesPaid: Double
    var todayRealized: Double
    var todayFees: Double
    var equityCurve: [Double]
}
