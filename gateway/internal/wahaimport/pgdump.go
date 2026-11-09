package wahaimport

import (
	"bufio"
	"bytes"
	"compress/zlib"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
)

// Table is the data of one table from a dump: column names and rows of text values
// (nil for SQL NULL).
type Table struct {
	Columns []string
	Rows    [][]*string
}

// Col returns the named column of row i ("" for NULL or a missing column).
func (t *Table) Col(i int, name string) string {
	for c, n := range t.Columns {
		if n == name && c < len(t.Rows[i]) && t.Rows[i][c] != nil {
			return *t.Rows[i][c]
		}
	}
	return ""
}

// Archive versions (pg_backup_archiver.h K_VERS_*), as major<<16 | minor<<8 | rev.
func vers(maj, min int) int { return maj<<16 | min<<8 }

// ReadDump extracts the named tables' data from a pg_dump custom-format archive (-Fc), the
// format a migration exports, into memory. ScanDump streams instead.
func ReadDump(path string, tables ...string) (map[string]*Table, error) {
	out := map[string]*Table{}
	for _, t := range tables {
		out[t] = &Table{}
	}
	err := ScanDump(path, tables, func(table string, cols []string, row []*string) error {
		t := out[table]
		t.Columns = cols
		t.Rows = append(t.Rows, row)
		return nil
	})
	return out, err
}

// ScanDump streams the rows of the named tables from a pg_dump custom-format archive, front to
// back, decompressing only the wanted tables' data blocks (zlib, as pg_dump's default gzip writes
// them, or none; LZ4/zstd archives are refused with a clear error). Memory stays at one row.
func ScanDump(path string, tables []string, fn func(table string, cols []string, row []*string) error) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return scanDump(bufio.NewReaderSize(f, 1<<20), tables, fn)
}

type archive struct {
	r       *bufio.Reader
	version int
	intSize int
	offSize int
	algo    int // 0 none, 1 gzip, 2 lz4, 3 zstd
}

func (a *archive) byte1() (byte, error) { return a.r.ReadByte() }

func (a *archive) int() (int, error) {
	sign, err := a.r.ReadByte()
	if err != nil {
		return 0, err
	}
	var v uint64
	for i := 0; i < a.intSize; i++ {
		b, err := a.r.ReadByte()
		if err != nil {
			return 0, err
		}
		v |= uint64(b) << (8 * i)
	}
	n := int(v)
	if sign != 0 {
		n = -n
	}
	return n, nil
}

func (a *archive) str() (*string, error) {
	n, err := a.int()
	if err != nil {
		return nil, err
	}
	if n < 0 {
		return nil, nil
	}
	if n > 1<<30 {
		return nil, fmt.Errorf("string of %d bytes", n)
	}
	b := make([]byte, n)
	if _, err := io.ReadFull(a.r, b); err != nil {
		return nil, err
	}
	s := string(b)
	return &s, nil
}

func (a *archive) offset() error {
	_, err := a.r.Discard(1 + a.offSize)
	return err
}

type tocEntry struct {
	dumpID    int
	tag, desc string
	namespace string
	copyStmt  string
}

