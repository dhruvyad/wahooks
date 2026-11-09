package convert

import (
	"bytes"
	"encoding/base64"
	"fmt"

	"go.mau.fi/libsignal/ecc"
	"go.mau.fi/whatsmeow/proto/waAdv"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/util/keys"
	"google.golang.org/protobuf/proto"

	"github.com/dhruvyad/wahooks/migrate/internal/wahaauth"
)

// ADV signature prefixes (whatsmeow pair.go, Baileys Defaults WA_ADV_*).
var (
	advAccountSigPrefix       = []byte{6, 0}
	advDeviceSigPrefix        = []byte{6, 1}
	advHostedAccountSigPrefix = []byte{6, 5}
	advHostedDeviceSigPrefix  = []byte{6, 6}
)

// DeviceFields is what the creds row gives us, validated, in whatsmeow's types.
type DeviceFields struct {
	ID             types.JID
	LID            types.JID
	RegistrationID uint32
	NoiseKey       *keys.KeyPair
	IdentityKey    *keys.KeyPair
	SignedPreKey   *keys.PreKey
	AdvSecretKey   []byte
	Account        *waAdv.ADVSignedDeviceIdentity
	AccountDetails *waAdv.ADVDeviceIdentity
	Platform       string
	PushName       string
	BusinessName   string
}

// DeviceFromCreds maps Baileys AuthenticationCreds to whatsmeow's device fields and checks
// every invariant whatsmeow (and WhatsApp) relies on. Any failure is fatal: a device with
// a wrong key would connect as a different device, or not at all.
func DeviceFromCreds(c *wahaauth.Creds) (*DeviceFields, error) {
	if c.Me == nil || c.Me.ID == "" {
		return nil, fmt.Errorf("creds.me.id is empty: the session was never linked (or was logged out); there is nothing to migrate")
	}
	if c.Account == nil || len(c.Account.Details) == 0 {
		return nil, fmt.Errorf("creds.account is missing: the session never completed pairing")
	}
	f := &DeviceFields{RegistrationID: c.RegistrationID, Platform: c.Platform, PushName: c.Me.Name}

	id, err := parseUserJID(c.Me.ID)
	if err != nil {
		return nil, fmt.Errorf("creds.me.id: %w", err)
	}
	if id.Server != types.DefaultUserServer {
		return nil, fmt.Errorf("creds.me.id: server %q, want %s", id.Server, types.DefaultUserServer)
	}
	if id.Device == 0 {
		return nil, fmt.Errorf("creds.me.id has device 0: that is a primary device, not a linked companion")
	}
	f.ID = types.JID{User: id.User, Device: id.Device, Server: types.DefaultUserServer} // drop any agent suffix: whatsmeow keys the device by user:device@server
	if c.Me.LID != "" {
		lid, err := parseUserJID(c.Me.LID)
		if err != nil {
			return nil, fmt.Errorf("creds.me.lid: %w", err)
		}
		if lid.Server != types.HiddenUserServer {
			return nil, fmt.Errorf("creds.me.lid: server %q, want %s", lid.Server, types.HiddenUserServer)
		}
		if lid.Device != id.Device {
			return nil, fmt.Errorf("creds.me.lid device %d differs from creds.me.id device %d", lid.Device, id.Device)
		}
		f.LID = types.JID{User: lid.User, Device: lid.Device, Server: types.HiddenUserServer}
	}

	if f.NoiseKey, err = keyPair(c.NoiseKey, "noiseKey"); err != nil {
		return nil, err
	}
	if f.IdentityKey, err = keyPair(c.SignedIdentityKey, "signedIdentityKey"); err != nil {
		return nil, err
	}
	spk, err := keyPair(c.SignedPreKey.KeyPair, "signedPreKey.keyPair")
	if err != nil {
		return nil, err
	}
	if c.SignedPreKey.KeyID >= 1<<24 {
		return nil, fmt.Errorf("signedPreKey.keyId %d does not fit 24 bits", c.SignedPreKey.KeyID)
	}
	if len(c.SignedPreKey.Signature) != 64 {
		return nil, fmt.Errorf("signedPreKey.signature: want 64 bytes, got %d", len(c.SignedPreKey.Signature))
	}
	f.SignedPreKey = &keys.PreKey{KeyPair: *spk, KeyID: c.SignedPreKey.KeyID, Signature: (*[64]byte)(c.SignedPreKey.Signature)}
	// The signed pre-key is signed by the identity key over the 0x05-prefixed public key.
	if !ecc.VerifySignature(ecc.NewDjbECPublicKey(*f.IdentityKey.Pub), append([]byte{ecc.DjbType}, f.SignedPreKey.Pub[:]...), *f.SignedPreKey.Signature) {
		return nil, fmt.Errorf("signedPreKey.signature does not verify against the identity key")
	}

	f.AdvSecretKey, err = base64.StdEncoding.DecodeString(c.AdvSecretKey)
	if err != nil || len(f.AdvSecretKey) != 32 {
		return nil, fmt.Errorf("advSecretKey: want 32 bytes of base64")
	}

	acc := c.Account
	if len(acc.AccountSignatureKey) != 32 || len(acc.AccountSignature) != 64 || len(acc.DeviceSignature) != 64 {
		return nil, fmt.Errorf("creds.account: bad lengths (signature key %d, account signature %d, device signature %d)",
			len(acc.AccountSignatureKey), len(acc.AccountSignature), len(acc.DeviceSignature))
	}
	f.Account = &waAdv.ADVSignedDeviceIdentity{
		Details:             bytes.Clone(acc.Details),
		AccountSignatureKey: bytes.Clone(acc.AccountSignatureKey),
		AccountSignature:    bytes.Clone(acc.AccountSignature),
		DeviceSignature:     bytes.Clone(acc.DeviceSignature),
	}
	var details waAdv.ADVDeviceIdentity
	if err := proto.Unmarshal(acc.Details, &details); err != nil {
		return nil, fmt.Errorf("creds.account.details: %w", err)
	}
	f.AccountDetails = &details
	if err := VerifyAccount(f.Account, &details, f.IdentityKey); err != nil {
		return nil, err
	}
	return f, nil
}

