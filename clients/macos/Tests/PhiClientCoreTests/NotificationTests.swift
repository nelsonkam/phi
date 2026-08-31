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
  let session = WindowSession(controller: controller)

  await session.connect()
  #expect(controller.waitingCount == 1)
  #expect(badge.counts.last == 1)

  session.select(nil)
  #expect(controller.waitingCount == 0)
  #expect(badge.counts.last == 0)
}

@MainActor
@Test func consumedNotificationNavigationCannotReplayOnReconnect() throws {
  let suite = "PhiNotificationConsumptionTests.\(UUID().uuidString)"
  let defaults = UserDefaults(suiteName: suite)!
  defer { defaults.removePersistentDomain(forName: suite) }
  let controller = ConnectionController(settings: defaults)
  let session = WindowSession(controller: controller)
  let request = ServerNavigationRequest(
    serverID: ServerConnection.local.id,
    threadID: "thread-1"
  )

  session.enqueueNavigation(request)
  session.consumeNavigationRequest(UUID())
  #expect(session.navigationRequest == request)

  session.consumeNavigationRequest(request.id)
  #expect(session.navigationRequest == nil)
}

@MainActor
@Test func windowsCanSelectDifferentServersIndependently() async throws {
  let suite = "PhiWindowSelectionTests.\(UUID().uuidString)"
  let defaults = UserDefaults(suiteName: suite)!
  defer { defaults.removePersistentDomain(forName: suite) }
  let repository = ConnectionRepository(defaults: defaults)
  let remote = try ServerConnection(name: "Remote", origin: "https://phi.example.com")
  try repository.saveConnections([.local, remote])
  repository.saveSelection(ServerConnection.local.id)

  let controller = ConnectionController(
    repository: repository,
    credentials: EmptyCredentialStore(),
    api: AcceptingActivityAPI(),
    cookieStore: EmptyCookieStore(),
    liveClient: FinishedLiveClient(),
    settings: defaults
  )
  let first = WindowSession(controller: controller)
  let second = WindowSession(controller: controller)

  #expect(first.selectedID == ServerConnection.local.id)
  #expect(second.selectedID == ServerConnection.local.id)

  second.select(remote.id)
  #expect(first.selectedID == ServerConnection.local.id)
  #expect(second.selectedID == remote.id)
  #expect(controller.defaultSelectionID == remote.id)

  await first.connect()
  await second.connect()
  #expect(first.status == .connected)
  #expect(second.status == .connected)
}

@MainActor
@Test func badgeSumsUniqueServersOpenInWindows() async throws {
  let suite = "PhiWindowBadgeTests.\(UUID().uuidString)"
  let defaults = UserDefaults(suiteName: suite)!
  defer { defaults.removePersistentDomain(forName: suite) }
  let repository = ConnectionRepository(defaults: defaults)
  let remote = try ServerConnection(name: "Remote", origin: "https://phi.example.com")
  try repository.saveConnections([.local, remote])
  repository.saveSelection(ServerConnection.local.id)

  let controller = ConnectionController(
    repository: repository,
    credentials: EmptyCredentialStore(),
    api: PerServerActivityAPI(
      pages: [
        ServerConnection.local.id: activityPage(messageID: "local", unreadCount: 2),
        remote.id: activityPage(messageID: "remote", unreadCount: 4),
      ]
    ),
    cookieStore: EmptyCookieStore(),
    liveClient: FinishedLiveClient(),
    dockBadge: RecordingBadge(),
    settings: defaults
  )
  let first = WindowSession(controller: controller)
  let second = WindowSession(controller: controller)
  second.select(remote.id)

  await first.connect()
  await second.connect()
  #expect(controller.waitingCount == 2)

  let third = WindowSession(controller: controller)
  third.select(remote.id)
  await third.connect()
  #expect(controller.waitingCount == 2)
}

