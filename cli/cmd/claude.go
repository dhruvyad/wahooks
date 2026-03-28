package cmd

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"syscall"

	"github.com/dhruvyad/wahooks/cli/internal/style"
	"github.com/spf13/cobra"
)

var claudeCmd = &cobra.Command{
	Use:                "claude [-- claude-args...]",
	Short:              "Launch Claude Code with the WhatsApp channel",
	DisableFlagParsing: true,
	RunE: func(cmd *cobra.Command, args []string) error {
		// Handle --help / setup subcommand before disabling flag parsing
		for _, a := range args {
			if a == "--help" || a == "-h" {
				return cmd.Help()
			}
			if a == "setup" {
				return claudeSetupCmd.RunE(claudeSetupCmd, args[1:])
			}
		}
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

		// Ensure reminder daemon is running
		ensureReminderDaemon(home)

		// Launch claude with the channel
		style.Success("Launching Claude Code with WhatsApp channel...")
		fmt.Println()

		launchArgs := []string{
			"claude",
			"--dangerously-load-development-channels",
			"server:wahooks-channel",
			"--dangerously-skip-permissions",
		}

		// Pass through any extra args (strip leading --)
		for _, a := range args {
			if a != "--" {
				launchArgs = append(launchArgs, a)
			}
		}

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

		// 5. Register MCP server in ~/.claude.json (user-scoped)
		claudeJsonPath := filepath.Join(home, ".claude.json")
		claudeJson := make(map[string]interface{})

		if data, err := os.ReadFile(claudeJsonPath); err == nil {
			json.Unmarshal(data, &claudeJson)
		}

		servers, ok2 := claudeJson["mcpServers"].(map[string]interface{})
		if !ok2 {
			servers = make(map[string]interface{})
		}

		servers["wahooks-channel"] = map[string]interface{}{
			"type":    "stdio",
			"command": "wahooks-channel",
			"args":    []string{},
			"env":     map[string]interface{}{},
		}
		claudeJson["mcpServers"] = servers

		claudeData, _ := json.MarshalIndent(claudeJson, "", "  ")
		if err := os.WriteFile(claudeJsonPath, claudeData, 0600); err != nil {
			return fmt.Errorf("write MCP config: %w", err)
		}
		style.Success("MCP server registered")

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

		// 7. Start reminder daemon (bundled with @wahooks/channel)
		ensureReminderDaemon(home)

		fmt.Println()
		style.Header("Setup complete!")
		fmt.Println()
		style.Info("Launch Claude with WhatsApp:")
		fmt.Println("  wahooks claude")
		fmt.Println()

		return nil
	},
}

func ensureReminderDaemon(home string) {
	if runtime.GOOS != "darwin" {
		return // launchd is macOS only
	}

	plistName := "com.wahooks.reminders"
	plistPath := filepath.Join(home, "Library", "LaunchAgents", plistName+".plist")

	reminderBin, err := exec.LookPath("wahooks-reminders")
	if err != nil {
		return // not installed
	}

	// Check if plist exists
	if _, err := os.Stat(plistPath); os.IsNotExist(err) {
		plist := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>%s</string>
    <key>ProgramArguments</key>
    <array>
        <string>%s</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>%s/.wahooks/reminders.log</string>
    <key>StandardErrorPath</key>
    <string>%s/.wahooks/reminders.log</string>
</dict>
</plist>`, plistName, reminderBin, home, home)

		os.MkdirAll(filepath.Dir(plistPath), 0755)
		os.WriteFile(plistPath, []byte(plist), 0644)
		exec.Command("launchctl", "load", plistPath).Run()
		style.Success("Reminder daemon registered with launchd")
	} else {
		// Already registered — make sure it's running
		exec.Command("launchctl", "start", plistName).Run()
	}
}

func init() {
	claudeCmd.AddCommand(claudeSetupCmd)
	rootCmd.AddCommand(claudeCmd)
}
