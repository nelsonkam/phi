import Foundation
import PhiClientCore

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

  private let repository: ConnectionRepository
  private let credentials: CredentialStore
  private let api: PhiAPIClient
  private let cookieStore: DeviceCookieClearing

  init(
    repository: ConnectionRepository = ConnectionRepository(),
    credentials: CredentialStore = KeychainCredentialStore(),
    api: PhiAPIClient = PhiAPIClient(),
    cookieStore: DeviceCookieClearing = WebKitDeviceCookieStore()
  ) {
    self.repository = repository
    self.credentials = credentials
    self.api = api
    self.cookieStore = cookieStore
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
    selectedID = id
    selectedToken = id.flatMap { try? credentials.token(for: $0) }
    repository.saveSelection(id)
    status = .idle
  }

  func connectSelected() async {
    guard let connection = selectedConnection else { return }
    status = .connecting
    do {
      try await api.validate(connection: connection, token: selectedToken)
      status = .connected
    } catch {
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
    let nextToken: String? = if candidate.requiresCredential {
      replacementToken.isEmpty ? savedToken : replacementToken
    } else {
      nil
    }
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
      status = originChanged || tokenChanged ? .connected : status
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
}

enum ConnectionControllerError: LocalizedError {
  case connectionNotFound

  var errorDescription: String? {
    "That saved server no longer exists."
  }
}
