import AppKit
import Foundation
@preconcurrency import UserNotifications
import PhiClientCore

struct ServerNavigationRequest: Equatable, Identifiable {
  let id: UUID
  let serverID: UUID
  let path: String

  init(id: UUID = UUID(), serverID: UUID, threadID: String) {
    self.id = id
    self.serverID = serverID
    let allowed = CharacterSet.urlPathAllowed.subtracting(
      CharacterSet(charactersIn: "/?#")
    )
    let segment = threadID.addingPercentEncoding(withAllowedCharacters: allowed)
      ?? threadID
    path = "/t/\(segment)"
  }

  init?(id: UUID = UUID(), serverID: UUID, path: String) {
    guard Self.isThreadPath(path) else { return nil }
    self.id = id
    self.serverID = serverID
    self.path = path
  }

  func destinationURL(for connection: ServerConnection) -> URL? {
    guard connection.id == serverID,
      let destination = URL(string: path, relativeTo: connection.origin)?.absoluteURL,
      destination.scheme?.lowercased() == connection.origin.scheme?.lowercased(),
      destination.host?.lowercased() == connection.origin.host?.lowercased(),
      effectivePort(destination) == effectivePort(connection.origin)
    else { return nil }
    return destination
  }

  private static func isThreadPath(_ path: String) -> Bool {
    guard !path.contains("?"), !path.contains("#"),
      path.unicodeScalars.allSatisfy({ $0.value >= 0x20 && $0.value != 0x7f })
    else { return false }
    let segments = path.split(separator: "/", omittingEmptySubsequences: false)
    return segments.count == 3 && segments[0].isEmpty
      && segments[1] == "t" && !segments[2].isEmpty
  }

  private func effectivePort(_ url: URL) -> Int? {
    url.port ?? (url.scheme == "https" ? 443 : url.scheme == "http" ? 80 : nil)
  }
}

@MainActor
protocol NotificationDelivering: AnyObject {
  func requestAuthorization() async -> Bool
  func deliver(_ candidate: PhiNotificationCandidate, serverID: UUID) async
}

@MainActor
protocol DockBadgeUpdating: AnyObject {
  func setWaitingCount(_ count: Int)
}

@MainActor
final class MacNotificationCenter: NSObject, NotificationDelivering,
  UNUserNotificationCenterDelegate
{
  private let center: UNUserNotificationCenter
  var onOpen: ((UUID, String) -> Void)?

  init(center: UNUserNotificationCenter = .current()) {
    self.center = center
    super.init()
    center.delegate = self
  }

  func requestAuthorization() async -> Bool {
    (try? await center.requestAuthorization(options: [.alert, .sound, .badge]))
      ?? false
  }

  func deliver(_ candidate: PhiNotificationCandidate, serverID: UUID) async {
    let settings = await center.notificationSettings()
    guard settings.authorizationStatus == .authorized
      || settings.authorizationStatus == .provisional
    else { return }

    let content = UNMutableNotificationContent()
    content.title = candidate.title
    content.subtitle = candidate.subtitle
    content.body = candidate.body.isEmpty ? "New response" : candidate.body
    content.sound = .default
    content.userInfo = [
      "serverID": serverID.uuidString,
      "path": ServerNavigationRequest(
        serverID: serverID,
        threadID: candidate.threadID
      ).path,
    ]
    let request = UNNotificationRequest(
      identifier: "\(serverID.uuidString):\(candidate.threadID):\(candidate.messageID)",
      content: content,
      trigger: nil
    )
    try? await center.add(request)
  }

  nonisolated func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    let info = response.notification.request.content.userInfo
    let serverID = (info["serverID"] as? String).flatMap(UUID.init(uuidString:))
    let path = info["path"] as? String
    Task { @MainActor in
      if let serverID, let path { self.onOpen?(serverID, path) }
    }
    completionHandler()
  }
}

@MainActor
final class MacDockBadge: DockBadgeUpdating {
  func setWaitingCount(_ count: Int) {
    let dockTile = NSApplication.shared.dockTile
    dockTile.badgeLabel = count > 0 ? String(count) : nil
    // Explicit display avoids a stale Dock tile on macOS versions that do not
    // repaint immediately after an ad-hoc development build is relaunched.
    dockTile.display()
  }
}

@MainActor
final class NoopNotificationCenter: NotificationDelivering {
  func requestAuthorization() async -> Bool { false }
  func deliver(_ candidate: PhiNotificationCandidate, serverID: UUID) async {}
}

@MainActor
final class NoopDockBadge: DockBadgeUpdating {
  func setWaitingCount(_ count: Int) {}
}
