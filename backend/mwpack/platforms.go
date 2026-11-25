package mwpack

import "fmt"

// PlatformDef describes a target operating system a delivery can be built for.
type PlatformDef struct {
	ID     string `json:"id"`
	Title  string `json:"title"`
	Family string `json:"family"` // apt | rpm
	// OSIDs are the accepted values of ID= in /etc/os-release; Version matches VERSION_ID exactly or as a major prefix.
	OSIDs   []string `json:"os_ids"`
	Version string   `json:"version"`
	Arch    string   `json:"arch"` // amd64
	// Image is the container image used to resolve and download packages for this platform (library preparation only).
	Image string `json:"image"`
	// ControllerPackages are what the controller machine needs before Ansible can run on it (a newer Python than the
	// system's). Every delivery for the platform carries them in its repository, and the library must hold them.
	ControllerPackages []PackageRequest `json:"controller_packages,omitempty"`
}

// Platforms are the operating systems the platform knows how to resolve packages for. Adding one means adding its
// definition here and its package sources in pkglib/sources.yaml, then proving it with the container verification.
var Platforms = []PlatformDef{
	{ID: "ubuntu-24.04-amd64", Title: "Ubuntu 24.04 (amd64)", Family: "apt", OSIDs: []string{"ubuntu"}, Version: "24.04", Arch: "amd64", Image: "ubuntu:24.04"},
	{ID: "el9-amd64", Title: "RedHat 系 9（RHEL / Rocky / Alma）(amd64)", Family: "rpm", OSIDs: []string{"rhel", "rocky", "almalinux", "centos"}, Version: "9", Arch: "amd64", Image: "rockylinux:9",
		ControllerPackages: []PackageRequest{{Name: "python3.12", Version: "3.12.15-1.el9_8"}}},
}

// DefaultPlatform is used when a deployment does not choose one and every component supports it.
const DefaultPlatform = "ubuntu-24.04-amd64"

func PlatformByID(id string) (PlatformDef, bool) {
	for _, p := range Platforms {
		if p.ID == id {
			return p, true
		}
	}
	return PlatformDef{}, false
}

// RepoPort is where the controller serves the offline package repository.
const RepoPort = 8080

// PackageSpec is how the package manager of the family names an exact version.
func PackageSpec(family, name, version string) string {
	if version == "" {
		return name
	}
	if family == "rpm" {
		return name + "-" + version
	}
	return name + "=" + version
}

// PackageRequest is one exact package the delivery needs on a platform.
type PackageRequest struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

func (r PackageRequest) Key() string { return fmt.Sprintf("%s=%s", r.Name, r.Version) }
