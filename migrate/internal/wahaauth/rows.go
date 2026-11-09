package wahaauth

import (
	"bufio"
	"bytes"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// Row is one row of the `auth` table: id TEXT PRIMARY KEY, data TEXT.
// Data is the column's text exactly as stored.
type Row struct {
	ID   string `json:"id"`
	Data string `json:"data"`
}

// Format of an export file.
type Format string

const (
	FormatAuto   Format = ""
	FormatCSV    Format = "csv"    // psql \copy (SELECT id, data FROM auth) TO … WITH (FORMAT csv, HEADER)
	FormatJSON   Format = "json"   // a JSON array of {"id","data"} (e.g. SELECT json_agg(…))
	FormatJSONL  Format = "jsonl"  // one {"id","data"} object per line
	FormatPGDump Format = "pgdump" // pg_dump plain format (COPY … FROM stdin)
)

// ReadFile reads rows from an export file. With FormatAuto the format is chosen from the
// extension and, failing that, from the content.
func ReadFile(path string, format Format) ([]Row, error) {
	var raw []byte
	var err error
	if path == "-" {
		// stdin (e.g. psql \copy … TO STDOUT piped over ssh): never touches a disk
		raw, err = io.ReadAll(os.Stdin)
		if format == FormatAuto {
			format = detect("", raw)
		}
	} else {
		raw, err = os.ReadFile(path)
	}
	if err != nil {
		return nil, err
	}
	if format == FormatAuto {
		format = detect(path, raw)
	}
	switch format {
	case FormatCSV:
		return readCSV(raw)
	case FormatJSON:
		return readJSON(raw)
	case FormatJSONL:
		return readJSONL(raw)
	case FormatPGDump:
		return readPGDump(raw)
	}
	return nil, fmt.Errorf("unknown input format %q", format)
}

func detect(path string, raw []byte) Format {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".csv":
		return FormatCSV
	case ".json":
		return FormatJSON
	case ".jsonl", ".ndjson":
		return FormatJSONL
	case ".sql", ".dump":
		return FormatPGDump
	}
	t := bytes.TrimSpace(raw)
	switch {
	case bytes.HasPrefix(t, []byte("[")):
		return FormatJSON
	case bytes.HasPrefix(t, []byte("{")):
		return FormatJSONL
	case bytes.Contains(raw, []byte("\nCOPY ")) || bytes.HasPrefix(raw, []byte("COPY ")) || bytes.HasPrefix(t, []byte("--")):
		return FormatPGDump
	}
	return FormatCSV
}

func readCSV(raw []byte) ([]Row, error) {
	r := csv.NewReader(bytes.NewReader(raw))
	r.FieldsPerRecord = -1
	r.LazyQuotes = false
	var rows []Row
	first := true
	for {
		rec, err := r.Read()
		if errors.Is(err, io.EOF) {
			break
		} else if err != nil {
			return nil, fmt.Errorf("csv: %w", err)
		}
		if first {
			first = false
			if len(rec) >= 2 && strings.EqualFold(strings.TrimSpace(rec[0]), "id") && strings.EqualFold(strings.TrimSpace(rec[1]), "data") {
				continue
			}
		}
		if len(rec) != 2 {
			return nil, fmt.Errorf("csv: want 2 columns (id,data), got %d", len(rec))
		}
		rows = append(rows, Row{ID: rec[0], Data: rec[1]})
	}
	return rows, nil
}

// jsonRow accepts data as the column text (a JSON string) or as already-parsed JSON.
type jsonRow struct {
	ID   string          `json:"id"`
	Data json.RawMessage `json:"data"`
}

func (j jsonRow) row() (Row, error) {
	d := bytes.TrimSpace(j.Data)
	if len(d) > 0 && d[0] == '"' {
		var s string
		if err := json.Unmarshal(d, &s); err != nil {
			return Row{}, err
		}
		return Row{ID: j.ID, Data: s}, nil
	}
	return Row{ID: j.ID, Data: string(d)}, nil
}

func readJSON(raw []byte) ([]Row, error) {
	var list []jsonRow
	if err := json.Unmarshal(raw, &list); err != nil {
		return nil, fmt.Errorf("json: %w", err)
	}
	rows := make([]Row, 0, len(list))
	for _, j := range list {
		r, err := j.row()
		if err != nil {
			return nil, fmt.Errorf("json: row %q: %w", j.ID, err)
		}
		rows = append(rows, r)
	}
	return rows, nil
}