func scanDump(r *bufio.Reader, tables []string, fn func(string, []string, []*string) error) error {
	magic := make([]byte, 5)
	if _, err := io.ReadFull(r, magic); err != nil || string(magic) != "PGDMP" {
		return errors.New("not a pg_dump custom-format archive (want PGDMP; plain SQL dumps: use the CSV path)")
	}
	a := &archive{r: r}
	var hdr [6]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return err
	}
	a.version = int(hdr[0])<<16 | int(hdr[1])<<8 | int(hdr[2])
	a.intSize, a.offSize = int(hdr[3]), int(hdr[4])
	if hdr[5] != 1 { // archCustom
		return fmt.Errorf("archive format %d is not custom (-Fc)", hdr[5])
	}
	if a.version < vers(1, 12) {
		return fmt.Errorf("archive version %d.%d is too old", hdr[0], hdr[1])
	}
	// 1.16 is pg_dump 17's format, the newest this reader has been tested on. A newer layout may
	// parse wrongly rather than fail, so refuse it: export with pg_dump 17, or use the CSV path.
	if a.version >= vers(1, 17) {
		return fmt.Errorf("archive version %d.%d is newer than this reader knows (1.16, pg_dump 17); export with pg_dump 17 or use the CSV path", hdr[0], hdr[1])
	}
	if a.version >= vers(1, 15) {
		b, err := a.byte1()
		if err != nil {
			return err
		}
		a.algo = int(b)
	} else {
		lvl, err := a.int()
		if err != nil {
			return err
		}
		if lvl != 0 {
			a.algo = 1
		}
	}
	if a.algo > 1 {
		return fmt.Errorf("archive is compressed with algorithm %d (lz4/zstd); re-dump with the default gzip or -Z0", a.algo)
	}
	for i := 0; i < 7; i++ { // creation time
		if _, err := a.int(); err != nil {
			return err
		}
	}
	for i := 0; i < 3; i++ { // database name, server version, pg_dump version
		if _, err := a.str(); err != nil {
			return err
		}
	}
	n, err := a.int()
	if err != nil {
		return err
	}
	want := map[string]bool{}
	for _, t := range tables {
		want[t] = true
	}
	entries := map[int]*tocEntry{}
	for i := 0; i < n; i++ {
		te, err := a.tocEntry()
		if err != nil {
			return fmt.Errorf("toc entry %d: %w", i, err)
		}
		if te.desc == "TABLE DATA" && want[te.tag] {
			entries[te.dumpID] = te
		}
	}
	for {
		blk, err := a.byte1()
		if errors.Is(err, io.EOF) {
			break
		} else if err != nil {
			return err
		}
		id, err := a.int()
		if err != nil {
			return err
		}
		switch blk {
		case 1: // BLK_DATA
			te := entries[id]
			if te == nil {
				if err := a.chunks(nil); err != nil {
					return err
				}
				continue
			}
			cr := &chunkReader{a: a}
			var data io.Reader = cr
			if a.algo == 1 {
				zr, err := zlib.NewReader(cr)
				if errors.Is(err, io.EOF) { // a table without rows
					data = bytes.NewReader(nil)
				} else if err != nil {
					return fmt.Errorf("%s: %w", te.tag, err)
				} else {
					data = zr
				}
			}
			if err := scanCopy(te.tag, te.copyStmt, data, fn); err != nil {
				return fmt.Errorf("%s: %w", te.tag, err)
			}
			if err := cr.drain(); err != nil {
				return err
			}
		case 3: // BLK_BLOBS: (oid, chunks)* terminated by oid 0
			for {
				oid, err := a.int()
				if err != nil {
					return err
				}
				if oid == 0 {
					break
				}
				if err := a.chunks(nil); err != nil {
					return err
				}
			}
		default:
			return fmt.Errorf("unknown block type %d", blk)
		}
	}
	return nil
}

// chunks reads length-prefixed chunks until a zero length, into buf (or discards them).
func (a *archive) chunks(buf *bytes.Buffer) error {
	for {
		n, err := a.int()
		if err != nil {
			return err
		}
		if n == 0 {
			return nil
		}
		if n < 0 || n > 1<<30 {
			return fmt.Errorf("bad chunk length %d", n)
		}
		if buf == nil {
			if _, err := a.r.Discard(n); err != nil {
				return err
			}
			continue
		}
		if _, err := io.CopyN(buf, a.r, int64(n)); err != nil {
			return err
		}
	}
}

