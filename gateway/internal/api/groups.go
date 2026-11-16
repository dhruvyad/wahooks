package api

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"go.mau.fi/whatsmeow"

	"github.com/dhruvyad/wahooks/gateway/internal/session"
	"github.com/dhruvyad/wahooks/gateway/internal/waha"
)

// Group routes, as WAHA's (NOWEB) /api/{session}/groups API: group bodies are Baileys GroupMetadata (waha.GroupMetadata),
// participant changes answer [{status, jid}] (waha.GroupParticipantResults).

// participantIDs reads WAHA's [{"id": "..."}] and also accepts plain ["..."].
type participantIDs []string

func (p *participantIDs) UnmarshalJSON(b []byte) error {
	var raw []json.RawMessage
	if err := json.Unmarshal(b, &raw); err != nil {
		return session.BadRequest{Msg: "participants must be an array"}
	}
	out := make([]string, 0, len(raw))
	for _, r := range raw {
		var id string
		if err := json.Unmarshal(r, &id); err == nil {
			out = append(out, id)
			continue
		}
		var o struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(r, &o); err != nil || o.ID == "" {
			return session.BadRequest{Msg: "each participant must be {\"id\": \"<number>@c.us\"} or a string"}
		}
		out = append(out, o.ID)
	}
	*p = out
	return nil
}

func (s *Server) createGroup(w http.ResponseWriter, r *http.Request, p params) {
	ss := s.sessW(w, p["session"])
	if ss == nil {
		return
	}
	var b struct {
		Name         string         `json:"name"`
		Participants participantIDs `json:"participants"`
	}
	if err := decode(r, &b); err != nil {
		s.fail(w, r, ss, err)
		return
	}
	c, cancel := ctx(r, 25*time.Second)
	defer cancel()
	g, err := ss.CreateGroup(c, b.Name, b.Participants)
	if err != nil {
		s.fail(w, r, ss, err)
		return
	}
	writeJSON(w, 201, waha.GroupMetadata(g, ss.MemberNames(c, g), ss.OwnIDs()...))
}

func (s *Server) getGroup(w http.ResponseWriter, r *http.Request, p params) {
	ss := s.sessW(w, p["session"])
	if ss == nil {
		return
	}
	c, cancel := ctx(r, 25*time.Second)
	defer cancel()
	g, err := ss.GroupInfo(c, p["id"], qbool(r, "refresh", false))
	if err != nil {
		s.fail(w, r, ss, err)
		return
	}
	writeJSON(w, 200, waha.GroupMetadata(g, ss.MemberNames(c, g), ss.OwnIDs()...))
}

func (s *Server) groupParticipants(action whatsmeow.ParticipantChange) func(http.ResponseWriter, *http.Request, params) {
	return func(w http.ResponseWriter, r *http.Request, p params) {
		ss := s.sessW(w, p["session"])
		if ss == nil {
			return
		}
		var b struct {
			Participants participantIDs `json:"participants"`
		}
		if err := decode(r, &b); err != nil {
			s.fail(w, r, ss, err)
			return
		}
		c, cancel := ctx(r, 25*time.Second)
		defer cancel()
		res, err := ss.UpdateGroupParticipants(c, p["id"], b.Participants, action)
		if err != nil {
			s.fail(w, r, ss, err)
			return
		}
		writeJSON(w, 201, waha.GroupParticipantResults(res))
	}
}

func (s *Server) leaveGroup(w http.ResponseWriter, r *http.Request, p params) {
	ss := s.sessW(w, p["session"])
	if ss == nil {
		return
	}
	c, cancel := ctx(r, 25*time.Second)
	defer cancel()
	if err := ss.LeaveGroup(c, p["id"]); err != nil {
		s.fail(w, r, ss, err)
		return
	}
	writeEmpty(w, 201)
}

func (s *Server) groupSubject(w http.ResponseWriter, r *http.Request, p params) {
	ss := s.sessW(w, p["session"])
	if ss == nil {
		return
	}
	var b struct {
		Subject string `json:"subject"`
	}
	if err := decode(r, &b); err != nil {
		s.fail(w, r, ss, err)
		return
	}
	c, cancel := ctx(r, 25*time.Second)
	defer cancel()
	if err := ss.SetGroupSubject(c, p["id"], b.Subject); err != nil {
		s.fail(w, r, ss, err)
		return
	}
	writeEmpty(w, 200)
}

// groupInviteCode answers with the invite link as a JSON string, as WAHA does.
func (s *Server) groupInviteCode(revoke bool) func(http.ResponseWriter, *http.Request, params) {
	return func(w http.ResponseWriter, r *http.Request, p params) {
		ss := s.sessW(w, p["session"])
		if ss == nil {
			return
		}
		c, cancel := ctx(r, 25*time.Second)
		defer cancel()
		link, err := ss.GroupInviteLink(c, p["id"], revoke)
		if err != nil {
			s.fail(w, r, ss, err)
			return
		}
		code := 200
		if revoke {
			code = 201
		}
		writeJSON(w, code, strings.TrimSpace(link))
	}
}
