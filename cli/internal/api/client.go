package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/fatih/color"
)

// TokenRefresher is called when a 401 is received. It should return new access+refresh tokens.
type TokenRefresher func() (accessToken, refreshToken string, err error)

type Client struct {
	BaseURL        string
	Token          string
	HTTPClient     *http.Client
	TokenRefresher TokenRefresher
	OnTokenRefresh func(accessToken, refreshToken string)
}

type Response struct {
	StatusCode int
	Body       json.RawMessage
	Duration   time.Duration
}

func NewClient(baseURL, token string) *Client {
	return &Client{
		BaseURL: baseURL,
		Token:   token,
		HTTPClient: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
}

func (c *Client) Do(method, path string, body interface{}) (*Response, error) {
	resp, err := c.doRequest(method, path, body)
	if err != nil {
		return nil, err
	}

	// Auto-refresh on 401 if we have a refresher
	if resp.StatusCode == 401 && c.TokenRefresher != nil {
		accessToken, refreshToken, refreshErr := c.TokenRefresher()
		if refreshErr == nil {
			c.Token = accessToken
			if c.OnTokenRefresh != nil {
				c.OnTokenRefresh(accessToken, refreshToken)
			}
			// Retry the original request with the new token
			return c.doRequest(method, path, body)
		}
	}

	return resp, nil
}

func (c *Client) doRequest(method, path string, body interface{}) (*Response, error) {
	var bodyReader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		bodyReader = bytes.NewReader(data)
	}

	req, err := http.NewRequest(method, c.BaseURL+path, bodyReader)
	if err != nil {
		return nil, err
	}

	req.Header.Set("Content-Type", "application/json")
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}

	start := time.Now()
	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()
	duration := time.Since(start)

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read body: %w", err)
	}

	return &Response{
		StatusCode: resp.StatusCode,
		Body:       json.RawMessage(data),
		Duration:   duration,
	}, nil
}

func (r *Response) Print() {
	// Status line
	dim := color.New(color.Faint)
	dim.Printf("%dms ", r.Duration.Milliseconds())

	if r.StatusCode >= 200 && r.StatusCode < 300 {
		color.New(color.FgGreen).Printf("HTTP %d\n", r.StatusCode)
	} else {
		color.New(color.FgRed).Printf("HTTP %d\n", r.StatusCode)
	}

	// Pretty-print body
	var pretty bytes.Buffer
	if err := json.Indent(&pretty, r.Body, "", "  "); err == nil {
		fmt.Println(pretty.String())
	} else {
		fmt.Println(string(r.Body))
	}
}

func (r *Response) JSON(v interface{}) error {
	return json.Unmarshal(r.Body, v)
}
