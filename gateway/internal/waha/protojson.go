package waha

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"strconv"
	"unicode"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
)

// Enc picks one of the two encodings NOWEB uses for protobuf content.
type Enc int

const (
	// EncWebhook is protobufjs toJSON (webhooks, send responses): int64 as decimal strings, enums as names,
	// bytes as base64 strings.
	EncWebhook Enc = iota
	// EncStore is what NOWEB's store returns on HTTP reads: int64 as numbers, enums as numbers, bytes as
	// {"type":"Buffer","data":"<base64>"}.
	EncStore
)

// OM is a JSON object that keeps its key order (proto field order, like protobufjs).
type OM []KV

type KV struct {
	K string
	V any
}

func (o OM) MarshalJSON() ([]byte, error) {
	var b bytes.Buffer
	b.WriteByte('{')
	for i, kv := range o {
		if i > 0 {
			b.WriteByte(',')
		}
		k, _ := json.Marshal(kv.K)
		b.Write(k)
		b.WriteByte(':')
		v, err := json.Marshal(kv.V)
		if err != nil {
			return nil, err
		}
		b.Write(v)
	}
	b.WriteByte('}')
	return b.Bytes(), nil
}

// Get returns the value of key k.
func (o OM) Get(k string) (any, bool) {
	for _, kv := range o {
		if kv.K == k {
			return kv.V, true
		}
	}
	return nil, false
}

// ProtoJSON encodes a protobuf message the way NOWEB serializes Baileys' protos, with WhatsApp's own field names.
func ProtoJSON(m proto.Message, enc Enc) any {
	if m == nil {
		return nil
	}
	r := m.ProtoReflect()
	if !r.IsValid() {
		return nil
	}
	return encodeMsg(r, enc)
}

func encodeMsg(m protoreflect.Message, enc Enc) OM {
	fields := m.Descriptor().Fields()
	out := OM{}
	for i := 0; i < fields.Len(); i++ {
		fd := fields.Get(i)
		if !m.Has(fd) {
			continue
		}
		v := m.Get(fd)
		name := BaileysKey(fd.JSONName())
		switch {
		case fd.IsList():
			l := v.List()
			if l.Len() == 0 {
				continue
			}
			arr := make([]any, l.Len())
			for j := 0; j < l.Len(); j++ {
				arr[j] = encodeValue(fd, l.Get(j), enc)
			}
			out = append(out, KV{name, arr})
		case fd.IsMap():
			mp := map[string]any{}
			v.Map().Range(func(k protoreflect.MapKey, mv protoreflect.Value) bool {
				mp[k.String()] = encodeValue(fd.MapValue(), mv, enc)
				return true
			})
			out = append(out, KV{name, mp})
		default:
			out = append(out, KV{name, encodeValue(fd, v, enc)})
		}
	}
	return out
}

func encodeValue(fd protoreflect.FieldDescriptor, v protoreflect.Value, enc Enc) any {
	switch fd.Kind() {
	case protoreflect.MessageKind, protoreflect.GroupKind:
		return encodeMsg(v.Message(), enc)
	case protoreflect.EnumKind:
		if enc == EncWebhook {
			if ev := fd.Enum().Values().ByNumber(v.Enum()); ev != nil {
				return string(ev.Name())
			}
		}
		return int32(v.Enum())
	case protoreflect.Int64Kind, protoreflect.Sint64Kind, protoreflect.Sfixed64Kind:
		if enc == EncWebhook {
			return strconv.FormatInt(v.Int(), 10)
		}
		return v.Int()
	case protoreflect.Uint64Kind, protoreflect.Fixed64Kind:
		if enc == EncWebhook {
			return strconv.FormatUint(v.Uint(), 10)
		}
		return v.Uint()
	case protoreflect.BytesKind:
		s := base64.StdEncoding.EncodeToString(v.Bytes())
		if enc == EncWebhook {
			return s
		}
		return OM{{"type", "Buffer"}, {"data", s}}
	case protoreflect.BoolKind:
		return v.Bool()
	case protoreflect.FloatKind, protoreflect.DoubleKind:
		return v.Float()
	case protoreflect.Int32Kind, protoreflect.Sint32Kind, protoreflect.Sfixed32Kind:
		return v.Int()
	case protoreflect.Uint32Kind, protoreflect.Fixed32Kind:
		return v.Uint()
	case protoreflect.StringKind:
		return v.String()
	}
	return nil
}

// BaileysKey turns whatsmeow's Go-style initialisms back into the camelCase of WhatsApp's own proto names
// (URL→url, fileSHA256→fileSha256, stanzaID→stanzaId, JPEGThumbnail→jpegThumbnail).
func BaileysKey(k string) string {
	r := []rune(k)
	n := len(r)
	hasRun := false
	for i := 0; i+1 < n; i++ {
		if unicode.IsUpper(r[i]) && unicode.IsUpper(r[i+1]) {
			hasRun = true
			break
		}
	}
	if !hasRun && (n == 0 || !unicode.IsUpper(r[0])) {
		return k
	}
	out := make([]rune, 0, n)
	for i := 0; i < n; {
		if !unicode.IsUpper(r[i]) {
			out = append(out, r[i])
			i++
			continue
		}
		j := i
		for j < n && unicode.IsUpper(r[j]) {
			j++
		}
		run := r[i:j]
		// The last capital of a run followed by a lowercase letter starts the next word.
		keepLast := j < n && unicode.IsLower(r[j]) && len(run) > 1
		for x, c := range run {
			switch {
			case keepLast && x == len(run)-1:
				out = append(out, c)
			case x == 0 && i != 0:
				out = append(out, c)
			default:
				out = append(out, unicode.ToLower(c))
			}
		}
		i = j
	}
	return string(out)
}
