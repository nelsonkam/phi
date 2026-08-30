import Foundation

public enum DeviceCookie {
  public static let name = "phi-device"

  public static func make(origin: URL, token: String) -> HTTPCookie? {
    guard origin.host != nil, !token.isEmpty else { return nil }
    var properties: [HTTPCookiePropertyKey: Any] = [
      .name: name,
      .value: token,
      .originURL: origin,
      .path: "/",
      .expires: Date(timeIntervalSinceNow: 365 * 24 * 60 * 60),
    ]
    properties[HTTPCookiePropertyKey("HttpOnly")] = "TRUE"
    if origin.scheme == "https" {
      properties[.secure] = "TRUE"
    }
    return HTTPCookie(properties: properties)
  }
}
