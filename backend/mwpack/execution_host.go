package mwpack

// PackageBase keeps independent clusters from overwriting another cluster's
// runtime, SSH preparation inventory, or locally generated credentials.
func (p *Plan) PackageBase() string {
	if p.Dep.ExecutionHost != nil {
		return "/root/middleware-executions/" + p.Dep.ID
	}
	return "/root"
}

func (p *Plan) RuntimeRoot() string { return p.PackageBase() + "/middleware-automation" }

// DeliveryHosts includes the independent execution machine for packaging, SSH
// preparation and inventory only. Business placement and disk operations use Hosts.
// Append it to preserve the numbering of existing target archives.
func (p *Plan) DeliveryHosts() []Host {
	if p.Dep.ExecutionHost == nil {
		return p.Hosts
	}
	h := append([]Host(nil), p.Hosts...)
	e := p.Dep.ExecutionHost
	return append(h, Host{Name: e.Name, IP: e.IP})
}

func (p *Plan) RepositoryPort() int {
	if e := p.Dep.ExecutionHost; e != nil {
		return e.RepositoryPort
	}
	return RepoPort
}

func sameExecutionHost(a, b *ExecutionHost) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}
