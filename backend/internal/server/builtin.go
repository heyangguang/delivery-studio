package server

import (
	"io/fs"

	"delivery-studio/catalog"
)

func builtinFS() fs.FS { return catalog.FS }
