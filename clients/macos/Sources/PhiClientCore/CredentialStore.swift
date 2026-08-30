import Foundation
import Security

public protocol CredentialStore {
  func token(for connectionID: UUID) throws -> String?
  func save(token: String, for connectionID: UUID) throws
  func deleteToken(for connectionID: UUID) throws
}

public final class KeychainCredentialStore: CredentialStore {
  private let service: String

  public init(service: String = "app.phi.mac.device-token") {
    self.service = service
  }

  public func token(for connectionID: UUID) throws -> String? {
    var query = baseQuery(connectionID)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne

    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let data = result as? Data,
      let token = String(data: data, encoding: .utf8)
    else {
      throw CredentialStoreError.keychain(status)
    }
    return token
  }

  public func save(token: String, for connectionID: UUID) throws {
    let trimmed = token.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { throw CredentialStoreError.emptyToken }

    var query = baseQuery(connectionID)
    let data = Data(trimmed.utf8)
    let update = [kSecValueData as String: data]
    let updateStatus = SecItemUpdate(query as CFDictionary, update as CFDictionary)
    if updateStatus == errSecSuccess { return }
    guard updateStatus == errSecItemNotFound else {
      throw CredentialStoreError.keychain(updateStatus)
    }

    query[kSecValueData as String] = data
    query[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
    let addStatus = SecItemAdd(query as CFDictionary, nil)
    guard addStatus == errSecSuccess else {
      throw CredentialStoreError.keychain(addStatus)
    }
  }

  public func deleteToken(for connectionID: UUID) throws {
    let status = SecItemDelete(baseQuery(connectionID) as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw CredentialStoreError.keychain(status)
    }
  }

  private func baseQuery(_ connectionID: UUID) -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: connectionID.uuidString,
    ]
  }
}

public enum CredentialStoreError: LocalizedError {
  case emptyToken
  case keychain(OSStatus)

  public var errorDescription: String? {
    switch self {
    case .emptyToken:
      "Enter the device token from the Phi server."
    case .keychain(let status):
      "Keychain operation failed (\(status))."
    }
  }
}
