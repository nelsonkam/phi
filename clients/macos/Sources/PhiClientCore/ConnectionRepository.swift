import Foundation

public final class ConnectionRepository {
  private let defaults: UserDefaults
  private let connectionsKey = "phi.server-connections.v1"
  private let selectionKey = "phi.selected-connection.v1"

  public init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
  }

  public func loadConnections() -> [ServerConnection] {
    guard let data = defaults.data(forKey: connectionsKey),
      let decoded = try? JSONDecoder().decode([ServerConnection].self, from: data)
    else {
      return [.local]
    }
    return decoded.isEmpty ? [.local] : decoded
  }

  public func saveConnections(_ connections: [ServerConnection]) throws {
    defaults.set(try JSONEncoder().encode(connections), forKey: connectionsKey)
  }

  public func loadSelection() -> UUID? {
    guard let raw = defaults.string(forKey: selectionKey) else { return nil }
    return UUID(uuidString: raw)
  }

  public func saveSelection(_ id: UUID?) {
    defaults.set(id?.uuidString, forKey: selectionKey)
  }
}
