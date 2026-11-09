// Package wahaauth reads a WAHA NOWEB session's `auth` table: the Baileys auth state
// that WAHA stores one key per row in the database `waha_noweb_<session>`.
package wahaauth

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// Bytes decodes every shape a byte string takes in WAHA's auth rows:
//
//   - {"type":"Buffer","data":"<base64>"}  Baileys' BufferJSON.replacer (most values)
//   - {"type":"Buffer","data":[1,2,3]}     Buffer.toJSON() without the replacer (sender-key internals)
//   - {"0":1,"1":2}                        a Uint8Array serialised without the replacer
//   - "<base64>"                           protobuf toJSON (creds.account, app-state keys) and
//     libsignal-node's own session serialisation
//   - [1,2,3]                              a plain number array
//   - null                                 absent
type Bytes []byte

func (b *Bytes) UnmarshalJSON(data []byte) error {
	data = bytes.TrimSpace(data)
	if len(data) == 0 || string(data) == "null" {
		*b = nil
		return nil
	}
	switch data[0] {
	case '"':
		var s string
		if err := json.Unmarshal(data, &s); err != nil {
			return err
		}
		out, err := decodeBase64(s)
		if err != nil {
			return fmt.Errorf("bytes: %w", err)
		}
		*b = out
		return nil
	case '[':
		return b.fromNumbers(data)
	case '{':
		var obj map[string]json.RawMessage
		if err := json.Unmarshal(data, &obj); err != nil {
			return err
		}
		if t, ok := obj["type"]; ok && string(t) == `"Buffer"` {
			inner, ok := obj["data"]
			if !ok {
				inner = obj["value"]
			}
			if inner == nil {
				*b = []byte{}
				return nil
			}
			return b.UnmarshalJSON(inner)
		}
		// A Uint8Array that went through JSON.stringify without the replacer.
		idx := make([]int, 0, len(obj))
		for k := range obj {
			i, err := strconv.Atoi(k)
			if err != nil {
				return fmt.Errorf("bytes: unexpected object key %q", k)
			}
			idx = append(idx, i)
		}
		sort.Ints(idx)
		out := make([]byte, len(idx))
		for n, i := range idx {
			if i != n {
				return fmt.Errorf("bytes: sparse index object")
			}
			v, err := strconv.Atoi(string(obj[strconv.Itoa(i)]))
			if err != nil || v < 0 || v > 255 {
				return fmt.Errorf("bytes: bad byte value at %d", i)
			}
			out[n] = byte(v)
		}
		*b = out
		return nil
	}
	return fmt.Errorf("bytes: unsupported JSON value %.20s", data)
}

func (b *Bytes) fromNumbers(data []byte) error {
	var nums []int
	if err := json.Unmarshal(data, &nums); err != nil {
		return fmt.Errorf("bytes: %w", err)
	}
	out := make([]byte, len(nums))
	for i, n := range nums {
		if n < 0 || n > 255 {
			return fmt.Errorf("bytes: value %d out of range", n)
		}
		out[i] = byte(n)
	}
	*b = out
	return nil
}

func decodeBase64(s string) ([]byte, error) {
	s = strings.TrimSpace(s)
	for _, enc := range []*base64.Encoding{base64.StdEncoding, base64.RawStdEncoding, base64.URLEncoding, base64.RawURLEncoding} {
		if out, err := enc.DecodeString(s); err == nil {
			return out, nil
		}
	}
	return nil, fmt.Errorf("not base64")
}

// Fixed returns the bytes as an array of length n, or an error naming the field.
func (b Bytes) Fixed32(field string) (*[32]byte, error) {
	if len(b) != 32 {
		return nil, fmt.Errorf("%s: want 32 bytes, got %d", field, len(b))
	}
	return (*[32]byte)(b), nil
}

// PublicKey32 strips libsignal's 0x05 key-type prefix when present.
func (b Bytes) PublicKey32(field string) (*[32]byte, error) {
	switch {
	case len(b) == 33 && b[0] == 0x05:
		return (*[32]byte)(b[1:]), nil
	case len(b) == 32:
		return (*[32]byte)(b), nil
	}
	return nil, fmt.Errorf("%s: want a 32-byte or 0x05-prefixed 33-byte public key, got %d bytes", field, len(b))
}

// PublicKey33 returns the key with libsignal's 0x05 prefix.
func (b Bytes) PublicKey33(field string) ([]byte, error) {
	k, err := b.PublicKey32(field)
	if err != nil {
		return nil, err
	}
	return append([]byte{0x05}, k[:]...), nil
}

// Int64 accepts a JSON number or a numeric string (protobuf toJSON writes int64 as strings).
type Int64 int64

func (n *Int64) UnmarshalJSON(data []byte) error {
	data = bytes.TrimSpace(data)
	if string(data) == "null" {
		*n = 0
		return nil
	}
	if len(data) > 0 && data[0] == '"' {
		var s string
		if err := json.Unmarshal(data, &s); err != nil {
			return err
		}
		if s == "" {
			*n = 0
			return nil
		}
		v, err := strconv.ParseInt(s, 10, 64)
		if err != nil {
			return err
		}
		*n = Int64(v)
		return nil
	}
	if len(data) > 0 && data[0] == '{' {
		// protobufjs Long without toJSON: {"low":..,"high":..,"unsigned":..}
		var l struct {
			Low  int64 `json:"low"`
			High int64 `json:"high"`
		}
		if err := json.Unmarshal(data, &l); err != nil {
			return err
		}
		*n = Int64(l.High<<32 | (l.Low & 0xffffffff))
		return nil
	}
	var f json.Number
	if err := json.Unmarshal(data, &f); err != nil {
		return err
	}
	if v, err := f.Int64(); err == nil {
		*n = Int64(v)
		return nil
	}
	v, err := f.Float64()
	if err != nil {
		return err
	}
	*n = Int64(v)
	return nil
}
