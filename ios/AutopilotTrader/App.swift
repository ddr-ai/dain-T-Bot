import SwiftUI

@main
struct AutopilotApp: App {
    @StateObject private var state = AppState()

    var body: some Scene {
        WindowGroup {
            Group {
                if state.hasBackend {
                    MainTabsView()
                } else {
                    ConnectView()
                }
            }
            .environmentObject(state)
            .preferredColorScheme(nil)
        }
    }
}

struct MainTabsView: View {
    @EnvironmentObject var state: AppState

    var body: some View {
        TabView {
            DashboardView()
                .tabItem { Label("Home", systemImage: "bolt.fill") }
            WatchlistView()
                .tabItem { Label("Prices", systemImage: "chart.line.uptrend.xyaxis") }
            ActivityView()
                .tabItem { Label("Activity", systemImage: "list.bullet.rectangle") }
            TradesView()
                .tabItem { Label("Trades", systemImage: "arrow.left.arrow.right") }
            SettingsView()
                .tabItem { Label("Settings", systemImage: "gearshape") }
        }
        .tint(.cyan)
        .task {
            await state.refreshAll()
            state.connectWebSocket()
            state.askNotificationPermission()
        }
    }
}
