import SwiftUI

@main
struct PhiMacApp: App {
  @StateObject private var controller: ConnectionController
  private let notificationCenter: MacNotificationCenter

  init() {
    let notificationCenter = MacNotificationCenter()
    let controller = ConnectionController(
      notifications: notificationCenter,
      dockBadge: MacDockBadge()
    )
    notificationCenter.onOpen = { [weak controller] serverID, path in
      controller?.openNotification(serverID: serverID, path: path)
    }
    if controller.notificationsEnabled {
      // The user has already opted in. Re-request the current capability set
      // so upgrades from alert/sound-only builds also acquire badge permission.
      Task { @MainActor in
        _ = await notificationCenter.requestAuthorization()
      }
    }
    self.notificationCenter = notificationCenter
    _controller = StateObject(wrappedValue: controller)
  }

  var body: some Scene {
    WindowGroup {
      ContentView(controller: controller)
        .frame(minWidth: 820, minHeight: 560)
        .onOpenURL { controller.handleDeepLink($0) }
    }
    .defaultSize(width: 1180, height: 760)
    .commands {
      CommandGroup(after: .appInfo) {
        Button("Reconnect") {
          Task { await controller.connectSelected() }
        }
        .keyboardShortcut("r", modifiers: [.command, .shift])
      }
    }

    Settings {
      NotificationSettingsView(controller: controller)
    }
  }
}
