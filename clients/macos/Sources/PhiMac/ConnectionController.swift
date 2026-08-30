import AppKit
import Foundation
import PhiClientCore

protocol PhiAPIProviding: Sendable {
  func validate(connection: ServerConnection, token: String?) async throws
  func fetchActivity(
    connection: ServerConnection,
    token: String?,
    limit: Int
  ) async throws -> PhiActivityPage
}

extension PhiAPIClient: PhiAPIProviding {}

protocol PhiLiveProviding: Sendable {
  func events(
    connection: ServerConnection,
    token: String?
  ) -> AsyncStream<PhiLiveEvent>
}

extension PhiLiveClient: PhiLiveProviding {}

@MainActor
final class ConnectionController: ObservableObject {
  enum Status: Equatable {
    case idle
    case connecting
    case connected
    case failed(String)
  }

  @Published private(set) var connections: [ServerConnection]
  @Published private(set) var selectedID: UUID?
  @Published private(set) var selectedToken: String?
  @Published private(set) var status: Status = .idle
  @Published private(set) var waitingCount = 0
  @Published private(set) var notificationsEnabled: Bool
  @Published private(set) var navigationRequest: ServerNavigationRequest?
  @Published private(set) var addServerRequest: AddServerRequest?

  private let repository: ConnectionRepository
  private let credentials: CredentialStore
  private let api: any PhiAPIProviding
  private let cookieStore: DeviceCookieClearing
  private let liveClient: any PhiLiveProviding
  private let notifications: NotificationDelivering
  private let dockBadge: DockBadgeUpdating
  private let settings: UserDefaults
  private let notificationsKey = "phi.notifications-enabled.v1"

  private var liveTask: Task<Void, Never>?
  private var refreshTask: Task<Void, Never>?
  private var notificationTracker = ActivityNotificationTracker()
  private weak var mainWindow: NSWindow?

  init(
    repository: ConnectionRepository = ConnectionRepository(),
    credentials: CredentialStore = KeychainCredentialStore(),
    api: any PhiAPIProviding = PhiAPIClient(),
    cookieStore: DeviceCookieClearing = WebKitDeviceCookieStore(),
    liveClient: any PhiLiveProviding = PhiLiveClient(),
    notifications: NotificationDelivering = NoopNotificationCenter(),
    dockBadge: DockBadgeUpdating = NoopDockBadge(),
    settings: UserDefaults = .standard
  ) {
    self.repository = repository
    self.credentials = credentials
    self.api = api
    self.cookieStore = cookieStore
    self.liveClient = liveClient
    self.notifications = notifications
    self.dockBadge = dockBadge
    self.settings = settings
    notificationsEnabled = settings.bool(forKey: notificationsKey)
    let loaded = repository.loadConnections()
    connections = loaded
    let persisted = repository.loadSelection()
    selectedID = loaded.contains(where: { $0.id == persisted })
      ? persisted
      : loaded.first?.id
    selectedToken = selectedID.flatMap { try? credentials.token(for: $0) }
  }

  var selectedConnection: ServerConnection? {
    connections.first { $0.id == selectedID }
  }

  func select(_ id: UUID?) {
    guard selectedID != id else { return }
    stopMonitoring(clearBadge: true)
    navigationRequest = nil
    selectedID = id
    selectedToken = id.flatMap { try? credentials.token(for: $0) }
    repository.saveSelection(id)
    status = .idle
  }

  func connectSelected() async {
    guard let connection = selectedConnection else { return }
    let connectionID = connection.id
    let token = selectedToken
    stopMonitoring(clearBadge: true)
    status = .connecting
    do {
      try await api.validate(connection: connection, token: token)
      guard selectedID == connectionID else { return }
      status = .connected
      await refreshActivity(
        connection: connection,
        token: token,
        connectionID: connectionID,
        allowNotifications: false
      )
      startLive(connection: connection, token: token, connectionID: connectionID)
    } catch {
      guard selectedID == connectionID else { return }
      status = .failed(error.localizedDescription)
    }
  }

  func add(name: String, origin: String, token: String) async throws {
    let connection = try ServerConnection(name: name, origin: origin)
    let trimmedToken = token.trimmingCharacters(in: .whitespacesAndNewlines)
    try await api.validate(
      connection: connection,
      token: trimmedToken.isEmpty ? nil : trimmedToken
    )

    if !trimmedToken.isEmpty {
      try credentials.save(token: trimmedToken, for: connection.id)
    }
    var updated = connections
    updated.append(connection)
    try repository.saveConnections(updated)
    connections = updated
    select(connection.id)
    selectedToken = trimmedToken.isEmpty ? nil : trimmedToken
    status = .connected
  }