// VerifyAccount checks the ADV signatures exactly as whatsmeow's pairing does: the primary
// device signed (prefix, details, our identity key), and we signed (prefix, details, our
// identity key, the account signature key).
func VerifyAccount(acc *waAdv.ADVSignedDeviceIdentity, details *waAdv.ADVDeviceIdentity, identity *keys.KeyPair) error {
	hosted := details.GetDeviceType() == waAdv.ADVEncryptionType_HOSTED
	accPrefix, devPrefix := advAccountSigPrefix, advDeviceSigPrefix
	if hosted {
		accPrefix, devPrefix = advHostedAccountSigPrefix, advHostedDeviceSigPrefix
	}
	accountKey := ecc.NewDjbECPublicKey(*(*[32]byte)(acc.AccountSignatureKey))
	msg := concat(accPrefix, acc.Details, identity.Pub[:])
	if !ecc.VerifySignature(accountKey, msg, *(*[64]byte)(acc.AccountSignature)) {
		return fmt.Errorf("creds.account.accountSignature does not verify: the primary device did not sign this identity key")
	}
	devMsg := concat(devPrefix, acc.Details, identity.Pub[:], acc.AccountSignatureKey)
	if !ecc.VerifySignature(ecc.NewDjbECPublicKey(*identity.Pub), devMsg, *(*[64]byte)(acc.DeviceSignature)) {
		// Baileys has always signed with the plain device prefix; accept that for hosted too.
		if !hosted || !ecc.VerifySignature(ecc.NewDjbECPublicKey(*identity.Pub), concat(advDeviceSigPrefix, acc.Details, identity.Pub[:], acc.AccountSignatureKey), *(*[64]byte)(acc.DeviceSignature)) {
			return fmt.Errorf("creds.account.deviceSignature does not verify against our identity key")
		}
	}
	return nil
}

func keyPair(kp wahaauth.KeyPair, field string) (*keys.KeyPair, error) {
	priv, err := kp.Private.Fixed32(field + ".private")
	if err != nil {
		return nil, err
	}
	out := keys.NewKeyPairFromPrivateKey(*priv)
	if len(kp.Public) > 0 {
		pub, err := kp.Public.PublicKey32(field + ".public")
		if err != nil {
			return nil, err
		}
		if *pub != *out.Pub {
			return nil, fmt.Errorf("%s: stored public key does not match the private key", field)
		}
	}
	return out, nil
}

// Apply copies the fields onto a whatsmeow device.
func (f *DeviceFields) Apply(d *store.Device) {
	id := f.ID
	d.ID = &id
	d.LID = f.LID
	d.RegistrationID = f.RegistrationID
	d.NoiseKey = f.NoiseKey
	d.IdentityKey = f.IdentityKey
	d.SignedPreKey = f.SignedPreKey
	d.AdvSecretKey = f.AdvSecretKey
	d.Account = f.Account
	d.Platform = f.Platform
	d.PushName = f.PushName
	d.BusinessName = f.BusinessName
}

func concat(parts ...[]byte) []byte {
	var n int
	for _, p := range parts {
		n += len(p)
	}
	out := make([]byte, 0, n)
	for _, p := range parts {
		out = append(out, p...)
	}
	return out
}
