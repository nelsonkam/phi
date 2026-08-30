import Foundation

public struct ServerConnection: Codable, Equatable, Identifiable, Sendable {
  public static let local = try! ServerConnection(
    id: UUID(uuidString: "00000000-0000-0000-0000-000000000001")!,
    name: "This Mac",
    origin: "http://127.0.0.1:3141"
  )

  public let id: UUID
  public var name: String
  public var origin: URL

  public init(id: UUID = UUID(), name: String, origin: String) throws {
    let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmedName.isEmpty else {
      throw ServerConnectionError.missingName
    }

    guard var components = URLComponents(
      string: origin.trimmingCharacters(in: .whitespacesAndNewlines)
    ), let scheme = components.scheme?.lowercased(),
      let host = components.host?.lowercased(), !host.isEmpty
    else {
      throw ServerConnectionError.invalidOrigin
    }

    guard components.user == nil, components.password == nil,
      components.query == nil, components.fragment == nil
    else {
      throw ServerConnectionError.originMustNotContainCredentialsOrQuery
    }

    guard components.path.isEmpty || components.path == "/" else {
      throw ServerConnectionError.originMustNotContainPath
    }

    let loopback = Self.isLoopbackHost(host)
    guard scheme == "https" || (scheme == "http" && loopback) else {
      throw ServerConnectionError.remoteOriginRequiresHTTPS
    }

    components.scheme = scheme
    components.host = host
    components.path = ""
    guard let normalized = components.url else {
      throw ServerConnectionError.invalidOrigin
    }

    self.id = id
    self.name = trimmedName
    self.origin = normalized
  }

  public var isLoopback: Bool {
    guard let host = origin.host?.lowercased() else { return false }
    return Self.isLoopbackHost(host)
  }

  public var requiresCredential: Bool { !isLoopback }

  public var sessionURL: URL {
    origin.appendingPathComponent("api/v1/auth/session")
  }

  private static func isLoopbackHost(_ host: String) -> Bool {
    host == "127.0.0.1" || host == "::1" || host == "localhost"
      || host.hasSuffix(".localhost")
  }
}

public enum ServerConnectionError: LocalizedError, Equatable {
  case missingName
  case invalidOrigin
  case originMustNotContainCredentialsOrQuery
  case originMustNotContainPath
  case remoteOriginRequiresHTTPS

  public var errorDescription: String? {
    switch self {
    case .missingName:
      "Give this server a name."
    case .invalidOrigin:
      "Enter a complete server URL, such as https://phi.example.com."
    case .originMustNotContainCredentialsOrQuery:
      "The server URL cannot contain credentials, a query, or a fragment."
    case .originMustNotContainPath:
      "Enter the server origin without a path."
    case .remoteOriginRequiresHTTPS:
      "Remote Phi servers must use HTTPS. Plain HTTP is allowed only for localhost."
    }
  }
}
