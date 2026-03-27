package cmd

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"

	"github.com/dhruvyad/wahooks/cli/internal/style"
	"github.com/spf13/cobra"
)

var claudeCmd = &cobra.Command{
	Use:   "claude",
	Short: "Launch Claude Code with the WhatsApp channel",
	RunE: func(cmd *cobra.Command, args []string) error {
		// Check if setup has been done
		home, _ := os.UserHomeDir()
		envPath := filepath.Join(home, ".claude", "channels", "wahooks", ".env")
		if _, err := os.Stat(envPath); os.IsNotExist(err) {
			style.Error("Channel not configured. Run 'wahooks claude setup' first.")
			return nil
		}

		// Check if wahooks-channel is installed
		if _, err := exec.LookPath("wahooks-channel"); err != nil {
			style.Error("wahooks-channel not found. Install it:")
			fmt.Println("  npm install -g @wahooks/channel")
			return nil
		}

		// Check if claude is installed
		claudePath, err := exec.LookPath("claude")
		if err != nil {
			style.Error("claude not found. Install Claude Code first:")
			fmt.Println("  https://code.claude.com")
			return nil
		}

		// Launch claude with the channel
		style.Success("Launching Claude Code with WhatsApp channel...")
		fmt.Println()

		launchArgs := []string{
			"claude",
			"--dangerously-load-development-channels",
			"server:wahooks-channel",
		}

		// Pass through any extra args
		launchArgs = append(launchArgs, args...)

		// Replace this process with claude
		return syscall.Exec(claudePath, launchArgs, os.Environ())
	},
}

var claudeSetupCmd = &cobra.Command{
	Use:   "setup",
	Short: "One-command setup: login, create token, configure channel, write MCP config",
	RunE: func(cmd *cobra.Command, args []string) error {
		home, _ := os.UserHomeDir()

		// 1. Check if logged in — verify token actually works
		needsLogin := cfg.Token == ""
		if !needsLogin {
			resp, err := client.Do("GET", "/api/connections", nil)
			if err != nil || resp.StatusCode == 401 {
				needsLogin = true
			}
		}

		if needsLogin {
			style.Info("Authenticating — opening browser...")
			fmt.Println()
			if err := browserLogin(); err != nil {
				return fmt.Errorf("login failed: %w", err)
			}
			// Reinitialize client with new token
			client.Token = cfg.Token
			fmt.Println()
		} else {
			style.Success("Already authenticated")
		}

		// 2. Create an API token for the channel
		style.Info("Creating API token for Claude channel...")
		resp, err := client.Do("POST", "/api/tokens", map[string]interface{}{
			"name": "claude-channel",
		})
		if err != nil {
			return fmt.Errorf("create token: %w", err)
		}

		var tokenResult map[string]interface{}
		if err := resp.JSON(&tokenResult); err != nil {
			return fmt.Errorf("parse token response: %w", err)
		}

		apiToken, ok := tokenResult["token"].(string)
		if !ok || apiToken == "" {
			return fmt.Errorf("no token returned — you may have hit a limit")
		}
		style.Success("API token created")

		// 3. Find an active connection
		style.Info("Checking for an active connection...")
		resp, err = client.Do("GET", "/api/connections", nil)
		if err != nil {
			return fmt.Errorf("list connections: %w", err)
		}

		var connections []map[string]interface{}
		resp.JSON(&connections)

		var connectionId string
		for _, c := range connections {
			if status, _ := c["status"].(string); status == "connected" {
				connectionId, _ = c["id"].(string)
				break
			}
		}

		if connectionId == "" {
			style.Dim("No active connection found — you can create one later with 'wahooks connections quick'")
		} else {
			style.Success("Using connection %s", connectionId)
		}

		// 4. Write channel config to ~/.claude/channels/wahooks/.env
		channelDir := filepath.Join(home, ".claude", "channels", "wahooks")
		if err := os.MkdirAll(channelDir, 0700); err != nil {
			return fmt.Errorf("create channel dir: %w", err)
		}

		envContent := fmt.Sprintf("WAHOOKS_API_KEY=%s\n", apiToken)
		if cfg.APIURL != "" && cfg.APIURL != "http://localhost:3001" {
			envContent += fmt.Sprintf("WAHOOKS_API_URL=%s\n", cfg.APIURL)
		}
		if connectionId != "" {
			envContent += fmt.Sprintf("WAHOOKS_CONNECTION=%s\n", connectionId)
		}

		envPath := filepath.Join(channelDir, ".env")
		if err := os.WriteFile(envPath, []byte(envContent), 0600); err != nil {
			return fmt.Errorf("write channel config: %w", err)
		}
		style.Success("Channel config saved")

		// 5. Write MCP config to ~/.claude/mcp.json
		mcpPath := filepath.Join(home, ".claude", "mcp.json")
		mcpConfig := make(map[string]interface{})

		if data, err := os.ReadFile(mcpPath); err == nil {
			json.Unmarshal(data, &mcpConfig)
		}

		servers, ok2 := mcpConfig["mcpServers"].(map[string]interface{})
		if !ok2 {
			servers = make(map[string]interface{})
		}

		servers["wahooks-channel"] = map[string]interface{}{
			"command": "wahooks-channel",
			"args":    []string{},
		}
		mcpConfig["mcpServers"] = servers

		mcpData, _ := json.MarshalIndent(mcpConfig, "", "  ")
		if err := os.WriteFile(mcpPath, mcpData, 0600); err != nil {
			return fmt.Errorf("write MCP config: %w", err)
		}
		style.Success("MCP config written")

		// 6. Install @wahooks/channel if not present
		fmt.Println()
		if _, err := exec.LookPath("wahooks-channel"); err != nil {
			style.Info("Installing @wahooks/channel...")
			installCmd := exec.Command("npm", "install", "-g", "@wahooks/channel")
			installCmd.Stdout = os.Stdout
			installCmd.Stderr = os.Stderr
			if err := installCmd.Run(); err != nil {
				style.Warn("Auto-install failed. Install manually:")
				fmt.Println("  npm install -g @wahooks/channel")
				fmt.Println()
			} else {
				style.Success("@wahooks/channel installed")
			}
		} else {
			style.Success("@wahooks/channel already installed")
		}

		fmt.Println()
		style.Header("Setup complete!")
		fmt.Println()
		style.Info("Launch Claude with WhatsApp:")
		fmt.Println("  wahooks claude")
		fmt.Println()

		return nil
	},
}

func init() {
	claudeCmd.AddCommand(claudeSetupCmd)
	rootCmd.AddCommand(claudeCmd)
}
