package style

import (
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/fatih/color"
)

// ─────────────────────────────────────────────────────────────────────────────
// Colors / formatting helpers
// ─────────────────────────────────────────────────────────────────────────────

var (
	green  = color.New(color.FgGreen)
	red    = color.New(color.FgRed)
	yellow = color.New(color.FgYellow)
	cyan   = color.New(color.FgCyan)
	faint  = color.New(color.Faint)
	bold   = color.New(color.Bold)
)

// Success prints a green message prefixed with a checkmark.
func Success(msg string, args ...any) {
	green.Printf(" %s %s\n", green.Sprint("\u2713"), fmt.Sprintf(msg, args...))
}

// Error prints a red message prefixed with a cross mark.
func Error(msg string, args ...any) {
	red.Printf(" %s %s\n", red.Sprint("\u2717"), fmt.Sprintf(msg, args...))
}

// Warn prints a yellow message prefixed with a warning sign.
func Warn(msg string, args ...any) {
	yellow.Printf(" %s %s\n", yellow.Sprint("\u26a0"), fmt.Sprintf(msg, args...))
}

// Info prints a cyan message prefixed with an arrow.
func Info(msg string, args ...any) {
	cyan.Printf(" %s %s\n", cyan.Sprint("\u2192"), fmt.Sprintf(msg, args...))
}

// Dim prints faint text.
func Dim(msg string, args ...any) {
	faint.Printf("%s\n", fmt.Sprintf(msg, args...))
}

// Bold prints bold text.
func Bold(msg string, args ...any) {
	bold.Printf("%s\n", fmt.Sprintf(msg, args...))
}

// Header prints a section header with an underline.
func Header(title string) {
	fmt.Println()
	bold.Println(title)
	faint.Println(strings.Repeat("\u2500", len(title)))
}

// ─────────────────────────────────────────────────────────────────────────────
// Table rendering
// ─────────────────────────────────────────────────────────────────────────────

// Table renders aligned columns with box-drawing characters.
type Table struct {
	headers []string
	rows    []tableRow
}

type tableRow struct {
	cells  []string
	colors []*color.Color
}

// NewTable creates a new table with the given column headers.
func NewTable(headers ...string) *Table {
	return &Table{headers: headers}
}

// AddRow adds a plain row to the table.
func (t *Table) AddRow(cells ...string) {
	t.rows = append(t.rows, tableRow{cells: cells})
}

// AddColoredRow adds a row where each cell can have an individual color.
// Pass nil in the colors slice for cells that should use the default color.
func (t *Table) AddColoredRow(cells []string, colors []*color.Color) {
	t.rows = append(t.rows, tableRow{cells: cells, colors: colors})
}

// Print renders the table to stdout with auto-calculated column widths.
func (t *Table) Print() {
	if len(t.headers) == 0 {
		return
	}

	// Calculate column widths
	widths := make([]int, len(t.headers))
	for i, h := range t.headers {
		widths[i] = len(h)
	}
	for _, row := range t.rows {
		for i, cell := range row.cells {
			if i < len(widths) && len(cell) > widths[i] {
				widths[i] = len(cell)
			}
		}
	}

	// Build format strings
	totalWidth := 0
	for _, w := range widths {
		totalWidth += w
	}
	totalWidth += (len(widths) - 1) * 3 // separators " \u2502 "

	// Print header
	fmt.Println()
	headerParts := make([]string, len(t.headers))
	for i, h := range t.headers {
		headerParts[i] = padRight(h, widths[i])
	}
	faint.Printf("  %s\n", strings.Join(headerParts, faint.Sprint(" \u2502 ")))

	// Print separator
	sepParts := make([]string, len(widths))
	for i, w := range widths {
		sepParts[i] = strings.Repeat("\u2500", w)
	}
	faint.Printf("  %s\n", strings.Join(sepParts, faint.Sprint("\u2500\u253c\u2500")))

	// Print rows
	for _, row := range t.rows {
		fmt.Print("  ")
		for i := 0; i < len(t.headers); i++ {
			if i > 0 {
				faint.Print(" \u2502 ")
			}
			cell := ""
			if i < len(row.cells) {
				cell = row.cells[i]
			}
			padded := padRight(cell, widths[i])

			if row.colors != nil && i < len(row.colors) && row.colors[i] != nil {
				row.colors[i].Print(padded)
			} else {
				fmt.Print(padded)
			}
		}
		fmt.Println()
	}
	fmt.Println()
}

func padRight(s string, width int) string {
	if len(s) >= width {
		return s
	}
	return s + strings.Repeat(" ", width-len(s))
}

// ─────────────────────────────────────────────────────────────────────────────
// Panels / boxes
// ─────────────────────────────────────────────────────────────────────────────

// Panel prints a bordered box with a title and body text.
func Panel(title, body string) {
	renderPanel(title, body, faint)
}

