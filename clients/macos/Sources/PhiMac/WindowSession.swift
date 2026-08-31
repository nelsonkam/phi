import AppKit
import Foundation
import PhiClientCore

@MainActor
final class WindowSession: ObservableObject, Identifiable {
  let id = UUID()

  @Published private(set) var selectedID: UUID?
  @Published private(set) var selectedToken: String?
  @Published private(set) var status: ConnectionController.Status = .idle
  @Published private(set) var navigationRequest: ServerNavigationRequest?
  @Published private(set) var addServerRequest: AddServerRequest?

  weak var window: NSWindow?

  private let controller: ConnectionController
  private var connectAttempt = UUID()
  private var knownOrigin: URL?

  init(controller: ConnectionController) {
    self.controller = controller
    let selection = controller.defaultSelectionID
    selectedID = selection
    selectedToken = controller.token(for: selection)
    knownOrigin = controller.connection(id: selection)?.origin
    controller.register(self)
  }

  deinit {
    let controller = self.controller
    let id = self.id
    Task { @MainActor in
      controller.unregister(id)
    }
  }

  var selectedConnection: ServerConnection? {
    controller.connection(id: selectedID)
  }

  var connectionTaskID: String {
    let origin = selectedConnection?.origin.absoluteString ?? ""
    return "\(selectedID?.uuidString ?? "")|\(origin)|\(selectedToken ?? "")"
  }

  func select(_ id: UUID?) {
    guard selectedID != id else { return }
    connectAttempt = UUID()
    navigationRequest = nil
    selectedID = id
    selectedToken = controller.token(for: id)
    knownOrigin = controller.connection(id: id)?.origin
    controller.rememberSelection(id)
    status = .idle
    controller.sessionSelectionChanged()
  }

  func connect() async {
    guard let connection = selectedConnection else { return }
    let attempt = UUID()
    connectAttempt = attempt
    let connectionID = connection.id
    let origin = connection.origin
    let token = selectedToken
    knownOrigin = origin
    status = .connecting
    controller.sessionSelectionChanged()
    do {
      try await controller.validate(connection: connection, token: token)
      guard isCurrentAttempt(
        attempt,
        connectionID: connectionID,
        origin: origin,
        token: token
      ) else { return }
      status = .connected
      await controller.sessionDidConnect(self)
    } catch is CancellationError {
      return
    } catch {
      guard isCurrentAttempt(
        attempt,
        connectionID: connectionID,
        origin: origin,
        token: token
      ) else { return }
      status = .failed(error.localizedDescription)
      controller.sessionSelectionChanged()
    }
  }

  private func isCurrentAttempt(
    _ attempt: UUID,
    connectionID: UUID,
    origin: URL,
    token: String?
  ) -> Bool {
    connectAttempt == attempt
      && selectedID == connectionID
      && selectedConnection?.origin == origin
      && selectedToken == token
      && !Task.isCancelled
  }

  func add(name: String, origin: String, token: String) async throws {
    let connection = try await controller.add(
      name: name,
      origin: origin,
      token: token
    )
    select(connection.id)
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

  func enqueueNavigation(_ request: ServerNavigationRequest) {
    navigationRequest = request
  }

  func consumeNavigationRequest(_ id: UUID) {
    guard navigationRequest?.id == id else { return }
    navigationRequest = nil
  }

  func open(_ request: ServerNavigationRequest) {
    if selectedID != request.serverID {
      select(request.serverID)
    }
    enqueueNavigation(request)
  }

  func handleConnectionsChanged() {
    if let selectedID, controller.connection(id: selectedID) == nil {
      select(controller.connections.first?.id)
      return
    }
    let nextToken = controller.token(for: selectedID)
    let nextOrigin = selectedConnection?.origin
    if nextToken != selectedToken || nextOrigin != knownOrigin {
      connectAttempt = UUID()
    }
    selectedToken = nextToken
    knownOrigin = nextOrigin
  }
}
