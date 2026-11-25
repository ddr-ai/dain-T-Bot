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
            Text("Connect to the hosted engine (prefilled) or your own server")
                .foregroundStyle(.secondary)
            TextField("https://dain-t-bot.netlify.app", text: $url)
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
        .onAppear {
            // Default to the hosted engine so connecting is one tap.
            if state.backendURL.isEmpty {
                url = "https://dain-t-bot.netlify.app"
            } else {
                url = state.backendURL
            }
            token = state.token
        }
    }
}