func (a *archive) tocEntry() (*tocEntry, error) {
	te := &tocEntry{}
	var err error
	if te.dumpID, err = a.int(); err != nil {
		return nil, err
	}
	if _, err = a.int(); err != nil { // had dumper
		return nil, err
	}
	str := func(dst *string) error {
		s, err := a.str()
		if err == nil && s != nil && dst != nil {
			*dst = *s
		}
		return err
	}
	for _, dst := range []*string{nil, nil, &te.tag, &te.desc} { // table oid, oid, tag, desc
		if err := str(dst); err != nil {
			return nil, err
		}
	}
	if _, err = a.int(); err != nil { // section
		return nil, err
	}
	for _, dst := range []*string{nil, nil, &te.copyStmt, &te.namespace, nil} { // defn, drop, copy, namespace, tablespace
		if err := str(dst); err != nil {
			return nil, err
		}
	}
	if a.version >= vers(1, 14) { // table access method
		if err := str(nil); err != nil {
			return nil, err
		}
	}
	if a.version >= vers(1, 16) { // relkind
		if _, err = a.int(); err != nil {
			return nil, err
		}
	}
	for _, dst := range []*string{nil, nil} { // owner, "with oids"
		if err := str(dst); err != nil {
			return nil, err
		}
	}
	for { // dependencies, NULL-terminated
		s, err := a.str()
		if err != nil {
			return nil, err
		}
		if s == nil {
			break
		}
	}
	return te, a.offset()
}

// chunkReader presents a data block's length-prefixed chunks as one stream, ending at the zero
// length that closes the block.
type chunkReader struct {
	a    *archive
	left int
	done bool
}

func (c *chunkReader) Read(p []byte) (int, error) {
	for c.left == 0 {
		if c.done {
			return 0, io.EOF
		}
		n, err := c.a.int()
		if err != nil {
			return 0, err
		}
		if n == 0 {
			c.done = true
			return 0, io.EOF
		}
		if n < 0 || n > 1<<30 {
			return 0, fmt.Errorf("bad chunk length %d", n)
		}
		c.left = n
	}
	if len(p) > c.left {
		p = p[:c.left]
	}
	n, err := c.a.r.Read(p)
	c.left -= n
	return n, err
}

// drain consumes the rest of the block (after a decompressor stopped at its stream end).
func (c *chunkReader) drain() error {
	for !c.done {
		if c.left > 0 {
			if _, err := c.a.r.Discard(c.left); err != nil {
				return err
			}
			c.left = 0
		}
		if _, err := c.Read(nil); err != nil && !errors.Is(err, io.EOF) {
			return err
		}
	}
	return nil
}

// scanCopy streams COPY text-format rows, using the column list of the entry's COPY statement.
func scanCopy(table, copyStmt string, data io.Reader, fn func(string, []string, []*string) error) error {
	open, closeIdx := strings.Index(copyStmt, "("), strings.Index(copyStmt, ")")
	if open < 0 || closeIdx < open {
		return fmt.Errorf("unexpected COPY statement")
	}
	var cols []string
	for _, c := range strings.Split(copyStmt[open+1:closeIdx], ",") {
		cols = append(cols, strings.Trim(strings.TrimSpace(c), `"`))
	}
	br := bufio.NewReaderSize(data, 1<<20)
	for {
		line, err := br.ReadString('\n')
		if len(line) > 0 {
			line = strings.TrimSuffix(line, "\n")
			if line != "" && line != `\.` {
				fields := strings.Split(line, "\t")
				if len(fields) != len(cols) {
					return fmt.Errorf("row has %d fields, want %d", len(fields), len(cols))
				}
				row := make([]*string, len(fields))
				for i, f := range fields {
					if f == `\N` {
						continue
					}
					v := unescapeCopy(f)
					row[i] = &v
				}
				if err := fn(table, cols, row); err != nil {
					return err
				}
			}
		}
		if errors.Is(err, io.EOF) {
			return nil
		} else if err != nil {
			return err
		}
	}
}

func unescapeCopy(s string) string {
	if !strings.Contains(s, `\`) {
		return s
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
			for j < len(s) && j < i+3 && strings.IndexByte("0123456789abcdefABCDEF", s[j]) >= 0 {
				j++
			}
			v, _ := strconv.ParseUint(s[i+1:j], 16, 8)
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
	return b.String()
}
