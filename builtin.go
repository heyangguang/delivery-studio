package main

import (
	"io/fs"

	"middleware-deployer/catalog"
)

func builtinFS() fs.FS { return catalog.FS }
