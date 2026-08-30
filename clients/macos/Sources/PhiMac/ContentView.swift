import SwiftUI
import PhiClientCore

struct ContentView: View {
  @ObservedObject var controller: ConnectionController
  @State private var showingAddServer = false
  @State private var editingServer: ServerConnection?
  @State private var navigationError: String?
  @State private var pendingRemoval: ServerConnection?

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
          showingAddServer = true
        } label: {
          Label("Add Server", systemImage: "plus")
        }
      }
    } detail: {
      detail
    }
    .sheet(isPresented: $showingAddServer) {
      ServerEditorView(mode: .add) { name, origin, token in
        try await controller.add(name: name, origin: origin, token: token)
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
    .task(id: controller.selectedID) {
      navigationError = nil
      await controller.connectSelected()
    }
  }

  @ViewBuilder
  private var detail: some View {
    if let connection = controller.selectedConnection {
      ZStack(alignment: .top) {
        if case .connected = controller.status {
          ServerWebView(
            connection: connection,
            token: controller.selectedToken,
            onNavigationError: { navigationError = $0 }
          )
        } else if case .connecting = controller.status {
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
          Task { await controller.connectSelected() }
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
      if case .failed(let message) = controller.status {
        Text(message)
          .foregroundStyle(.secondary)
          .multilineTextAlignment(.center)
          .frame(maxWidth: 440)
      }
      Button("Try Again") {
        Task { await controller.connectSelected() }
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
      get: { controller.selectedID },
      set: { controller.select($0) }
    )
  }
}
