import Foundation
import PhiClientCore

struct AddServerRequest: Equatable, Identifiable {
  let id: UUID
  let name: String
  let origin: String

  init(id: UUID = UUID(), name: String = "", origin: String = "https://") {
    self.id = id
    self.name = name
    self.origin = origin
  }

  init?(deepLink: URL, id: UUID = UUID()) {
    guard deepLink.scheme?.lowercased() == "phi",
      deepLink.host?.lowercased() == "add-server",
      deepLink.path.isEmpty || deepLink.path == "/",
      deepLink.fragment == nil,
      let components = URLComponents(url: deepLink, resolvingAgainstBaseURL: false)
    else { return nil }

    var values: [String: String] = [:]
    for item in components.queryItems ?? [] {
      guard (item.name == "origin" || item.name == "name"),
        values[item.name] == nil,
        let value = item.value, !value.isEmpty
      else { return nil }
      values[item.name] = value
    }
    guard let rawOrigin = values["origin"] else { return nil }
    let requestedName = values["name"]?.trimmingCharacters(in: .whitespacesAndNewlines)
    let fallbackName = URL(string: rawOrigin)?.host ?? "Phi Server"
    let resolvedName = requestedName?.isEmpty == false ? requestedName! : fallbackName
    guard let connection = try? ServerConnection(
      name: resolvedName,
      origin: rawOrigin
    ) else { return nil }

    self.id = id
    name = connection.name
    origin = connection.origin.absoluteString
  }
}