@MainActor
@Test func notificationOpenPrefersAWindowAlreadyShowingThatServer() throws {
  let suite = "PhiNotificationOpenTests.\(UUID().uuidString)"
  let defaults = UserDefaults(suiteName: suite)!
  defer { defaults.removePersistentDomain(forName: suite) }
  let repository = ConnectionRepository(defaults: defaults)
  let remote = try ServerConnection(name: "Remote", origin: "https://phi.example.com")
  try repository.saveConnections([.local, remote])
  repository.saveSelection(ServerConnection.local.id)

  let controller = ConnectionController(
    repository: repository,
    credentials: EmptyCredentialStore(),
    cookieStore: EmptyCookieStore(),
    settings: defaults
  )
  let localWindow = WindowSession(controller: controller)
  let remoteWindow = WindowSession(controller: controller)
  remoteWindow.select(remote.id)

  controller.openNotification(serverID: remote.id, path: "/t/thread-1")
  #expect(remoteWindow.navigationRequest?.serverID == remote.id)
  #expect(localWindow.navigationRequest == nil)
  #expect(localWindow.selectedID == ServerConnection.local.id)
}

@MainActor
@Test func staleConnectFailureDoesNotClobberANewerSuccess() async throws {
  let suite = "PhiStaleConnectTests.\(UUID().uuidString)"
  let defaults = UserDefaults(suiteName: suite)!
  defer { defaults.removePersistentDomain(forName: suite) }
  let api = GatedAPI(gateValidations: true)
  let controller = ConnectionController(
    repository: ConnectionRepository(defaults: defaults),
    credentials: EmptyCredentialStore(),
    api: api,
    cookieStore: EmptyCookieStore(),
    liveClient: FinishedLiveClient(),
    settings: defaults
  )
  let session = WindowSession(controller: controller)

  let first = Task { @MainActor in await session.connect() }
  await waitUntil { api.pendingValidations == 1 }
  let second = Task { @MainActor in await session.connect() }
  await waitUntil { api.pendingValidations == 2 }

  api.succeedNewestValidation()
  await second.value
  #expect(session.status == .connected)

  api.failOldestValidation(PhiAPIError.unreachable("stale"))
  await first.value
  #expect(session.status == .connected)
}

@MainActor
@Test func staleActivityRefreshDoesNotWriteIntoReplacementMonitor() async throws {
  let suite = "PhiStaleRefreshTests.\(UUID().uuidString)"
  let defaults = UserDefaults(suiteName: suite)!
  defer { defaults.removePersistentDomain(forName: suite) }
  let api = GatedAPI(gateFetches: true)
  let notifications = RecordingNotifications()
  let controller = ConnectionController(
    repository: ConnectionRepository(defaults: defaults),
    credentials: EmptyCredentialStore(),
    api: api,
    cookieStore: EmptyCookieStore(),
    liveClient: FinishedLiveClient(),
    notifications: notifications,
    settings: defaults
  )
  controller.setNotificationsEnabled(true)
  let session = WindowSession(controller: controller)

  let connectTask = Task { @MainActor in await session.connect() }
  await waitUntil { api.pendingFetches == 1 }

  let editTask = Task { @MainActor in
    try await controller.edit(
      ServerConnection.local,
      name: "This Mac",
      origin: "http://127.0.0.1:43141",
      token: ""
    )
  }
  await waitUntil { api.pendingFetches == 2 }

  api.succeedOldestFetch(activityPage(messageID: "old", unreadCount: 2, waitingCount: 9))
  #expect(controller.waitingCount == 0)
  #expect(notifications.delivered.isEmpty)

  api.succeedOldestFetch(activityPage(messageID: "new", unreadCount: 1, waitingCount: 1))
  await connectTask.value
  try await editTask.value
  #expect(controller.waitingCount == 1)
  #expect(notifications.delivered.isEmpty)
}

