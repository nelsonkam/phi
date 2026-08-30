import Foundation

public struct PhiActivityThread: Decodable, Equatable, Sendable {
  public let id: String
  public let title: String?

  public init(id: String, title: String?) {
    self.id = id
    self.title = title
  }
}

public struct PhiActivityMessage: Decodable, Equatable, Sendable {
  public let id: String
  public let author: String
  public let content: String

  public init(id: String, author: String, content: String) {
    self.id = id
    self.author = author
    self.content = content
  }
}

public struct PhiActivityItem: Decodable, Equatable, Sendable {
  public let thread: PhiActivityThread
  public let channelName: String
  public let latestMessage: PhiActivityMessage
  public let unreadCount: Int

  public init(
    thread: PhiActivityThread,
    channelName: String,
    latestMessage: PhiActivityMessage,
    unreadCount: Int
  ) {
    self.thread = thread
    self.channelName = channelName
    self.latestMessage = latestMessage
    self.unreadCount = unreadCount
  }
}

public struct PhiActivityPage: Decodable, Equatable, Sendable {
  public let activity: [PhiActivityItem]
  public let waitingCount: Int

  public init(activity: [PhiActivityItem], waitingCount: Int) {
    self.activity = activity
    self.waitingCount = waitingCount
  }
}

public struct PhiServerFrame: Decodable, Equatable, Sendable {
  public enum Kind: Decodable, Equatable, Sendable {
    case hello
    case channelUpdated
    case messageAppended
    case threadUpdated
    case threadTurn
    case other(String)

    public init(from decoder: Decoder) throws {
      let raw = try decoder.singleValueContainer().decode(String.self)
      self = switch raw {
      case "hello": .hello
      case "channel.updated": .channelUpdated
      case "message.appended": .messageAppended
      case "thread.updated": .threadUpdated
      case "thread.turn": .threadTurn
      default: .other(raw)
      }
    }
  }

  public let v: Int
  public let type: Kind
}
