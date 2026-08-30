import SwiftUI

struct NotificationSettingsView: View {
  @ObservedObject var controller: ConnectionController

  var body: some View {
    Form {
      Toggle(
        "Notify when an agent response is waiting",
        isOn: Binding(
          get: { controller.notificationsEnabled },
          set: { controller.setNotificationsEnabled($0) }
        )
      )
      Text(
        "Phi asks macOS for permission only when this is enabled. Notifications and the Dock badge monitor the selected server while Phi is running."
      )
      .font(.caption)
      .foregroundStyle(.secondary)
    }
    .formStyle(.grouped)
    .padding(18)
    .frame(width: 500, height: 190)
  }
}