@MainActor
@Test func unregisteringLastWindowStopsItsMonitor() async throws {
  let suite = "PhiWindowCloseTests.\(UUID().uuidString)"
  let defaults = UserDefaults(suiteName: suite)!
  defer { defaults.removePersistentDomain(forName: suite) }
  let repository = ConnectionRepository(defaults: defaults)
  let remote = try ServerConnection(name: "Remote", origin: "https://phi.example.com")
  try repository.saveConnections([.local, remote])
  repository.saveSelection(ServerConnection.local.id)

  let controller = ConnectionController(
    repository: repository,
    credentials: EmptyCredentialStore(),
    api: FakeActivityAPI(page: activityPage(messageID: "m1", unreadCount: 2)),
    cookieStore: EmptyCookieStore(),
    liveClient: FinishedLiveClient(),
    settings: defaults
  )
  let first = WindowSession(controller: controller)
  let second = WindowSession(controller: controller)
  second.select(remote.id)

  await first.connect()
  await second.connect()
  #expect(controller.waitingCount == 2)

  controller.unregister(second.id)
  #expect(controller.waitingCount == 1)
  #expect(first.status == .connected)

  controller.unregister(first.id)
  #expect(controller.waitingCount == 0)
  controller.openNotification(serverID: ServerConnection.local.id, path: "/t/thread-1")
  #expect(first.navigationRequest == nil)
}

@MainActor
@Test func reconnectingOneWindowDoesNotDropAnotherServersMonitor() async throws {
  let suite = "PhiReconnectRetainTests.\(UUID().uuidString)"
  let defaults = UserDefaults(suiteName: suite)!
  defer { defaults.removePersistentDomain(forName: suite) }
  let repository = ConnectionRepository(defaults: defaults)
  let remote = try ServerConnection(name: "Remote", origin: "https://phi.example.com")
  try repository.saveConnections([.local, remote])
  repository.saveSelection(ServerConnection.local.id)

  let api = GatedAPI(
    pages: [
      ServerConnection.local.id: activityPage(messageID: "local", unreadCount: 2),
      remote.id: activityPage(messageID: "remote", unreadCount: 2, waitingCount: 3),
    ]
  )
  let controller = ConnectionController(
    repository: repository,
    credentials: EmptyCredentialStore(),
    api: api,
    cookieStore: EmptyCookieStore(),
    liveClient: FinishedLiveClient(),
    settings: defaults
  )
  let first = WindowSession(controller: controller)
  let second = WindowSession(controller: controller)
  second.select(remote.id)

  await first.connect()
  await second.connect()
  #expect(controller.waitingCount == 4)

  api.gateValidations = true
  let reconnect = Task { @MainActor in await second.connect() }
  await waitUntil { api.pendingValidations == 1 }
  #expect(second.status == .connecting)
  #expect(first.status == .connected)
  #expect(controller.waitingCount == 4)

  api.succeedNewestValidation()
  await reconnect.value
  #expect(second.status == .connected)
  #expect(controller.waitingCount == 4)
}

@MainActor
@Test func closingAWindowDuringAnotherReconnectDoesNotKeepTheClosedServer() async throws {
  let suite = "PhiReconnectCloseTests.\(UUID().uuidString)"
  let defaults = UserDefaults(suiteName: suite)!
  defer { defaults.removePersistentDomain(forName: suite) }
  let repository = ConnectionRepository(defaults: defaults)
  let remote = try ServerConnection(name: "Remote", origin: "https://phi.example.com")
  try repository.saveConnections([.local, remote])
  repository.saveSelection(ServerConnection.local.id)

  let api = GatedAPI(
    pages: [
      ServerConnection.local.id: activityPage(messageID: "local", unreadCount: 2),
      remote.id: activityPage(messageID: "remote", unreadCount: 2, waitingCount: 3),
    ]
  )
  let controller = ConnectionController(
    repository: repository,
    credentials: EmptyCredentialStore(),
    api: api,
    cookieStore: EmptyCookieStore(),
    liveClient: FinishedLiveClient(),
    settings: defaults
  )
  let first = WindowSession(controller: controller)
  let second = WindowSession(controller: controller)
  second.select(remote.id)

  await first.connect()
  await second.connect()
  #expect(controller.defaultSelectionID == remote.id)
  #expect(controller.waitingCount == 4)

  api.gateValidations = true
  let reconnect = Task { @MainActor in await first.connect() }
  await waitUntil { api.pendingValidations == 1 }
  controller.unregister(second.id)
  #expect(first.status == .connecting)
  #expect(controller.waitingCount == 1)

  api.succeedNewestValidation()
  await reconnect.value
  #expect(first.status == .connected)
  #expect(controller.waitingCount == 1)
}

