package pkglib

import (
	"strconv"
	"strings"
)

// rpmvercmp compares two version (or release) strings the way rpm does: alternating runs of digits and letters,
// numbers numerically and above letters, '~' sorting before everything (even the end) and '^' after the end but
// before anything else.
func rpmvercmp(a, b string) int {
	if a == b {
		return 0
	}
	for {
		for a != "" && !isAlnum(a[0]) && a[0] != '~' && a[0] != '^' {
			a = a[1:]
		}
		for b != "" && !isAlnum(b[0]) && b[0] != '~' && b[0] != '^' {
			b = b[1:]
		}
		if (a != "" && a[0] == '~') || (b != "" && b[0] == '~') {
			if a == "" || a[0] != '~' {
				return 1
			}
			if b == "" || b[0] != '~' {
				return -1
			}
			a, b = a[1:], b[1:]
			continue
		}
		if (a != "" && a[0] == '^') || (b != "" && b[0] == '^') {
			if a == "" {
				return -1
			}
			if b == "" {
				return 1
			}
			if a[0] != '^' {
				return 1
			}
			if b[0] != '^' {
				return -1
			}
			a, b = a[1:], b[1:]
			continue
		}
		if a == "" || b == "" {
			break
		}
		num := isDigit(a[0])
		i, j := 0, 0
		if num {
			for i < len(a) && isDigit(a[i]) {
				i++
			}
			for j < len(b) && isDigit(b[j]) {
				j++
			}
		} else {
			for i < len(a) && isLetter(a[i]) {
				i++
			}
			for j < len(b) && isLetter(b[j]) {
				j++
			}
		}
		x, y := a[:i], b[:j]
		if y == "" {
			// segments of different kinds: a number is newer than letters
			if num {
				return 1
			}
			return -1
		}
		if num {
			x, y = strings.TrimLeft(x, "0"), strings.TrimLeft(y, "0")
			if len(x) != len(y) {
				if len(x) > len(y) {
					return 1
				}
				return -1
			}
		}
		if c := strings.Compare(x, y); c != 0 {
			return c
		}
		a, b = a[i:], b[j:]
	}
	switch {
	case a == "" && b == "":
		return 0
	case a == "":
		return -1
	default:
		return 1
	}
}

func isAlnum(c byte) bool { return isDigit(c) || isLetter(c) }

// evr is an rpm epoch:version-release. An empty release in a requirement matches any release.
type evr struct {
	e    int
	v, r string
}

func parseEVR(s string) evr {
	var out evr
	if i := strings.IndexByte(s, ':'); i >= 0 {
		out.e, _ = strconv.Atoi(s[:i])
		s = s[i+1:]
	}
	if i := strings.LastIndexByte(s, '-'); i >= 0 {
		out.v, out.r = s[:i], s[i+1:]
	} else {
		out.v = s
	}
	return out
}

func (x evr) String() string {
	s := x.v
	if x.r != "" {
		s += "-" + x.r
	}
	if x.e != 0 {
		s = strconv.Itoa(x.e) + ":" + s
	}
	return s
}

// compareEVR orders two EVRs; when either release is empty the releases are not compared (rpm's rule for
// requirements written without a release).
func compareEVR(a, b evr) int {
	if a.e != b.e {
		if a.e < b.e {
			return -1
		}
		return 1
	}
	if c := rpmvercmp(a.v, b.v); c != 0 {
		return c
	}
	if a.r == "" || b.r == "" {
		return 0
	}
	return rpmvercmp(a.r, b.r)
}

// CompareRPM orders two full version strings as the library writes them ("1:2.3-4.el9" or "2.3-4.el9").
func CompareRPM(a, b string) int { return compareEVR(parseEVR(a), parseEVR(b)) }

// rpmSatisfies reports whether something provided at version have meets "op want". A provide without a version
// satisfies only an unversioned requirement, except that rpm treats it as matching any version for EQ-less checks.
func rpmSatisfies(have, op, want string) bool {
	if op == "" {
		return true
	}
	if have == "" {
		return false
	}
	c := compareEVR(parseEVR(have), parseEVR(want))
	switch op {
	case "EQ":
		return c == 0
	case "LT":
		return c < 0
	case "LE":
		return c <= 0
	case "GT":
		return c > 0
	case "GE":
		return c >= 0
	}
	return false
}