// SuccessPanel prints a green-bordered panel.
func SuccessPanel(title, body string) {
	renderPanel(title, body, green)
}

// ErrorPanel prints a red-bordered panel.
func ErrorPanel(title, body string) {
	renderPanel(title, body, red)
}

// WarnPanel prints a yellow-bordered panel.
func WarnPanel(title, body string) {
	renderPanel(title, body, yellow)
}

func renderPanel(title, body string, c *color.Color) {
	lines := strings.Split(body, "\n")

	// Find max width
	maxW := len(title)
	for _, line := range lines {
		if len(line) > maxW {
			maxW = len(line)
		}
	}
	innerW := maxW + 2 // 1 space padding on each side

	fmt.Println()

	// Top border
	c.Printf("  \u250c")
	c.Printf("%s", strings.Repeat("\u2500", innerW))
	c.Printf("\u2510\n")

	// Title
	if title != "" {
		c.Printf("  \u2502")
		bold.Printf(" %-*s", innerW-1, title)
		c.Printf("\u2502\n")

		// Title separator
		c.Printf("  \u251c")
		c.Printf("%s", strings.Repeat("\u2500", innerW))
		c.Printf("\u2524\n")
	}

	// Body lines
	for _, line := range lines {
		c.Printf("  \u2502")
		fmt.Printf(" %-*s", innerW-1, line)
		c.Printf("\u2502\n")
	}

	// Bottom border
	c.Printf("  \u2514")
	c.Printf("%s", strings.Repeat("\u2500", innerW))
	c.Printf("\u2518\n")
}

// ─────────────────────────────────────────────────────────────────────────────
// Key-value display
// ─────────────────────────────────────────────────────────────────────────────

// KeyValue prints aligned key: value pairs.
// Pass alternating key, value strings: KeyValue("Name", "Alice", "Age", "30")
func KeyValue(pairs ...string) {
	if len(pairs)%2 != 0 {
		pairs = append(pairs, "")
	}

	maxKeyLen := 0
	for i := 0; i < len(pairs); i += 2 {
		if len(pairs[i]) > maxKeyLen {
			maxKeyLen = len(pairs[i])
		}
	}

	fmt.Println()
	for i := 0; i < len(pairs); i += 2 {
		key := pairs[i]
		value := pairs[i+1]
		faint.Printf("  %-*s", maxKeyLen+1, key+":")
		fmt.Printf(" %s\n", value)
	}
	fmt.Println()
}

// ─────────────────────────────────────────────────────────────────────────────
// Spinner
// ─────────────────────────────────────────────────────────────────────────────

var spinnerFrames = []string{"\u280b", "\u2819", "\u2839", "\u2838", "\u283c", "\u2834", "\u2826", "\u2827", "\u2807", "\u280f"}

