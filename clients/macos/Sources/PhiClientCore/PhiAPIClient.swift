import Foundation

public struct PhiAPIClient: @unchecked Sendable {
  private let session: URLSession

  public init(session: URLSession = .shared) {
    self.session = session
  }

  public func validate(
    connection: ServerConnection,
    token: String?
  ) async throws {
    let trimmedToken = token?.trimmingCharacters(in: .whitespacesAndNewlines)
    if connection.requiresCredential && (trimmedToken?.isEmpty != false) {
      throw PhiAPIError.missingCredential
    }

    let data = try await get(
      connection.sessionURL,
      token: trimmedToken
    )

    let result = try? JSONDecoder().decode(SessionResponse.self, from: data)
    guard result?.ok == true else { throw PhiAPIError.invalidResponse }
  }

  public func fetchActivity(
    connection: ServerConnection,
    token: String?,
    limit: Int = 50
  ) async throws -> PhiActivityPage {
    let url = connection.origin
      .appending(path: "api/v1/activity")
      .appending(queryItems: [URLQueryItem(name: "limit", value: String(limit))])
    let data = try await get(url, token: token)
    do {
      return try JSONDecoder().decode(PhiActivityPage.self, from: data)
    } catch {
      throw PhiAPIError.invalidResponse
    }
  }

  private func get(
    _ url: URL,
    token: String?
  ) async throws -> Data {
    var request = URLRequest(url: url)
    request.timeoutInterval = 12
    request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
    if let token, !token.isEmpty {
      request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    }

    let (data, response): (Data, URLResponse)
    do {
      (data, response) = try await session.data(for: request)
    } catch {
      throw PhiAPIError.unreachable(error.localizedDescription)
    }

    guard let http = response as? HTTPURLResponse else {
      throw PhiAPIError.invalidResponse
    }
    if http.statusCode == 401 { throw PhiAPIError.invalidCredential }
    guard (200..<300).contains(http.statusCode) else {
      throw PhiAPIError.serverStatus(http.statusCode)
    }

    return data
  }
}

private struct SessionResponse: Decodable {
  let ok: Bool
}

public enum PhiAPIError: LocalizedError {
  case missingCredential
  case invalidCredential
  case unreachable(String)
  case invalidResponse
  case serverStatus(Int)

  public var errorDescription: String? {
    switch self {
    case .missingCredential:
      "This remote server requires its Phi device token."
    case .invalidCredential:
      "The server rejected this device token."
    case .unreachable(let detail):
      "Could not reach the Phi server: \(detail)"
    case .invalidResponse:
      "The server did not return a valid Phi session response."
    case .serverStatus(let status):
      "The Phi server returned HTTP \(status)."
    }
  }
}