  func edit(
    _ existing: ServerConnection,
    name: String,
    origin: String,
    token: String
  ) async throws {
    let candidate = try ServerConnection(id: existing.id, name: name, origin: origin)
    let replacementToken = token.trimmingCharacters(in: .whitespacesAndNewlines)
    let savedToken = try credentials.token(for: existing.id)
    // Loopback can still require a credential when it is an SSH-forwarded or
    // host-mapped sandbox server. Preserve a saved token unless the editor
    // supplies a replacement; origin shape alone must not delete it.
    let nextToken = replacementToken.isEmpty ? savedToken : replacementToken
    let originChanged = candidate.origin != existing.origin
    let tokenChanged = !replacementToken.isEmpty && replacementToken != savedToken

    if originChanged || tokenChanged {
      try await api.validate(connection: candidate, token: nextToken)
    }

    if let nextToken {
      try credentials.save(token: nextToken, for: candidate.id)
    } else {
      try credentials.deleteToken(for: candidate.id)
    }

    guard let index = connections.firstIndex(where: { $0.id == existing.id }) else {
      throw ConnectionControllerError.connectionNotFound
    }
    var updated = connections
    updated[index] = candidate
    try repository.saveConnections(updated)

    if originChanged {
      await cookieStore.deleteDeviceCookie(for: existing.origin)
    } else if tokenChanged {
      await cookieStore.deleteDeviceCookie(for: candidate.origin)
    }

    connections = updated
    if selectedID == candidate.id {
      selectedToken = nextToken
      if originChanged || tokenChanged {
        stopMonitoring(clearBadge: true)
        status = .connected
        await refreshActivity(
          connection: candidate,
          token: nextToken,
          connectionID: candidate.id,
          allowNotifications: false
        )
        startLive(
          connection: candidate,
          token: nextToken,
          connectionID: candidate.id
        )
      }
    }
  }

  func remove(_ connection: ServerConnection) async throws {
    await cookieStore.deleteDeviceCookie(for: connection.origin)
    try credentials.deleteToken(for: connection.id)
    let updated = connections.filter { $0.id != connection.id }
    connections = updated.isEmpty ? [.local] : updated
    try repository.saveConnections(connections)
    if selectedID == connection.id {
      select(connections.first?.id)
    }
  }

  func setNotificationsEnabled(_ enabled: Bool) {
    guard notificationsEnabled != enabled else { return }
    notificationsEnabled = enabled
    settings.set(enabled, forKey: notificationsKey)
    if enabled {
      Task { _ = await notifications.requestAuthorization() }
    }
  }

  func presentAddServer(_ request: AddServerRequest = AddServerRequest()) {
    addServerRequest = request
  }

  func dismissAddServer() {
    addServerRequest = nil
  }

  func handleDeepLink(_ url: URL) {
    guard let request = AddServerRequest(deepLink: url) else { return }
    presentAddServer(request)
  }

  func registerMainWindow(_ window: NSWindow) {
    mainWindow = window
  }

  func openNotification(serverID: UUID, path: String) {
    guard connections.contains(where: { $0.id == serverID }),
      let request = ServerNavigationRequest(serverID: serverID, path: path)
    else { return }

    NSApplication.shared.activate(ignoringOtherApps: true)
    mainWindow?.makeKeyAndOrderFront(nil)
    if selectedID != serverID { select(serverID) }
    enqueueNavigation(request)
  }

  func enqueueNavigation(_ request: ServerNavigationRequest) {
    navigationRequest = request
  }

  func consumeNavigationRequest(_ id: UUID) {
    guard navigationRequest?.id == id else { return }
    navigationRequest = nil
  }

  private func startLive(
    connection: ServerConnection,
    token: String?,
    connectionID: UUID
  ) {
    liveTask?.cancel()
    let events = liveClient.events(connection: connection, token: token)
    liveTask = Task { [weak self] in
      for await event in events {
        guard !Task.isCancelled, let self, self.selectedID == connectionID else {
          break
        }
        switch event {
        case .connected:
          self.notificationTracker.reset()
          self.scheduleRefresh(
            connection: connection,
            token: token,
            connectionID: connectionID,
            allowNotifications: false,
            delayNanoseconds: 0
          )
        case .invalidated:
          self.scheduleRefresh(
            connection: connection,
            token: token,
            connectionID: connectionID,
            allowNotifications: true,
            delayNanoseconds: 150_000_000
          )
        case .disconnected:
          break
        }
      }
    }
  }

  private func scheduleRefresh(
    connection: ServerConnection,
    token: String?,
    connectionID: UUID,
    allowNotifications: Bool,
    delayNanoseconds: UInt64
  ) {
    refreshTask?.cancel()
    refreshTask = Task { [weak self] in
      if delayNanoseconds > 0 {
        try? await Task.sleep(nanoseconds: delayNanoseconds)
      }
      guard !Task.isCancelled, let self else { return }
      await self.refreshActivity(
        connection: connection,
        token: token,
        connectionID: connectionID,
        allowNotifications: allowNotifications
      )
    }
  }

  private func refreshActivity(
    connection: ServerConnection,
    token: String?,
    connectionID: UUID,
    allowNotifications: Bool
  ) async {
    do {
      let page = try await api.fetchActivity(
        connection: connection,
        token: token,
        limit: 50
      )
      guard selectedID == connectionID else { return }
      setWaitingCount(page.waitingCount)
      let candidates = notificationTracker.ingest(
        page,
        allowNotifications: allowNotifications && notificationsEnabled,
        appIsActive: NSApplication.shared.isActive
      )
      for candidate in candidates {
        await notifications.deliver(candidate, serverID: connectionID)
      }
    } catch {
      // The web UI remains authoritative. A failed background activity refresh
      // must not replace a healthy session with a connection error screen.
    }
  }

  private func stopMonitoring(clearBadge: Bool) {
    liveTask?.cancel()
    liveTask = nil
    refreshTask?.cancel()
    refreshTask = nil
    notificationTracker.reset()
    if clearBadge { setWaitingCount(0) }
  }

  private func setWaitingCount(_ count: Int) {
    waitingCount = max(0, count)
    dockBadge.setWaitingCount(waitingCount)
  }
}

enum ConnectionControllerError: LocalizedError {
  case connectionNotFound

  var errorDescription: String? {
    "That saved server no longer exists."
  }
}