// Spinner starts a terminal spinner with a message. Returns a stop function.
func Spinner(msg string) func() {
	done := make(chan struct{})
	var once sync.Once

	go func() {
		i := 0
		for {
			select {
			case <-done:
				// Clear the spinner line
				fmt.Printf("\r%s\r", strings.Repeat(" ", len(msg)+5))
				return
			default:
				cyan.Printf("\r %s ", spinnerFrames[i%len(spinnerFrames)])
				faint.Printf("%s", msg)
				i++
				time.Sleep(80 * time.Millisecond)
			}
		}
	}()

	return func() {
		once.Do(func() { close(done) })
		time.Sleep(100 * time.Millisecond) // let the goroutine clean up
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Count footer
// ─────────────────────────────────────────────────────────────────────────────

// Count prints a faint count footer, e.g. "3 connections".
func Count(n int, singular string) {
	noun := singular
	if n != 1 {
		noun = singular + "s"
	}
	faint.Printf("  %d %s\n\n", n, noun)
}

// ─────────────────────────────────────────────────────────────────────────────
// Color accessors (for use with AddColoredRow)
// ─────────────────────────────────────────────────────────────────────────────

// Green returns the green color for use with AddColoredRow.
func Green() *color.Color { return green }

// Red returns the red color for use with AddColoredRow.
func Red() *color.Color { return red }

// Yellow returns the yellow color for use with AddColoredRow.
func Yellow() *color.Color { return yellow }

// Cyan returns the cyan color for use with AddColoredRow.
func Cyan() *color.Color { return cyan }

// Faint returns the faint color for use with AddColoredRow.
func Faint() *color.Color { return faint }

// StatusColor returns the appropriate color for a status string.
func StatusColor(status string) *color.Color {
	switch status {
	case "working", "connected", "delivered", "true", "active":
		return green
	case "stopped", "failed", "false":
		return red
	default:
		return yellow
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// JSON syntax highlighting
// ─────────────────────────────────────────────────────────────────────────────

var (
	jsonKey    = color.New(color.FgWhite, color.Bold)
	jsonString = color.New(color.FgGreen)
	jsonNumber = color.New(color.FgCyan)
	jsonBool   = color.New(color.FgYellow)
	jsonNull   = color.New(color.Faint)
	jsonBrace  = color.New(color.Faint)
)

// ColorizeJSON returns a syntax-highlighted version of a pretty-printed JSON string.
func ColorizeJSON(prettyJSON string) string {
	var buf strings.Builder
	inString := false
	isKey := true
	escaped := false

	lines := strings.Split(prettyJSON, "\n")
	for li, line := range lines {
		if li > 0 {
			buf.WriteString("\n")
		}

		trimmed := strings.TrimLeft(line, " ")
		indent := line[:len(line)-len(trimmed)]
		buf.WriteString(indent)

		isKey = true
		inString = false
		escaped = false

		runes := []rune(trimmed)
		i := 0
		for i < len(runes) {
			ch := runes[i]

			if escaped {
				// inside a string, previous char was backslash
				buf.WriteRune(ch)
				escaped = false
				i++
				continue
			}

			if inString {
				if ch == '\\' {
					escaped = true
					buf.WriteRune(ch)
					i++
					continue
				}
				if ch == '"' {
					buf.WriteRune(ch)
					inString = false
					i++
					continue
				}
				buf.WriteRune(ch)
				i++
				continue
			}

			// Not in a string
			switch {
			case ch == '"':
				// Start of a string — read the whole string
				j := i + 1
				for j < len(runes) {
					if runes[j] == '\\' {
						j += 2
						continue
					}
					if runes[j] == '"' {
						j++
						break
					}
					j++
				}
				strVal := string(runes[i:j])

				// Check if this is a key (followed by colon)
				rest := strings.TrimLeft(string(runes[j:]), " ")
				if len(rest) > 0 && rest[0] == ':' {
					buf.WriteString(jsonKey.Sprint(strVal))
				} else {
					buf.WriteString(jsonString.Sprint(strVal))
				}
				isKey = false
				i = j

			case ch == '{' || ch == '}' || ch == '[' || ch == ']':
				buf.WriteString(jsonBrace.Sprintf("%c", ch))
				i++

			case ch == ':':
				buf.WriteString(jsonBrace.Sprint(":"))
				isKey = false
				i++

			case ch == ',':
				buf.WriteString(jsonBrace.Sprint(","))
				isKey = true
				i++

			case ch >= '0' && ch <= '9' || ch == '-' || ch == '.':
				// Number
				j := i
				for j < len(runes) && (runes[j] >= '0' && runes[j] <= '9' || runes[j] == '.' || runes[j] == '-' || runes[j] == 'e' || runes[j] == 'E' || runes[j] == '+') {
					j++
				}
				buf.WriteString(jsonNumber.Sprint(string(runes[i:j])))
				i = j

			case ch == 't' || ch == 'f':
				// true / false
				word := ""
				if i+4 <= len(runes) && string(runes[i:i+4]) == "true" {
					word = "true"
				} else if i+5 <= len(runes) && string(runes[i:i+5]) == "false" {
					word = "false"
				}
				if word != "" {
					buf.WriteString(jsonBool.Sprint(word))
					i += len(word)
				} else {
					buf.WriteRune(ch)
					i++
				}

			case ch == 'n':
				if i+4 <= len(runes) && string(runes[i:i+4]) == "null" {
					buf.WriteString(jsonNull.Sprint("null"))
					i += 4
				} else {
					buf.WriteRune(ch)
					i++
				}

			default:
				buf.WriteRune(ch)
				i++
			}
			_ = isKey
		}
	}

	return buf.String()
}

// ─────────────────────────────────────────────────────────────────────────────
// E2E test helpers
// ─────────────────────────────────────────────────────────────────────────────

// TestPass prints a green checkmark line for test results.
func TestPass(msg string, args ...any) {
	green.Printf("  \u2713 %s\n", fmt.Sprintf(msg, args...))
}

// TestFail prints a red cross line for test results.
func TestFail(msg string, args ...any) {
	red.Printf("  \u2717 %s\n", fmt.Sprintf(msg, args...))
}

// TestSkip prints a faint skip line for test results.
func TestSkip(msg string, args ...any) {
	faint.Printf("  - %s (skipped)\n", fmt.Sprintf(msg, args...))
}

// TestSection prints a bold numbered section header.
func TestSection(msg string, args ...any) {
	fmt.Println()
	bold.Printf("%s\n", fmt.Sprintf(msg, args...))
}

// TestSummary prints the final E2E summary panel.
func TestSummary(pass, fail, skipped int) {
	var body string
	if fail == 0 {
		body = fmt.Sprintf("\u2713 %d passed    - %d skipped", pass, skipped)
		SuccessPanel("E2E Complete", body)
	} else {
		body = fmt.Sprintf("\u2713 %d passed    \u2717 %d failed    - %d skipped", pass, fail, skipped)
		ErrorPanel("E2E Complete", body)
	}
}
