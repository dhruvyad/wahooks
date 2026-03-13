package config

import (
	"encoding/json"
	"os"
	"path/filepath"
)

type Config struct {
	APIURL string `json:"api_url"`
	Token  string `json:"token"`
}

func configPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".wahooks.json")
}

func Load() *Config {
	cfg := &Config{APIURL: "http://localhost:3001"}
	data, err := os.ReadFile(configPath())
	if err != nil {
		return cfg
	}
	_ = json.Unmarshal(data, cfg)
	return cfg
}

func (c *Config) Save() error {
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(configPath(), data, 0600)
}
