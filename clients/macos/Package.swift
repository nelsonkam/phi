// swift-tools-version: 6.0

import PackageDescription

let package = Package(
  name: "PhiMac",
  platforms: [.macOS(.v14)],
  products: [
    .library(name: "PhiClientCore", targets: ["PhiClientCore"]),
    .executable(name: "PhiMac", targets: ["PhiMac"]),
  ],
  targets: [
    .target(name: "PhiClientCore"),
    .executableTarget(
      name: "PhiMac",
      dependencies: ["PhiClientCore"]
    ),
    .testTarget(
      name: "PhiClientCoreTests",
      dependencies: ["PhiClientCore", "PhiMac"]
    ),
  ]
)
