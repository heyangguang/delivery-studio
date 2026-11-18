package pkglib

import "fmt"

// StepEvent is one line of structured progress: something that is waiting, running, done, skipped or failed. A page
// shows these as a checklist with a progress bar instead of a block of log text.
type StepEvent struct {
	ID     string `json:"id"`
	Group  string `json:"group,omitempty"`
	Label  string `json:"label"`
	State  string `json:"state"` // pending | running | done | skipped | failed
	Detail string `json:"detail,omitempty"`
	Size   int64  `json:"size,omitempty"`
}

// Reporter receives the plain log lines and the structured steps of a long operation. A nil Reporter is allowed and
// reports nothing.
type Reporter struct {
	Log  func(string)
	Step func(StepEvent)
}

// LogReporter adapts a plain logging function (the command line, tests).
func LogReporter(f func(string)) *Reporter { return &Reporter{Log: f} }

// Logf writes one log line.
func (r *Reporter) Logf(format string, a ...any) {
	if r != nil && r.Log != nil {
		r.Log(fmt.Sprintf(format, a...))
	}
}

// Emit reports a step, creating it or updating the step with the same ID.
func (r *Reporter) Emit(e StepEvent) {
	if r != nil && r.Step != nil {
		r.Step(e)
	}
}
