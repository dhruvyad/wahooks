// Package wahaimport turns WAHA NOWEB's stored history (the per-session `messages` and `chats`
// tables) into the gateway's gw_messages / gw_chats rows, through the same code the gateway
// uses for history it receives itself.
package wahaimport

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"sync"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
)

// Decode fills m from a Baileys object as WAHA stores it: protobufjs field names (camelCase,
// e.g. fileSha256 for whatsmeow's fileSHA256), enums as numbers (or names), 64-bit integers as
// numbers (WAHA's replaceLongsWithNumber) or strings or {low,high,unsigned}, and byte fields as
// BufferJSON {"type":"Buffer","data":<base64>} (also the array, index-object and base64-string
// forms). Fields the proto doesn't have are returned as dotted paths, not errors.
func Decode(data []byte, m proto.Message) (unknown []string, err error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, err
	}
	obj, ok := v.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("want a JSON object")
	}
	d := &decoder{}
	if err := d.message(m.ProtoReflect(), obj, ""); err != nil {
		return d.unknown, err
	}
	if d.markedUnread {
		if fd := m.ProtoReflect().Descriptor().Fields().ByName("markedAsUnread"); fd != nil {
			m.ProtoReflect().Set(fd, protoreflect.ValueOfBool(true))
		}
	}
	sort.Strings(d.unknown)
	return d.unknown, nil
}

type decoder struct {
	unknown []string
	// Baileys stores a chat marked unread on the phone as unreadCount -1 (chat-utils.js,
	// markReadAction). Decode turns that into unreadCount 0 with markedAsUnread set.
	markedUnread bool
}

var fieldIndex sync.Map // protoreflect.FullName → map[normalised name]FieldDescriptor

func norm(s string) string { return strings.ToLower(strings.ReplaceAll(s, "_", "")) }

func fieldsOf(md protoreflect.MessageDescriptor) map[string]protoreflect.FieldDescriptor {
	if f, ok := fieldIndex.Load(md.FullName()); ok {
		return f.(map[string]protoreflect.FieldDescriptor)
	}
	out := map[string]protoreflect.FieldDescriptor{}
	fs := md.Fields()
	for i := 0; i < fs.Len(); i++ {
		fd := fs.Get(i)
		out[norm(string(fd.Name()))] = fd
		out[norm(fd.JSONName())] = fd
	}
	fieldIndex.Store(md.FullName(), out)
	return out
}

func (d *decoder) message(m protoreflect.Message, obj map[string]any, path string) error {
	fields := fieldsOf(m.Descriptor())
	for k, raw := range obj {
		if raw == nil {
			continue
		}
		p := k
		if path != "" {
			p = path + "." + k
		}
		fd, ok := fields[norm(k)]
		if !ok {
			d.unknown = append(d.unknown, p)
			continue
		}
		if path == "" && fd.Name() == "unreadCount" {
			if n, _, err := integer(raw); err == nil && n < 0 {
				d.markedUnread = true
				continue
			}
		}
		switch {
		case fd.IsList():
			arr, ok := raw.([]any)
			if !ok {
				return fmt.Errorf("%s: want an array", p)
			}
			list := m.Mutable(fd).List()
			for i, item := range arr {
				if item == nil {
					continue
				}
				if fd.Kind() == protoreflect.MessageKind || fd.Kind() == protoreflect.GroupKind {
					sub, ok := item.(map[string]any)
					if !ok {
						return fmt.Errorf("%s[%d]: want an object", p, i)
					}
					el := list.NewElement()
					if err := d.message(el.Message(), sub, fmt.Sprintf("%s[%d]", p, i)); err != nil {
						return err
					}
					list.Append(el)
					continue
				}
				v, err := scalar(fd, item)
				if err != nil {
					return fmt.Errorf("%s[%d]: %w", p, i, err)
				}
				list.Append(v)
			}
		case fd.IsMap():
			obj, ok := raw.(map[string]any)
			if !ok {
				return fmt.Errorf("%s: want an object", p)
			}
			mp := m.Mutable(fd).Map()
			for mk, mv := range obj {
				key, err := scalar(fd.MapKey(), mk)
				if err != nil {
					return fmt.Errorf("%s key %q: %w", p, mk, err)
				}
				if fd.MapValue().Kind() == protoreflect.MessageKind {
					sub, ok := mv.(map[string]any)
					if !ok {
						return fmt.Errorf("%s[%s]: want an object", p, mk)
					}
					val := mp.NewValue()
					if err := d.message(val.Message(), sub, p+"["+mk+"]"); err != nil {
						return err
					}
					mp.Set(key.MapKey(), val)
					continue
				}
				val, err := scalar(fd.MapValue(), mv)
				if err != nil {
					return fmt.Errorf("%s[%s]: %w", p, mk, err)
				}
				mp.Set(key.MapKey(), val)
			}
		case fd.Kind() == protoreflect.MessageKind || fd.Kind() == protoreflect.GroupKind:
			sub, ok := raw.(map[string]any)
			if !ok {
				return fmt.Errorf("%s: want an object", p)
			}
			if err := d.message(m.Mutable(fd).Message(), sub, p); err != nil {
				return err
			}
		default:
			v, err := scalar(fd, raw)
			if err != nil {
				return fmt.Errorf("%s: %w", p, err)
			}
			m.Set(fd, v)
		}
	}
	return nil
}

