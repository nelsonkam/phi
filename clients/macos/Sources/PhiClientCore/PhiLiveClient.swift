import Foundation

public enum PhiLiveEvent: Equatable, Sendable {
  case connected
  case invalidated
  case disconnected
}

public struct PhiLiveClient: @unchecked Sendable {
  private let session: URLSession

  public init(session: URLSession = .shared) {
    self.session = session
  }

  public func events(
    connection: ServerConnection,
    token: String?
  ) -> AsyncStream<PhiLiveEvent> {
    AsyncStream { continuation in
      let task = Task {
        await run(connection: connection, token: token, continuation: continuation)
      }
      continuation.onTermination = { _ in task.cancel() }
    }
  }

  public static func webSocketURL(for connection: ServerConnection) -> URL? {
    guard var components = URLComponents(
      url: connection.origin,
      resolvingAgainstBaseURL: false
    ) else { return nil }
    components.scheme = connection.origin.scheme == "https" ? "wss" : "ws"
    components.path = "/ws"
    components.query = nil
    components.fragment = nil
    return components.url
  }

  private func run(
    connection: ServerConnection,
    token: String?,
    continuation: AsyncStream<PhiLiveEvent>.Continuation
  ) async {
    guard let url = Self.webSocketURL(for: connection) else {
      continuation.finish()
      return
    }

    var retryNanoseconds: UInt64 = 500_000_000
    while !Task.isCancelled {
      var request = URLRequest(url: url)
      request.timeoutInterval = 20
      if let token, !token.isEmpty {
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
      }
      let socket = session.webSocketTask(with: request)
      socket.resume()

      do {
        var announcedConnection = false
        while !Task.isCancelled {
          let message = try await socket.receive()
          let data: Data
          switch message {
          case .data(let value): data = value
          case .string(let value): data = Data(value.utf8)
          @unknown default: continue
          }
          guard let frame = try? JSONDecoder().decode(PhiServerFrame.self, from: data),
            frame.v == 1
          else { continue }
          if !announcedConnection {
            announcedConnection = true
            retryNanoseconds = 500_000_000
            continuation.yield(.connected)
          }
          switch frame.type {
          case .channelUpdated, .messageAppended, .threadUpdated, .threadTurn:
            continuation.yield(.invalidated)
          case .hello, .other:
            break
          }
        }
      } catch {
        // Closed and unreachable sockets flow into the bounded reconnect loop.
      }
      socket.cancel(with: .goingAway, reason: nil)
      if Task.isCancelled { break }
      continuation.yield(.disconnected)
      try? await Task.sleep(nanoseconds: retryNanoseconds)
      retryNanoseconds = min(retryNanoseconds * 2, 10_000_000_000)
    }
    continuation.finish()
  }
}
