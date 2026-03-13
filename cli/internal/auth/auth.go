package auth

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
)

const (
	SupabaseURL = "https://fvatjlbtyegsqjuwbxxx.supabase.co"
	SupabaseKey = "sb_publishable_63eVkBc4ZgqIqnq2dNhzKA_0NlUw5Y5"
)

type AuthResponse struct {
	AccessToken string `json:"access_token"`
	User        struct {
		ID    string `json:"id"`
		Email string `json:"email"`
	} `json:"user"`
	ErrorDescription string `json:"error_description"`
	Error            string `json:"error"`
}

func Login(email, password string) (*AuthResponse, error) {
	body, _ := json.Marshal(map[string]string{
		"email":    email,
		"password": password,
	})

	req, _ := http.NewRequest("POST", SupabaseURL+"/auth/v1/token?grant_type=password", bytes.NewReader(body))
	req.Header.Set("apikey", SupabaseKey)
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	var result AuthResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("decode failed: %w", err)
	}

	if result.AccessToken == "" {
		msg := result.ErrorDescription
		if msg == "" {
			msg = result.Error
		}
		return nil, fmt.Errorf("login failed: %s", msg)
	}

	return &result, nil
}
