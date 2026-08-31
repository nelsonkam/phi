import AppKit
import Testing
@testable import PhiMac

@MainActor
@Test func fileOpenPanelHonorsSelectionAndDirectoryFlags() {
  let panel = fileOpenPanel(allowsMultipleSelection: true, allowsDirectories: false)
  #expect(panel.canChooseFiles)
  #expect(!panel.canChooseDirectories)
  #expect(panel.allowsMultipleSelection)
  #expect(panel.resolvesAliases)

  let folders = fileOpenPanel(allowsMultipleSelection: false, allowsDirectories: true)
  #expect(folders.canChooseFiles)
  #expect(folders.canChooseDirectories)
  #expect(!folders.allowsMultipleSelection)
}

@Test func fileOpenPanelReturnsURLsOnlyWhenConfirmed() {
  let urls = [URL(fileURLWithPath: "/tmp/notes.md")]
  #expect(fileOpenPanelURLs(response: .OK, urls: urls) == urls)
  #expect(fileOpenPanelURLs(response: .cancel, urls: urls) == nil)
}

@MainActor
@Test func coordinatorAdvertisesTheWebKitOpenPanelSelector() {
  let coordinator = ServerWebView.Coordinator(
    onNavigationConsumed: { _ in },
    onNavigationError: { _ in }
  )
  #expect(
    coordinator.responds(
      to: NSSelectorFromString(
        "webView:runOpenPanelWithParameters:initiatedByFrame:completionHandler:"
      )
    )
  )
}
