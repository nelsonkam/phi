import Foundation
import Testing
@testable import PhiClientCore
@testable import PhiMac

@Test func notificationTrackerBaselinesDeduplicatesAndSuppressesWhileActive() {
  var tracker = ActivityNotificationTracker()
  let initial = activityPage(messageID: "m1", unreadCount: 0)
  #expect(
    tracker.ingest(
      initial,
      allowNotifications: false,
      appIsActive: false
    ).isEmpty
  )

  let waiting = activityPage(messageID: "m2", unreadCount: 1)
  #expect(
    tracker.ingest(
      waiting,
      allowNotifications: true,
      appIsActive: true
    ).isEmpty
  )

  let next = activityPage(messageID: "m3", unreadCount: 2)
  let candidates = tracker.ingest(
    next,
    allowNotifications: true,
    appIsActive: false
  )
  #expect(candidates.count == 1)
  #expect(candidates.first?.threadID == "thread/one")
  #expect(candidates.first?.subtitle == "#phi")
  #expect(
    tracker.ingest(
      next,
      allowNotifications: true,
      appIsActive: false
    ).isEmpty
  )

  tracker.reset()
  #expect(
    tracker.ingest(
      next,
      allowNotifications: true,
      appIsActive: false
    ).isEmpty
  )
}

@Test func notificationNavigationBuildsASameOriginThreadURL() throws {
  let connection = try ServerConnection(
    name: "Remote",
    origin: "https://phi.example.com"
  )
  let request = ServerNavigationRequest(
    id: UUID(uuidString: "00000000-0000-0000-0000-000000000001")!,
    serverID: connection.id,
    threadID: "thread/one"
  )
  #expect(
    request.destinationURL(for: connection)?.absoluteString
      == "https://phi.example.com/t/thread%2Fone"
  )
  #expect(ServerNavigationRequest(serverID: connection.id, path: "//evil") == nil)
  #expect(
    ServerNavigationRequest(serverID: connection.id, path: "/t/thread?token=x")
      == nil
  )
}

@Test func buildsNotificationWebSocketURLs() throws {
  let local = try ServerConnection(name: "Local", origin: "http://localhost:3141")
  let remote = try ServerConnection(
    name: "Remote",
    origin: "https://phi.example.com"
  )
  #expect(
    PhiLiveClient.webSocketURL(for: local)?.absoluteString
      == "ws://localhost:3141/ws"
  )
  #expect(
    PhiLiveClient.webSocketURL(for: remote)?.absoluteString
      == "wss://phi.example.com/ws"
  )
}

@Test func pairDeepLinksPrefillOnlyNameAndValidatedOrigin() throws {
  var components = URLComponents()
  components.scheme = "phi"
  components.host = "add-server"
  components.queryItems = [
    URLQueryItem(name: "origin", value: "https://Phi.Example.com/"),
    URLQueryItem(name: "name", value: "Home Phi"),
  ]
  let request = try #require(AddServerRequest(deepLink: components.url!))
  #expect(request.name == "Home Phi")
  #expect(request.origin == "https://phi.example.com")

  let unsafeRemote = URL(
    string: "phi://add-server?origin=http%3A%2F%2Fphi.example.com"
  )!
  #expect(AddServerRequest(deepLink: unsafeRemote) == nil)

  let tokenBearing = URL(
    string: "phi://add-server?origin=https%3A%2F%2Fphi.example.com&token=secret"
  )!
  #expect(AddServerRequest(deepLink: tokenBearing) == nil)
}

@MainActor
@Test func monitoringUpdatesAndClearsTheSelectedServerBadge() async throws {
  let suite = "PhiNotificationTests.\(UUID().uuidString)"
  let defaults = UserDefaults(suiteName: suite)!
  defer { defaults.removePersistentDomain(forName: suite) }
  let repository = ConnectionRepository(defaults: defaults)
  let badge = RecordingBadge()
  let controller = ConnectionController(
    repository: repository,
    credentials: EmptyCredentialStore(),
    api: FakeActivityAPI(page: activityPage(messageID: "m1", unreadCount: 2)),
    cookieStore: EmptyCookieStore(),
    liveClient: FinishedLiveClient(),
    dockBadge: badge,
    settings: defaults
  )

  await controller.connectSelected()
  #expect(controller.waitingCount == 1)
  #expect(badge.counts.last == 1)

  controller.select(nil)
  #expect(controller.waitingCount == 0)
  #expect(badge.counts.last == 0)
}

@MainActor
@Test func consumedNotificationNavigationCannotReplayOnReconnect() throws {
  let suite = "PhiNotificationConsumptionTests.\(UUID().uuidString)"
  let defaults = UserDefaults(suiteName: suite)!
  defer { defaults.removePersistentDomain(forName: suite) }
  let controller = ConnectionController(settings: defaults)
  let request = ServerNavigationRequest(
    serverID: ServerConnection.local.id,
    threadID: "thread-1"
  )

  controller.enqueueNavigation(request)
  controller.consumeNavigationRequest(UUID())
  #expect(controller.navigationRequest == request)

  controller.consumeNavigationRequest(request.id)
  #expect(controller.navigationRequest == nil)
}

private func activityPage(messageID: String, unreadCount: Int) -> PhiActivityPage {
  PhiActivityPage(
    activity: [
      PhiActivityItem(
        thread: PhiActivityThread(id: "thread/one", title: "A useful answer"),
        channelName: "phi",
        latestMessage: PhiActivityMessage(
          id: messageID,
          author: "agent",
          content: "The implementation is ready."
        ),
        unreadCount: unreadCount
      )
    ],
    waitingCount: unreadCount > 0 ? 1 : 0
  )
}

private struct FakeActivityAPI: PhiAPIProviding {
  let page: PhiActivityPage

  func validate(connection: ServerConnection, token: String?) async throws {}

  func fetchActivity(
    connection: ServerConnection,
    token: String?,
    limit: Int
  ) async throws -> PhiActivityPage {
    page
  }
}

private struct FinishedLiveClient: PhiLiveProviding {
  func events(
    connection: ServerConnection,
    token: String?
  ) -> AsyncStream<PhiLiveEvent> {
    AsyncStream { $0.finish() }
  }
}

private final class EmptyCredentialStore: CredentialStore {
  func token(for connectionID: UUID) throws -> String? { nil }
  func save(token: String, for connectionID: UUID) throws {}
  func deleteToken(for connectionID: UUID) throws {}
}

@MainActor
private final class EmptyCookieStore: DeviceCookieClearing {
  func deleteDeviceCookie(for origin: URL) async {}
}

@MainActor
private final class RecordingBadge: DockBadgeUpdating {
  private(set) var counts: [Int] = []
  func setWaitingCount(_ count: Int) { counts.append(count) }
}
