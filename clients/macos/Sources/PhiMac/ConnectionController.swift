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
  @Published private(set) var defaultSelectionID: UUID?
  @Published private(set) var waitingCount = 0
  @Published private(set) var notificationsEnabled: Bool

  private let repository: ConnectionRepository
  private let credentials: CredentialStore
  private let api: any PhiAPIProviding
  private let cookieStore: DeviceCookieClearing
  private let liveClient: any PhiLiveProviding
  private let notifications: NotificationDelivering
  private let dockBadge: DockBadgeUpdating
  private let settings: UserDefaults
  private let notificationsKey = "phi.notifications-enabled.v1"

  private var sessions: [UUID: WeakSession] = [:]
  private var monitors: [UUID: ServerActivityMonitor] = [:]
  private var pendingAddServerRequest: AddServerRequest?

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
    defaultSelectionID = loaded.contains(where: { $0.id == persisted })
      ? persisted
      : loaded.first?.id
  }

  func connection(id: UUID?) -> ServerConnection? {
    guard let id else { return nil }
    return connections.first { $0.id == id }
  }

  func token(for id: UUID?) -> String? {
    guard let id else { return nil }
    return try? credentials.token(for: id)
  }

  func rememberSelection(_ id: UUID?) {
    defaultSelectionID = id
    repository.saveSelection(id)
  }

  func register(_ session: WindowSession) {
    sessions[session.id] = WeakSession(session: session)
    if let pendingAddServerRequest {
      self.pendingAddServerRequest = nil
      session.presentAddServer(pendingAddServerRequest)
    }
  }

  func unregister(_ id: UUID) {
    sessions[id] = nil
    sessionSelectionChanged()
  }

  var keySession: WindowSession? {
    let keyWindow = NSApplication.shared.keyWindow
    return liveSessions.first { $0.window === keyWindow } ?? liveSessions.first
  }

  func reconnectKeyWindow() async {
    await keySession?.connect()
  }

  func validate(connection: ServerConnection, token: String?) async throws {
    try await api.validate(connection: connection, token: token)
  }

  @discardableResult
  func add(name: String, origin: String, token: String) async throws -> ServerConnection {
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
    return connection
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
    notifySessions()
    if originChanged || tokenChanged {
      stopMonitor(candidate.id)
      await ensureMonitors()
    }
  }

  func remove(_ connection: ServerConnection) async throws {
    await cookieStore.deleteDeviceCookie(for: connection.origin)
    try credentials.deleteToken(for: connection.id)
    let updated = connections.filter { $0.id != connection.id }
    connections = updated.isEmpty ? [.local] : updated
    try repository.saveConnections(connections)
    if defaultSelectionID == connection.id {
      rememberSelection(connections.first?.id)
    }
    notifySessions()
    sessionSelectionChanged()
  }

  func setNotificationsEnabled(_ enabled: Bool) {
    guard notificationsEnabled != enabled else { return }
    notificationsEnabled = enabled
    settings.set(enabled, forKey: notificationsKey)
    if enabled {
      Task { _ = await notifications.requestAuthorization() }
    }
  }

  func handleDeepLink(_ url: URL) {
    guard let request = AddServerRequest(deepLink: url) else { return }
    if let session = keySession {
      session.presentAddServer(request)
    } else {
      pendingAddServerRequest = request
    }
  }

  func openNotification(serverID: UUID, path: String) {
    guard connections.contains(where: { $0.id == serverID }),
      let request = ServerNavigationRequest(serverID: serverID, path: path)
    else { return }

    NSApplication.shared.activate(ignoringOtherApps: true)
    let session = liveSessions.first { $0.selectedID == serverID }
      ?? keySession
      ?? liveSessions.first
    session?.window?.makeKeyAndOrderFront(nil)
    session?.open(request)
  }

  func sessionSelectionChanged() {
    pruneMonitors()
    publishBadge()
  }

  func sessionDidConnect(_ session: WindowSession) async {
    guard session.status == .connected,
      let connection = session.selectedConnection
    else { return }
    rememberSelection(connection.id)
    await ensureMonitor(connection: connection, token: session.selectedToken)
    publishBadge()
  }

  private var liveSessions: [WindowSession] {
    sessions.values.compactMap(\.session)
  }

  private func notifySessions() {
    for session in liveSessions {
      session.handleConnectionsChanged()
    }
  }

  private func desiredMonitorIDs() -> Set<UUID> {
    Set(liveSessions.compactMap(\.selectedID))
  }

  private func pruneMonitors() {
    let needed = desiredMonitorIDs()
    for id in monitors.keys where !needed.contains(id) {
      stopMonitor(id)
    }
  }

  private func ensureMonitors() async {
    pruneMonitors()
    for session in liveSessions where session.status == .connected {
      guard let connection = session.selectedConnection else { continue }
      await ensureMonitor(connection: connection, token: session.selectedToken)
    }
    publishBadge()
  }

  private func ensureMonitor(connection: ServerConnection, token: String?) async {
    if let existing = monitors[connection.id],
      existing.token == token,
      existing.connection.origin == connection.origin
    {
      return
    }
    stopMonitor(connection.id)
    await startMonitor(connection: connection, token: token)
  }

  private func startMonitor(connection: ServerConnection, token: String?) async {
    let monitor = ServerActivityMonitor(
      connection: connection,
      token: token
    )
    monitors[connection.id] = monitor
    await refreshActivity(monitor: monitor, allowNotifications: false)
    guard monitors[connection.id] === monitor else { return }
    startLive(monitor: monitor)
  }

  private func stopMonitor(_ connectionID: UUID) {
    monitors[connectionID]?.cancel()
    monitors[connectionID] = nil
  }

  private func startLive(monitor: ServerActivityMonitor) {
    monitor.liveTask?.cancel()
    let connection = monitor.connection
    let token = monitor.token
    let events = liveClient.events(connection: connection, token: token)
    monitor.liveTask = Task { [weak self, weak monitor] in
      guard let monitor else { return }
      for await event in events {
        guard !Task.isCancelled, let self,
          self.monitors[connection.id] === monitor
        else {
          break
        }
        switch event {
        case .connected:
          monitor.tracker.reset()
          self.scheduleRefresh(
            monitor: monitor,
            allowNotifications: false,
            delayNanoseconds: 0
          )
        case .invalidated:
          self.scheduleRefresh(
            monitor: monitor,
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
    monitor: ServerActivityMonitor,
    allowNotifications: Bool,
    delayNanoseconds: UInt64
  ) {
    monitor.refreshTask?.cancel()
    monitor.refreshTask = Task { [weak self, weak monitor] in
      if delayNanoseconds > 0 {
        try? await Task.sleep(nanoseconds: delayNanoseconds)
      }
      guard !Task.isCancelled, let self, let monitor,
        self.monitors[monitor.connection.id] === monitor
      else { return }
      await self.refreshActivity(
        monitor: monitor,
        allowNotifications: allowNotifications
      )
    }
  }

  private func refreshActivity(
    monitor: ServerActivityMonitor,
    allowNotifications: Bool
  ) async {
    let connection = monitor.connection
    do {
      let page = try await api.fetchActivity(
        connection: connection,
        token: monitor.token,
        limit: 50
      )
      guard !Task.isCancelled, monitors[connection.id] === monitor else { return }
      monitor.waitingCount = max(0, page.waitingCount)
      publishBadge()
      let candidates = monitor.tracker.ingest(
        page,
        allowNotifications: allowNotifications && notificationsEnabled,
        appIsActive: NSApplication.shared.isActive
      )
      for candidate in candidates {
        guard monitors[connection.id] === monitor else { return }
        await notifications.deliver(candidate, serverID: connection.id)
      }
    } catch {
      // The web UI remains authoritative. A failed background activity refresh
      // must not replace a healthy session with a connection error screen.
    }
  }

  private func publishBadge() {
    waitingCount = monitors.values.reduce(0) { $0 + $1.waitingCount }
    dockBadge.setWaitingCount(waitingCount)
  }
}

enum ConnectionControllerError: LocalizedError {
  case connectionNotFound

  var errorDescription: String? {
    "That saved server no longer exists."
  }
}

@MainActor
private final class ServerActivityMonitor {
  let connection: ServerConnection
  let token: String?
  var waitingCount = 0
  var liveTask: Task<Void, Never>?
  var refreshTask: Task<Void, Never>?
  var tracker = ActivityNotificationTracker()

  init(connection: ServerConnection, token: String?) {
    self.connection = connection
    self.token = token
  }

  func cancel() {
    liveTask?.cancel()
    refreshTask?.cancel()
    liveTask = nil
    refreshTask = nil
  }
}

private struct WeakSession {
  weak var session: WindowSession?
}