func scalar(fd protoreflect.FieldDescriptor, raw any) (protoreflect.Value, error) {
	switch fd.Kind() {
	case protoreflect.StringKind:
		s, ok := raw.(string)
		if !ok {
			return protoreflect.Value{}, fmt.Errorf("want a string")
		}
		return protoreflect.ValueOfString(s), nil
	case protoreflect.BoolKind:
		switch b := raw.(type) {
		case bool:
			return protoreflect.ValueOfBool(b), nil
		case json.Number:
			return protoreflect.ValueOfBool(b.String() != "0"), nil
		}
		return protoreflect.Value{}, fmt.Errorf("want a bool")
	case protoreflect.BytesKind:
		b, err := bytesOf(raw)
		if err != nil {
			return protoreflect.Value{}, err
		}
		return protoreflect.ValueOfBytes(b), nil
	case protoreflect.EnumKind:
		switch e := raw.(type) {
		case json.Number:
			n, err := e.Int64()
			if err != nil || n < math.MinInt32 || n > math.MaxInt32 {
				return protoreflect.Value{}, fmt.Errorf("bad enum number %s", e)
			}
			return protoreflect.ValueOfEnum(protoreflect.EnumNumber(n)), nil
		case string:
			if ev := fd.Enum().Values().ByName(protoreflect.Name(e)); ev != nil {
				return protoreflect.ValueOfEnum(ev.Number()), nil
			}
			return protoreflect.Value{}, fmt.Errorf("unknown enum value %q", e)
		}
		return protoreflect.Value{}, fmt.Errorf("want an enum")
	case protoreflect.FloatKind, protoreflect.DoubleKind:
		var f float64
		switch x := raw.(type) {
		case json.Number:
			v, err := x.Float64()
			if err != nil {
				return protoreflect.Value{}, err
			}
			f = v
		case string:
			v, err := strconv.ParseFloat(x, 64)
			if err != nil {
				return protoreflect.Value{}, err
			}
			f = v
		default:
			return protoreflect.Value{}, fmt.Errorf("want a number")
		}
		if fd.Kind() == protoreflect.FloatKind {
			return protoreflect.ValueOfFloat32(float32(f)), nil
		}
		return protoreflect.ValueOfFloat64(f), nil
	}
	// integers
	n, unsigned, err := integer(raw)
	if err != nil {
		return protoreflect.Value{}, err
	}
	switch fd.Kind() {
	case protoreflect.Int32Kind, protoreflect.Sint32Kind, protoreflect.Sfixed32Kind:
		return protoreflect.ValueOfInt32(int32(n)), nil
	case protoreflect.Int64Kind, protoreflect.Sint64Kind, protoreflect.Sfixed64Kind:
		return protoreflect.ValueOfInt64(n), nil
	case protoreflect.Uint32Kind, protoreflect.Fixed32Kind:
		if n < 0 || n > math.MaxUint32 {
			return protoreflect.Value{}, fmt.Errorf("%d is out of range for an unsigned 32-bit field", n)
		}
		return protoreflect.ValueOfUint32(uint32(n)), nil
	case protoreflect.Uint64Kind, protoreflect.Fixed64Kind:
		_ = unsigned
		return protoreflect.ValueOfUint64(uint64(n)), nil
	}
	return protoreflect.Value{}, fmt.Errorf("unsupported kind %s", fd.Kind())
}

// integer reads a JSON number, a numeric string, or a protobufjs Long {low, high, unsigned}.
func integer(raw any) (int64, bool, error) {
	switch x := raw.(type) {
	case json.Number:
		if n, err := x.Int64(); err == nil {
			return n, false, nil
		}
		if u, err := strconv.ParseUint(x.String(), 10, 64); err == nil {
			return int64(u), true, nil
		}
		f, err := x.Float64() // 1.5e12 style
		if err != nil || f != math.Trunc(f) {
			return 0, false, fmt.Errorf("not an integer: %s", x)
		}
		return int64(f), false, nil
	case string:
		if n, err := strconv.ParseInt(x, 10, 64); err == nil {
			return n, false, nil
		}
		u, err := strconv.ParseUint(x, 10, 64)
		return int64(u), true, err
	case map[string]any:
		lo, _, err1 := integer(x["low"])
		hi, _, err2 := integer(x["high"])
		if err1 != nil || err2 != nil {
			return 0, false, fmt.Errorf("bad Long")
		}
		uns, _ := x["unsigned"].(bool)
		return int64(uint64(uint32(hi))<<32 | uint64(uint32(lo))), uns, nil
	case bool:
		if x {
			return 1, false, nil
		}
		return 0, false, nil
	}
	return 0, false, fmt.Errorf("want an integer")
}

// bytesOf decodes the byte shapes found in WAHA's rows.
func bytesOf(raw any) ([]byte, error) {
	switch x := raw.(type) {
	case string:
		for _, enc := range []*base64.Encoding{base64.StdEncoding, base64.RawStdEncoding, base64.URLEncoding, base64.RawURLEncoding} {
			if b, err := enc.DecodeString(x); err == nil {
				return b, nil
			}
		}
		return nil, fmt.Errorf("not base64")
	case []any:
		out := make([]byte, len(x))
		for i, v := range x {
			n, _, err := integer(v)
			if err != nil || n < 0 || n > 255 {
				return nil, fmt.Errorf("bad byte at %d", i)
			}
			out[i] = byte(n)
		}
		return out, nil
	case map[string]any:
		if t, ok := x["type"].(string); ok && t == "Buffer" {
			d, ok := x["data"]
			if !ok {
				d = x["value"]
			}
			if d == nil {
				return []byte{}, nil
			}
			return bytesOf(d)
		}
		out := make([]byte, len(x))
		for k, v := range x {
			i, err := strconv.Atoi(k)
			if err != nil || i < 0 || i >= len(x) {
				return nil, fmt.Errorf("bad byte index %q", k)
			}
			n, _, err := integer(v)
			if err != nil || n < 0 || n > 255 {
				return nil, fmt.Errorf("bad byte at %d", i)
			}
			out[i] = byte(n)
		}
		return out, nil
	}
	return nil, fmt.Errorf("want bytes")
}
