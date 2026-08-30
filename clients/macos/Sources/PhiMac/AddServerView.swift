import SwiftUI
import PhiClientCore

struct ServerEditorView: View {
  enum Mode {
    case add
    case edit(ServerConnection)

    var title: String {
      switch self {
      case .add: "Add Phi Server"
      case .edit: "Edit Phi Server"
      }
    }

    var actionTitle: String {
      switch self {
      case .add: "Connect"
      case .edit: "Save"
      }
    }

    var isEditing: Bool {
      if case .edit = self { true } else { false }
    }
  }

  @Environment(\.dismiss) private var dismiss
  @State private var name: String
  @State private var origin: String
  @State private var token = ""
  @State private var error: String?
  @State private var isConnecting = false

  let mode: Mode
  let onSave: (String, String, String) async throws -> Void

  init(
    mode: Mode,
    onSave: @escaping (String, String, String) async throws -> Void
  ) {
    self.mode = mode
    self.onSave = onSave
    switch mode {
    case .add:
      _name = State(initialValue: "")
      _origin = State(initialValue: "https://")
    case .edit(let connection):
      _name = State(initialValue: connection.name)
      _origin = State(initialValue: connection.origin.absoluteString)
    }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      VStack(alignment: .leading, spacing: 4) {
        Text(mode.title).font(.title2.weight(.semibold))
        Text("Remote servers require HTTPS and the device token stored by that Phi server.")
          .font(.callout)
          .foregroundStyle(.secondary)
      }

      Form {
        TextField("Name", text: $name, prompt: Text("Home server"))
        TextField("Server URL", text: $origin, prompt: Text("https://phi.example.com"))
          .textContentType(.URL)
        SecureField("Device token", text: $token)
          .textContentType(.password)
      }
      .formStyle(.grouped)

      Text(tokenHelp)
        .font(.caption)
        .foregroundStyle(.secondary)
        .textSelection(.enabled)

      if let error {
        Text(error)
          .font(.callout)
          .foregroundStyle(.red)
      }

      HStack {
        Spacer()
        Button("Cancel") { dismiss() }
          .keyboardShortcut(.cancelAction)
        Button(isConnecting ? workingTitle : mode.actionTitle) {
          save()
        }
        .keyboardShortcut(.defaultAction)
        .disabled(isConnecting)
      }
    }
    .padding(24)
    .frame(width: 480)
  }

  private var tokenHelp: String {
    if mode.isEditing {
      "Leave the token blank to keep the saved credential. Enter a token to replace it."
    } else {
      "Find the token in `$PHI_ROOT/device-token` on the server, or use the configured `PHI_API_TOKEN`."
    }
  }

  private var workingTitle: String {
    mode.isEditing ? "Saving…" : "Connecting…"
  }

  private func save() {
    error = nil
    isConnecting = true
    Task {
      do {
        try await onSave(name, origin, token)
        dismiss()
      } catch {
        self.error = error.localizedDescription
      }
      isConnecting = false
    }
  }
}
