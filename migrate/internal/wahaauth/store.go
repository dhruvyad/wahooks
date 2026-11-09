package wahaauth

import (
	"encoding/json"
	"fmt"
	"strings"
)

// Optional extras from WAHA's NOWEB message store (same per-session database as `auth`):
//
//	contacts (id TEXT PRIMARY KEY, data TEXT)          data = Baileys Contact as JSON
//	lid_map  (id TEXT, pn TEXT, data TEXT)            data = {"id": "<lid>@lid", "pn": "<pn>@s.whatsapp.net"}
//
// whatsmeow fills its contact table from app-state snapshots, which a converted device does not
// refetch (it continues incrementally), so without these the gateway's contacts list starts empty.

// StoreContact is Baileys' Contact (src/Types/Contact.ts) as WAHA stores it.
type StoreContact struct {
	ID           string `json:"id"`
	LID          string `json:"lid"`
	PhoneNumber  string `json:"phoneNumber"`
	Name         string `json:"name"`         // the account owner's address-book name
	Notify       string `json:"notify"`       // the contact's own push name
	VerifiedName string `json:"verifiedName"` // business name
}

// ParseContacts reads exported rows of the `contacts` table (id, data).
func ParseContacts(rows []Row) ([]StoreContact, []Problem) {
	var out []StoreContact
	var problems []Problem
	for _, r := range rows {
		val, err := unwrap(r)
		if err != nil {
			problems = append(problems, Problem{ID: r.ID, Category: "contact", Err: err})
			continue
		}
		var c StoreContact
		if err := json.Unmarshal(val, &c); err != nil {
			problems = append(problems, Problem{ID: r.ID, Category: "contact", Err: err})
			continue
		}
		if c.ID == "" {
			c.ID = r.ID
		}
		out = append(out, c)
	}
	return out, problems
}

// ParseLIDMap reads exported rows of the `lid_map` table (id, data) into PN user → LID user.
func ParseLIDMap(rows []Row) (map[string]string, []Problem) {
	out := map[string]string{}
	var problems []Problem
	for _, r := range rows {
		val, err := unwrap(r)
		if err != nil {
			problems = append(problems, Problem{ID: r.ID, Category: "lid_map", Err: err})
			continue
		}
		var m struct {
			ID string `json:"id"`
			PN string `json:"pn"`
		}
		if err := json.Unmarshal(val, &m); err != nil {
			problems = append(problems, Problem{ID: r.ID, Category: "lid_map", Err: err})
			continue
		}
		if m.ID == "" {
			m.ID = r.ID
		}
		lid, lerr := userOf(m.ID, "lid")
		pn, perr := userOf(m.PN, "s.whatsapp.net")
		if lerr != nil || perr != nil {
			problems = append(problems, Problem{ID: r.ID, Category: "lid_map", Err: fmt.Errorf("not a user LID/PN pair")})
			continue
		}
		out[pn] = lid
	}
	return out, problems
}

// userOf returns the numeric user part of "user[:device]@server" when the server matches.
func userOf(jid, server string) (string, error) {
	user, srv, ok := strings.Cut(jid, "@")
	if !ok || srv != server {
		return "", fmt.Errorf("%q is not on %s", jid, server)
	}
	user, _, _ = strings.Cut(user, ":")
	user, _, _ = strings.Cut(user, ".")
	if user == "" {
		return "", fmt.Errorf("empty user")
	}
	for _, c := range user {
		if c < '0' || c > '9' {
			return "", fmt.Errorf("non-numeric user")
		}
	}
	return user, nil
}