private func activityPage(
  messageID: String,
  unreadCount: Int,
  waitingCount: Int? = nil
) -> PhiActivityPage {
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
    waitingCount: waitingCount ?? (unreadCount > 0 ? 1 : 0)
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

private struct AcceptingActivityAPI: PhiAPIProviding {
  func validate(connection: ServerConnection, token: String?) async throws {}

  func fetchActivity(
    connection: ServerConnection,
    token: String?,
    limit: Int
  ) async throws -> PhiActivityPage {
    PhiActivityPage(activity: [], waitingCount: 0)
  }
}

private struct PerServerActivityAPI: PhiAPIProviding {
  let pages: [UUID: PhiActivityPage]

  func validate(connection: ServerConnection, token: String?) async throws {}

  func fetchActivity(
    connection: ServerConnection,
    token: String?,
    limit: Int
  ) async throws -> PhiActivityPage {
    pages[connection.id] ?? PhiActivityPage(activity: [], waitingCount: 0)
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

@MainActor
private final class RecordingNotifications: NotificationDelivering {
  private(set) var delivered: [(UUID, String)] = []

  func requestAuthorization() async -> Bool { true }

  func deliver(_ candidate: PhiNotificationCandidate, serverID: UUID) async {
    delivered.append((serverID, candidate.messageID))
  }
}

private final class GatedAPI: PhiAPIProviding, @unchecked Sendable {
  var gateValidations: Bool
  let gateFetches: Bool
  let pages: [UUID: PhiActivityPage]
  let ungatedFetchPage: PhiActivityPage
  private let lock = NSLock()
  private var validations: [CheckedContinuation<Void, Error>] = []
  private var fetches: [CheckedContinuation<PhiActivityPage, Error>] = []

  init(
    gateValidations: Bool = false,
    gateFetches: Bool = false,
    pages: [UUID: PhiActivityPage] = [:],
    ungatedFetchPage: PhiActivityPage = PhiActivityPage(activity: [], waitingCount: 0)
  ) {
    self.gateValidations = gateValidations
    self.gateFetches = gateFetches
    self.pages = pages
    self.ungatedFetchPage = ungatedFetchPage
  }

  var pendingValidations: Int {
    lock.withLock { validations.count }
  }

  var pendingFetches: Int {
    lock.withLock { fetches.count }
  }

  func validate(connection: ServerConnection, token: String?) async throws {
    guard gateValidations else { return }
    try await withCheckedThrowingContinuation { continuation in
      lock.withLock { validations.append(continuation) }
    }
  }

  func fetchActivity(
    connection: ServerConnection,
    token: String?,
    limit: Int
  ) async throws -> PhiActivityPage {
    guard gateFetches else {
      return pages[connection.id] ?? ungatedFetchPage
    }
    return try await withCheckedThrowingContinuation { continuation in
      lock.withLock { fetches.append(continuation) }
    }
  }

  func succeedNewestValidation() {
    lock.lock()
    let continuation = validations.removeLast()
    lock.unlock()
    continuation.resume()
  }

  func failOldestValidation(_ error: Error) {
    lock.lock()
    let continuation = validations.removeFirst()
    lock.unlock()
    continuation.resume(throwing: error)
  }

  func succeedOldestFetch(_ page: PhiActivityPage) {
    lock.lock()
    let continuation = fetches.removeFirst()
    lock.unlock()
    continuation.resume(returning: page)
  }
}

@MainActor
private func waitUntil(_ condition: @escaping @MainActor () -> Bool) async {
  for _ in 0..<4_000 {
    if condition() { return }
    try? await Task.sleep(nanoseconds: 250_000)
  }
  Issue.record("timed out waiting for condition")
}
