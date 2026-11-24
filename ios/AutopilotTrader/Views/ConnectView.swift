import SwiftUI

struct ConnectView: View {
    @EnvironmentObject var state: AppState
    @State private var url: String = ""
    @State private var token: String = ""

    var body: some View {
        VStack(spacing: 24) {
            Image(systemName: "bolt.circle.fill")
                .font(.system(size: 72))
                .foregroundStyle(.cyan)
            Text("Crypto Autopilot")
                .font(.largeTitle.bold())
            Text("Connect to your bot backend")
                .foregroundStyle(.secondary)
            TextField("https://your-server.example.com", text: $url)
                .keyboardType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .textFieldStyle(.roundedBorder)
            SecureField("API bearer token (optional)", text: $token)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .textFieldStyle(.roundedBorder)
            Button {
                state.setBackend(url, token: token)
            } label: {
                Text("Connect")
                    .font(.headline)
                    .frame(maxWidth: .infinity, minHeight: 50)
            }
            .buttonStyle(.borderedProminent)
            .disabled(url.isEmpty)
            if let err = state.lastError {
                Text(err).font(.footnote).foregroundStyle(.red)
            }
            Text("The bot holds your Gemini funds-safe key (Balances + Orders only, withdrawals disabled). You just watch what it does.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal)
        }
        .padding()
        .onAppear { url = state.backendURL }
    }
}
