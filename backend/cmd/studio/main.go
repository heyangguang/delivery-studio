package main

import "delivery-studio/internal/server"

// buildID is injected via -ldflags "-X main.buildID=..." during builds.
var buildID = ""

func main() {
	server.SetBuildID(buildID)
	server.Main()
}
