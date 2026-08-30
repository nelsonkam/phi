import Foundation
import WebKit
import PhiClientCore

@MainActor
protocol DeviceCookieClearing {
  func deleteDeviceCookie(for origin: URL) async
}

@MainActor
struct WebKitDeviceCookieStore: DeviceCookieClearing {
  private let store: WKHTTPCookieStore

  init(store: WKHTTPCookieStore = WKWebsiteDataStore.default().httpCookieStore) {
    self.store = store
  }

  func deleteDeviceCookie(for origin: URL) async {
    guard let host = origin.host?.lowercased() else { return }
    let cookies = await allCookies()
    for cookie in cookies where cookie.name == DeviceCookie.name
      && cookie.domain.trimmingCharacters(in: CharacterSet(charactersIn: ".")).lowercased() == host
    {
      await delete(cookie)
    }
  }

  private func allCookies() async -> [HTTPCookie] {
    await withCheckedContinuation { continuation in
      store.getAllCookies { continuation.resume(returning: $0) }
    }
  }

  private func delete(_ cookie: HTTPCookie) async {
    await withCheckedContinuation { continuation in
      store.delete(cookie) { continuation.resume() }
    }
  }
}
