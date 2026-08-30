import AppKit
import SwiftUI

struct MainWindowReader: NSViewRepresentable {
  let onWindow: (NSWindow) -> Void

  func makeNSView(context: Context) -> WindowProbeView {
    WindowProbeView(onWindow: onWindow)
  }

  func updateNSView(_ view: WindowProbeView, context: Context) {
    view.onWindow = onWindow
    view.reportWindow()
  }

  @MainActor
  final class WindowProbeView: NSView {
    var onWindow: (NSWindow) -> Void

    init(onWindow: @escaping (NSWindow) -> Void) {
      self.onWindow = onWindow
      super.init(frame: .zero)
      isHidden = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
      fatalError("init(coder:) has not been implemented")
    }

    override func viewDidMoveToWindow() {
      super.viewDidMoveToWindow()
      reportWindow()
    }

    func reportWindow() {
      if let window { onWindow(window) }
    }
  }
}
