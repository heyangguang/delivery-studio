package pkglib

import (
	"strconv"
	"strings"
)

// CompareDeb orders two Debian version strings the way dpkg does (epoch, upstream version, revision).
func CompareDeb(a, b string) int {
	ea, ua, ra := splitDeb(a)
	eb, ub, rb := splitDeb(b)
	if ea != eb {
		if ea < eb {
			return -1
		}
		return 1
	}
	if c := debPart(ua, ub); c != 0 {
		return c
	}
	return debPart(ra, rb)
}

func splitDeb(v string) (epoch int, upstream, revision string) {
	if i := strings.IndexByte(v, ':'); i >= 0 {
		epoch, _ = strconv.Atoi(v[:i])
		v = v[i+1:]
	}
	if i := strings.LastIndexByte(v, '-'); i >= 0 {
		return epoch, v[:i], v[i+1:]
	}
	return epoch, v, ""
}

func isDigit(c byte) bool { return c >= '0' && c <= '9' }
func isLetter(c byte) bool {
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
}

// debOrder is dpkg's character weight: '~' sorts before everything, even the end of the string, then letters, then
// every other character.
func debOrder(c byte) int {
	switch {
	case c == '~':
		return -1
	case isDigit(c):
		return 0
	case isLetter(c):
		return int(c)
	default:
		return int(c) + 256
	}
}

func debPart(a, b string) int {
	for a != "" || b != "" {
		for (a != "" && !isDigit(a[0])) || (b != "" && !isDigit(b[0])) {
			var ac, bc int
			if a != "" {
				ac = debOrder(a[0])
			}
			if b != "" {
				bc = debOrder(b[0])
			}
			if ac != bc {
				if ac < bc {
					return -1
				}
				return 1
			}
			if a != "" {
				a = a[1:]
			}
			if b != "" {
				b = b[1:]
			}
		}
		i, j := 0, 0
		for i < len(a) && a[i] == '0' {
			i++
		}
		for j < len(b) && b[j] == '0' {
			j++
		}
		a, b = a[i:], b[j:]
		n, m := 0, 0
		for n < len(a) && isDigit(a[n]) {
			n++
		}
		for m < len(b) && isDigit(b[m]) {
			m++
		}
		if n != m {
			if n < m {
				return -1
			}
			return 1
		}
		if c := strings.Compare(a[:n], b[:m]); c != 0 {
			return c
		}
		a, b = a[n:], b[m:]
	}
	return 0
}
