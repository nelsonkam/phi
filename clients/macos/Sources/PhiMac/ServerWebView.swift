import AppKit
import SwiftUI
import WebKit
import PhiClientCore

struct ServerWebView: NSViewRepresentable {
  let connection: ServerConnection
  let token: String?
  let navigationRequest: ServerNavigationRequest?
  let onNavigationConsumed: (UUID) -> Void
  let onNavigationError: (String) -> Void

  func makeCoordinator() -> Coordinator {
    Coordinator(
      onNavigationConsumed: onNavigationConsumed,
      onNavigationError: onNavigationError
    )
  }

  func makeNSView(context: Context) -> WKWebView {
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .default()
    let webView = WKWebView(frame: .zero, configuration: configuration)
    webView.navigationDelegate = context.coordinator
    webView.uiDelegate = context.coordinator
    webView.allowsMagnification = true
    webView.allowsBackForwardNavigationGestures = true
    webView.customUserAgent = "PhiMac/0.1"
    context.coordinator.load(
      connection: connection,
      token: token,
      navigationRequest: navigationRequest,
      in: webView
    )
    return webView
  }

  func updateNSView(_ webView: WKWebView, context: Context) {
    context.coordinator.onNavigationConsumed = onNavigationConsumed
    context.coordinator.onNavigationError = onNavigationError
    context.coordinator.load(
      connection: connection,
      token: token,
      navigationRequest: navigationRequest,
      in: webView
    )
  }

  @MainActor
  final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
    var onNavigationConsumed: (UUID) -> Void
    var onNavigationError: (String) -> Void
    private var loadedOrigin: URL?
    private var loadedToken: String?
    private var origin: URL?
    private var lastNavigationRequestID: UUID?

    init(
      onNavigationConsumed: @escaping (UUID) -> Void,
      onNavigationError: @escaping (String) -> Void
    ) {
      self.onNavigationConsumed = onNavigationConsumed
      self.onNavigationError = onNavigationError
    }

    func load(
      connection: ServerConnection,
      token: String?,
      navigationRequest: ServerNavigationRequest?,
      in webView: WKWebView
    ) {
      let target = navigationRequest?.destinationURL(for: connection)
        ?? connection.origin
      let credentialsChanged = loadedOrigin != connection.origin
        || loadedToken != token
      let navigationChanged = navigationRequest?.id != lastNavigationRequestID
        && navigationRequest?.serverID == connection.id
      guard credentialsChanged || navigationChanged else { return }
      loadedOrigin = connection.origin
      loadedToken = token
      origin = connection.origin
      if navigationChanged { lastNavigationRequestID = navigationRequest?.id }

      let navigationWasAccepted = navigationChanged ? navigationRequest?.id : nil

      guard let token, !token.isEmpty else {
        webView.load(URLRequest(url: target))
        if let navigationWasAccepted {
          onNavigationConsumed(navigationWasAccepted)
        }
        return
      }
      guard let cookie = DeviceCookie.make(origin: connection.origin, token: token) else {
        onNavigationError("Could not create the server authentication cookie.")
        return
      }
      webView.configuration.websiteDataStore.httpCookieStore.setCookie(cookie) {
        webView.load(URLRequest(url: target))
        if let navigationWasAccepted {
          self.onNavigationConsumed(navigationWasAccepted)
        }
      }
    }

    func webView(
      _ webView: WKWebView,
      decidePolicyFor navigationAction: WKNavigationAction,
      decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void
    ) {
      guard let target = navigationAction.request.url, let origin else {
        decisionHandler(.allow)
        return
      }

      if navigationAction.targetFrame == nil {
        decisionHandler(.cancel)
        // Start the replacement navigation after WebKit has finished cancelling
        // the window-creation request; loading synchronously here is cancelled too.
        Task { @MainActor in
          self.open(target, relativeTo: origin, in: webView)
        }
        return
      }

      guard navigationAction.targetFrame?.isMainFrame == true else {
        decisionHandler(.allow)
        return
      }

      if sameOrigin(target, origin) {
        decisionHandler(.allow)
      } else {
        NSWorkspace.shared.open(target)
        decisionHandler(.cancel)
      }
    }

    func webView(
      _ webView: WKWebView,
      createWebViewWith configuration: WKWebViewConfiguration,
      for navigationAction: WKNavigationAction,
      windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
      guard navigationAction.targetFrame == nil,
        let target = navigationAction.request.url,
        let origin
      else { return nil }
      open(target, relativeTo: origin, in: webView)
      return nil
    }

    func webView(
      _ webView: WKWebView,
      didFail navigation: WKNavigation!,
      withError error: Error
    ) {
      guard !isExpectedCancellation(error) else { return }
      onNavigationError(error.localizedDescription)
    }

    func webView(
      _ webView: WKWebView,
      didFailProvisionalNavigation navigation: WKNavigation!,
      withError error: Error
    ) {
      guard !isExpectedCancellation(error) else { return }
      onNavigationError(error.localizedDescription)
    }

    private func open(_ target: URL, relativeTo origin: URL, in webView: WKWebView) {
      if sameOrigin(target, origin) {
        webView.load(URLRequest(url: target))
      } else {
        NSWorkspace.shared.open(target)
      }
    }

    private func isExpectedCancellation(_ error: Error) -> Bool {
      let error = error as NSError
      return (error.domain == NSURLErrorDomain && error.code == NSURLErrorCancelled)
        || (error.domain == WKErrorDomain
          // WebKit exposes this as WKErrorFrameLoadInterruptedByPolicyChange in Obj-C,
          // but the Swift SDK does not vend a WKError.Code case for it.
          && error.code == 102)
    }

    private func sameOrigin(_ left: URL, _ right: URL) -> Bool {
      left.scheme?.lowercased() == right.scheme?.lowercased()
        && left.host?.lowercased() == right.host?.lowercased()
        && effectivePort(left) == effectivePort(right)
    }

    private func effectivePort(_ url: URL) -> Int? {
      url.port ?? (url.scheme == "https" ? 443 : url.scheme == "http" ? 80 : nil)
    }
  }
}
