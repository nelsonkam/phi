import SwiftUI
import PhiClientCore

struct ContentView: View {
  @ObservedObject var controller: ConnectionController
  @StateObject private var session: WindowSession
  @State private var editingServer: ServerConnection?
  @State private var navigationError: String?
  @State private var pendingRemoval: ServerConnection?

  init(controller: ConnectionController) {
    _controller = ObservedObject(wrappedValue: controller)
    _session = StateObject(wrappedValue: WindowSession(controller: controller))
  }

  var body: some View {
    NavigationSplitView {
      List(selection: selection) {
        Section("Servers") {
          ForEach(controller.connections) { connection in
            Label(connection.name, systemImage: connection.isLoopback ? "desktopcomputer" : "network")
              .tag(connection.id)
              .contextMenu {
                Button("Edit") {
                  editingServer = connection
                }
                Button("Remove", role: .destructive) {
                  pendingRemoval = connection
                }
              }
          }
        }
      }
      .navigationSplitViewColumnWidth(min: 180, ideal: 220)
      .toolbar {
        Button {
          session.presentAddServer()
        } label: {
          Label("Add Server", systemImage: "plus")
        }
      }
    } detail: {
      detail
    }
    .sheet(item: addServerRequest) { request in
      ServerEditorView(mode: .add(request)) { name, origin, token in
        try await session.add(name: name, origin: origin, token: token)
      }
    }
    .sheet(item: $editingServer) { connection in
      ServerEditorView(mode: .edit(connection)) { name, origin, token in
        try await controller.edit(
          connection,
          name: name,
          origin: origin,
          token: token
        )
      }
    }
    .confirmationDialog(
      "Remove \(pendingRemoval?.name ?? "server")?",
      isPresented: Binding(
        get: { pendingRemoval != nil },
        set: { if !$0 { pendingRemoval = nil } }
      )
    ) {
      Button("Remove Server", role: .destructive) {
        if let pendingRemoval {
          Task {
            do {
              try await controller.remove(pendingRemoval)
            } catch {
              navigationError = error.localizedDescription
            }
          }
        }
        pendingRemoval = nil
      }
    } message: {
      Text("This removes the saved server and deletes its device token from Keychain.")
    }
    .task(id: session.connectionTaskID) {
      navigationError = nil
      await session.connect()
    }
    .background {
      MainWindowReader { session.window = $0 }
        .frame(width: 0, height: 0)
    }
  }

  @ViewBuilder
  private var detail: some View {
    if let connection = session.selectedConnection {
      ZStack(alignment: .top) {
        if case .connected = session.status {
          ServerWebView(
            connection: connection,
            token: session.selectedToken,
            navigationRequest: session.navigationRequest,
            onNavigationConsumed: { session.consumeNavigationRequest($0) },
            onNavigationError: { navigationError = $0 }
          )
          .id(connection.id)
        } else if case .connecting = session.status {
          ProgressView("Connecting to \(connection.name)…")
        } else {
          connectionFailure(connection)
        }

        if let navigationError {
          errorBanner(navigationError)
        }
      }
      .navigationTitle(connection.name)
      .toolbar {
        Button {
          Task { await session.connect() }
        } label: {
          Label("Reconnect", systemImage: "arrow.clockwise")
        }
      }
    } else {
      ContentUnavailableView(
        "No Phi Server",
        systemImage: "network.slash",
        description: Text("Add a server to begin.")
      )
    }
  }

  private func connectionFailure(_ connection: ServerConnection) -> some View {
    VStack(spacing: 14) {
      Image(systemName: "exclamationmark.triangle")
        .font(.system(size: 34))
        .foregroundStyle(.secondary)
      Text("Could not connect to \(connection.name)")
        .font(.headline)
      if case .failed(let message) = session.status {
        Text(message)
          .foregroundStyle(.secondary)
          .multilineTextAlignment(.center)
          .frame(maxWidth: 440)
      }
      Button("Try Again") {
        Task { await session.connect() }
      }
    }
  }

  private func errorBanner(_ message: String) -> some View {
    HStack {
      Image(systemName: "wifi.exclamationmark")
      Text(message).lineLimit(2)
      Spacer()
      Button("Dismiss") { navigationError = nil }
    }
    .padding(10)
    .background(.regularMaterial)
    .clipShape(RoundedRectangle(cornerRadius: 8))
    .padding(12)
  }

  private var selection: Binding<UUID?> {
    Binding(
      get: { session.selectedID },
      set: { session.select($0) }
    )
  }

  private var addServerRequest: Binding<AddServerRequest?> {
    Binding(
      get: { session.addServerRequest },
      set: { if $0 == nil { session.dismissAddServer() } }
    )
  }
}
