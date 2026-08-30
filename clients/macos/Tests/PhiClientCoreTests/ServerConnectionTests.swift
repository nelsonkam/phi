import Foundation
import Testing
@testable import PhiClientCore
@testable import PhiMac

@Test func normalizesOriginsAndRequiresHTTPSRemotely() throws {
  let remote = try ServerConnection(name: "Remote", origin: "HTTPS://Phi.Example.COM/")
  #expect(remote.origin.absoluteString == "https://phi.example.com")
  #expect(remote.requiresCredential)

  let local = try ServerConnection(name: "Local", origin: "http://localhost:3141/")
  #expect(local.origin.absoluteString == "http://localhost:3141")
  #expect(!local.requiresCredential)

  #expect(throws: ServerConnectionError.remoteOriginRequiresHTTPS) {
    try ServerConnection(name: "Unsafe", origin: "http://phi.example.com")
  }
  #expect(throws: ServerConnectionError.originMustNotContainPath) {
    try ServerConnection(name: "Path", origin: "https://phi.example.com/app")
  }
}

@Test func persistsConnectionsAndSelection() throws {
  let suite = "PhiClientCoreTests.\(UUID().uuidString)"
  let defaults = UserDefaults(suiteName: suite)!
  defer { defaults.removePersistentDomain(forName: suite) }
  let repository = ConnectionRepository(defaults: defaults)

  #expect(repository.loadConnections() == [.local])
  let remote = try ServerConnection(name: "Remote", origin: "https://phi.example.com")
  try repository.saveConnections([.local, remote])
  repository.saveSelection(remote.id)

  #expect(repository.loadConnections() == [.local, remote])
  #expect(repository.loadSelection() == remote.id)
}

@Test func createsAnOriginScopedHttpOnlyDeviceCookie() throws {
  let remote = try ServerConnection(name: "Remote", origin: "https://phi.example.com")
  let cookie = try #require(DeviceCookie.make(origin: remote.origin, token: "secret"))
  #expect(cookie.name == "phi-device")
  #expect(cookie.domain == "phi.example.com")
  #expect(cookie.path == "/")
  #expect(cookie.isHTTPOnly)
  #expect(cookie.isSecure)
}

@Test func loopbackCookieIsHostOnlyAndNotSecure() throws {
  let local = try ServerConnection(name: "Local", origin: "http://localhost:3141")
  let cookie = try #require(DeviceCookie.make(origin: local.origin, token: "secret"))
  #expect(cookie.domain == "localhost")
  #expect(!cookie.domain.hasPrefix("."))
  #expect(cookie.isHTTPOnly)
  #expect(!cookie.isSecure)
}

@MainActor
@Test func removingAConnectionClearsItsCookieAndCredential() async throws {
  let suite = "PhiClientCoreTests.\(UUID().uuidString)"
  let defaults = UserDefaults(suiteName: suite)!
  defer { defaults.removePersistentDomain(forName: suite) }
  let repository = ConnectionRepository(defaults: defaults)
  let credentials = RecordingCredentialStore()
  let cookies = RecordingCookieStore()
  let remote = try ServerConnection(name: "Remote", origin: "https://phi.example.com")
  try repository.saveConnections([.local, remote])
  try credentials.save(token: "secret", for: remote.id)

  let controller = ConnectionController(
    repository: repository,
    credentials: credentials,
    cookieStore: cookies
  )
  try await controller.remove(remote)

  #expect(cookies.deletedOrigins == [remote.origin])
  #expect(try credentials.token(for: remote.id) == nil)
  #expect(controller.connections == [.local])
}

@MainActor
@Test func editingAConnectionPreservesIdentityAndCredential() async throws {
  let suite = "PhiClientCoreTests.\(UUID().uuidString)"
  let defaults = UserDefaults(suiteName: suite)!
  defer { defaults.removePersistentDomain(forName: suite) }
  let repository = ConnectionRepository(defaults: defaults)
  let credentials = RecordingCredentialStore()
  let cookies = RecordingCookieStore()
  let remote = try ServerConnection(name: "Remote", origin: "https://phi.example.com")
  try repository.saveConnections([remote])
  repository.saveSelection(remote.id)
  try credentials.save(token: "secret", for: remote.id)

  let controller = ConnectionController(
    repository: repository,
    credentials: credentials,
    cookieStore: cookies
  )
  try await controller.edit(
    remote,
    name: "Renamed",
    origin: remote.origin.absoluteString,
    token: ""
  )

  let edited = try #require(controller.selectedConnection)
  #expect(edited.id == remote.id)
  #expect(edited.name == "Renamed")
  #expect(edited.origin == remote.origin)
  #expect(try credentials.token(for: remote.id) == "secret")
  #expect(cookies.deletedOrigins.isEmpty)
}

private final class RecordingCredentialStore: CredentialStore {
  private var tokens: [UUID: String] = [:]

  func token(for connectionID: UUID) throws -> String? { tokens[connectionID] }
  func save(token: String, for connectionID: UUID) throws { tokens[connectionID] = token }
  func deleteToken(for connectionID: UUID) throws { tokens[connectionID] = nil }
}

@MainActor
private final class RecordingCookieStore: DeviceCookieClearing {
  private(set) var deletedOrigins: [URL] = []

  func deleteDeviceCookie(for origin: URL) async {
    deletedOrigins.append(origin)
  }
}