func readJSONL(raw []byte) ([]Row, error) {
	var rows []Row
	sc := bufio.NewScanner(bytes.NewReader(raw))
	sc.Buffer(make([]byte, 1<<20), 64<<20)
	for n := 1; sc.Scan(); n++ {
		line := bytes.TrimSpace(sc.Bytes())
		if len(line) == 0 {
			continue
		}
		var j jsonRow
		if err := json.Unmarshal(line, &j); err != nil {
			return nil, fmt.Errorf("jsonl line %d: %w", n, err)
		}
		r, err := j.row()
		if err != nil {
			return nil, fmt.Errorf("jsonl line %d: %w", n, err)
		}
		rows = append(rows, r)
	}
	return rows, sc.Err()
}

// readPGDump extracts the auth table's COPY block from a pg_dump plain-format file.
func readPGDump(raw []byte) ([]Row, error) {
	sc := bufio.NewScanner(bytes.NewReader(raw))
	sc.Buffer(make([]byte, 1<<20), 64<<20)
	var rows []Row
	in := false
	found := false
	var cols []string
	for sc.Scan() {
		line := sc.Text()
		if !in {
			if strings.HasPrefix(line, "COPY ") && strings.HasSuffix(line, "FROM stdin;") {
				table, c := parseCopyHeader(line)
				if table == "auth" {
					in, found, cols = true, true, c
				}
			}
			continue
		}
		if line == `\.` {
			in = false
			continue
		}
		fields := strings.Split(line, "\t")
		if len(fields) != len(cols) {
			return nil, fmt.Errorf("pgdump: row has %d fields, header has %d", len(fields), len(cols))
		}
		var r Row
		for i, c := range cols {
			v, err := unescapeCopy(fields[i])
			if err != nil {
				return nil, fmt.Errorf("pgdump: %w", err)
			}
			switch c {
			case "id":
				r.ID = v
			case "data":
				r.Data = v
			}
		}
		rows = append(rows, r)
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	if !found {
		return nil, fmt.Errorf("pgdump: no COPY block for table auth")
	}
	return rows, nil
}

// parseCopyHeader parses `COPY public.auth (id, data) FROM stdin;`.
func parseCopyHeader(line string) (table string, cols []string) {
	rest := strings.TrimPrefix(line, "COPY ")
	open := strings.Index(rest, "(")
	closeIdx := strings.Index(rest, ")")
	if open < 0 || closeIdx < open {
		return "", nil
	}
	name := strings.TrimSpace(rest[:open])
	if dot := strings.LastIndex(name, "."); dot >= 0 {
		name = name[dot+1:]
	}
	table = strings.Trim(name, `"`)
	for _, c := range strings.Split(rest[open+1:closeIdx], ",") {
		cols = append(cols, strings.Trim(strings.TrimSpace(c), `"`))
	}
	return table, cols
}

// unescapeCopy decodes PostgreSQL's COPY text format escapes.
func unescapeCopy(s string) (string, error) {
	if s == `\N` {
		return "", nil
	}
	if !strings.Contains(s, `\`) {
		return s, nil
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c != '\\' || i+1 == len(s) {
			b.WriteByte(c)
			continue
		}
		i++
		switch e := s[i]; e {
		case 'b':
			b.WriteByte('\b')
		case 'f':
			b.WriteByte('\f')
		case 'n':
			b.WriteByte('\n')
		case 'r':
			b.WriteByte('\r')
		case 't':
			b.WriteByte('\t')
		case 'v':
			b.WriteByte('\v')
		case 'x':
			j := i + 1
			for j < len(s) && j < i+3 && isHex(s[j]) {
				j++
			}
			v, err := strconv.ParseUint(s[i+1:j], 16, 8)
			if err != nil {
				return "", fmt.Errorf("bad \\x escape")
			}
			b.WriteByte(byte(v))
			i = j - 1
		default:
			if e >= '0' && e <= '7' {
				j := i
				for j < len(s) && j < i+3 && s[j] >= '0' && s[j] <= '7' {
					j++
				}
				v, _ := strconv.ParseUint(s[i:j], 8, 8)
				b.WriteByte(byte(v))
				i = j - 1
			} else {
				b.WriteByte(e)
			}
		}
	}
	return b.String(), nil
}

func isHex(c byte) bool {
	return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')
}
