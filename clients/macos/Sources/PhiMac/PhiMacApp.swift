import SwiftUI

@main
struct PhiMacApp: App {
  @StateObject private var controller = ConnectionController()

  var body: some Scene {
    WindowGroup {
      ContentView(controller: controller)
        .frame(minWidth: 820, minHeight: 560)
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
  }
}
