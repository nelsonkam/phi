import Foundation

public struct PhiNotificationCandidate: Equatable, Sendable {
  public let threadID: String
  public let messageID: String
  public let title: String
  public let subtitle: String
  public let body: String

  public init(
    threadID: String,
    messageID: String,
    title: String,
    subtitle: String,
    body: String
  ) {
    self.threadID = threadID
    self.messageID = messageID
    self.title = title
    self.subtitle = subtitle
    self.body = body
  }
}

public struct ActivityNotificationTracker: Sendable {
  private struct Baseline: Sendable {
    let messageID: String
    let unreadCount: Int
  }

  private var baseline: [String: Baseline]?

  public init() {}

  public mutating func reset() {
    baseline = nil
  }

  public mutating func ingest(
    _ page: PhiActivityPage,
    allowNotifications: Bool,
    appIsActive: Bool
  ) -> [PhiNotificationCandidate] {
    let next = Dictionary(uniqueKeysWithValues: page.activity.map {
      ($0.thread.id, Baseline(
        messageID: $0.latestMessage.id,
        unreadCount: $0.unreadCount
      ))
    })
    defer { baseline = next }

    guard allowNotifications, !appIsActive, let baseline else { return [] }
    return page.activity.compactMap { item in
      guard item.latestMessage.author == "agent", item.unreadCount > 0 else {
        return nil
      }
      let previous = baseline[item.thread.id]
      guard previous?.messageID != item.latestMessage.id
        || item.unreadCount > (previous?.unreadCount ?? 0)
      else { return nil }

      let fallback = normalized(item.latestMessage.content, limit: 80)
      let title = normalized(item.thread.title ?? "", limit: 80)
      return PhiNotificationCandidate(
        threadID: item.thread.id,
        messageID: item.latestMessage.id,
        title: title.isEmpty ? (fallback.isEmpty ? "Phi response" : fallback) : title,
        subtitle: "#\(item.channelName)",
        body: normalized(item.latestMessage.content, limit: 180)
      )
    }
  }

  private func normalized(_ value: String, limit: Int) -> String {
    let collapsed = value.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    guard collapsed.count > limit else { return collapsed }
    return String(collapsed.prefix(max(0, limit - 1))) + "…"
  }
}
