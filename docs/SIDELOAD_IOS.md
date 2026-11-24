# Sideloading the iOS App (esign)

The GitHub Actions workflow builds an UNSIGNED .ipa. You sign it yourself with
esign (or any sideloading signer) - no Apple developer certificate, p12, or
provisioning profile is committed anywhere in this repository.

## 1. Get the unsigned .ipa

1. Open the repository on GitHub.
2. Go to the Actions tab and run the workflow called
   Build unsigned iOS IPA (or use the latest completed run on main).
3. Download the artifact named AutopilotTrader-unsigned-ipa.
4. Unzip the artifact file (GitHub wraps artifacts in a zip):
   inside is AutopilotTrader-unsigned.ipa.

## 2. Install via esign

1. Install esign from its official source on the device you sideload to.
2. Open esign, import the unsigned .ipa (via Files, the built-in browser, or
   AirDrop).
3. Sign it with your imported certificate:
   - If you have a free/personal Apple developer certificate: import the .p12
     and let esign generate a provisioning profile. Apps signed with a free
     certificate expire after 7 days and must be re-signed.
   - If you have a paid developer account: same flow, profiles last a year.
   - esign also supports self-signed certificates for local development.
4. Tap Install. Enable Settings -> General -> VPN & Device Management and
   trust the developer profile if iOS asks.
5. Open the app, enter your backend URL (and bearer token if configured),
   then set your risk slider and tap Start Autopilot.

## 3. Re-signing after expiry

- Free certificates: re-open esign and repeat sign + install every 7 days.
- Paid certificates: repeat yearly, or when you revoke the profile.
- The app itself updates by installing a newly signed build over the old one;
  local settings (backend URL, Keychain-stored token) survive updates.

## 4. Troubleshooting

- "Untrusted Developer" - trust the profile in settings (step 2.4).
- App immediately crashes - you likely signed without a valid provisioning
  profile; re-sign with esign defaults.
- "Cannot connect to backend" - the backend URL must be HTTPS (or plain HTTP
  only for local dev; the Info.plist allows local networking).
- Note on push notifications: a real APNs push setup requires entitlements
  and a paid Apple developer program. Without it, this app uses local
  notifications while running, and the backend keeps trading 24/7 regardless -
  you read the activity feed whenever you open the app.
