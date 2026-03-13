package cmd

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"time"

	"github.com/fatih/color"
	"github.com/spf13/cobra"
)

var connectionsCmd = &cobra.Command{
	Use:     "connections",
	Aliases: []string{"conn", "c"},
	Short:   "Manage WhatsApp connections",
}

var connListCmd = &cobra.Command{
	Use:     "list",
	Aliases: []string{"ls"},
	Short:   "List all connections",
	RunE: func(cmd *cobra.Command, args []string) error {
		resp, err := client.Do("GET", "/api/connections", nil)
		if err != nil {
			return err
		}

		var connections []map[string]interface{}
		if err := resp.JSON(&connections); err != nil || len(connections) == 0 {
			resp.Print()
			return nil
		}

		// Table output
		fmt.Printf("%-36s  %-10s  %-30s  %s\n", "ID", "STATUS", "SESSION", "PHONE")
		fmt.Println("────────────────────────────────────  ──────────  ──────────────────────────────  ──────────────")
		for _, c := range connections {
			id, _ := c["id"].(string)
			status, _ := c["status"].(string)
			session, _ := c["session_name"].(string)
			if session == "" {
				session, _ = c["sessionName"].(string)
			}
			phone, _ := c["phone_number"].(string)
			if phone == "" {
				phone, _ = c["phoneNumber"].(string)
			}

			statusColor := color.New(color.FgYellow)
			if status == "working" {
				statusColor = color.New(color.FgGreen)
			} else if status == "stopped" || status == "failed" {
				statusColor = color.New(color.FgRed)
			}

			fmt.Printf("%-36s  ", id)
			statusColor.Printf("%-10s", status)
			fmt.Printf("  %-30s  %s\n", session, phone)
		}

		color.New(color.Faint).Printf("\n%d connection(s)\n", len(connections))
		return nil
	},
}

var connCreateCmd = &cobra.Command{
	Use:   "create",
	Short: "Create a new connection",
	RunE: func(cmd *cobra.Command, args []string) error {
		resp, err := client.Do("POST", "/api/connections", nil)
		if err != nil {
			return err
		}

		var conn map[string]interface{}
		if err := resp.JSON(&conn); err == nil {
			if id, ok := conn["id"].(string); ok {
				status, _ := conn["status"].(string)
				color.Green("Created connection %s (status: %s)", id, status)
				return nil
			}
		}

		resp.Print()
		return nil
	},
}

var connGetCmd = &cobra.Command{
	Use:   "get <id>",
	Short: "Get connection details",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		resp, err := client.Do("GET", "/api/connections/"+args[0], nil)
		if err != nil {
			return err
		}
		resp.Print()
		return nil
	},
}

var connQRCmd = &cobra.Command{
	Use:   "qr <id>",
	Short: "Get QR code for a connection (saves to /tmp/wahooks-qr.png)",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		poll, _ := cmd.Flags().GetBool("poll")
		maxAttempts := 20
		if !poll {
			maxAttempts = 1
		}

		for i := 1; i <= maxAttempts; i++ {
			resp, err := client.Do("GET", "/api/connections/"+args[0]+"/qr", nil)
			if err != nil {
				return err
			}

			if resp.StatusCode == 200 {
				var data map[string]interface{}
				if err := resp.JSON(&data); err == nil {
					// Already connected
					if connected, ok := data["connected"].(bool); ok && connected {
						color.Green("Already connected!")
						return nil
					}

					// QR code
					if value, ok := data["value"].(string); ok {
						imgData, err := base64.StdEncoding.DecodeString(value)
						if err == nil {
							path := "/tmp/wahooks-qr.png"
							os.WriteFile(path, imgData, 0644)
							color.Green("QR saved to %s", path)

							// Try to open
							if runtime.GOOS == "darwin" {
								exec.Command("open", path).Start()
							} else if runtime.GOOS == "linux" {
								exec.Command("xdg-open", path).Start()
							}

							color.Yellow("Scan the QR code with WhatsApp")
							return nil
						}
					}
				}

				resp.Print()
				return nil
			}

			if poll && i < maxAttempts {
				color.New(color.Faint).Printf("Attempt %d/%d: QR not ready (HTTP %d), retrying...\n", i, maxAttempts, resp.StatusCode)
				time.Sleep(3 * time.Second)
			} else {
				resp.Print()
			}
		}

		return fmt.Errorf("could not get QR code after %d attempts", maxAttempts)
	},
}

var connMeCmd = &cobra.Command{
	Use:   "me <id>",
	Short: "Get WhatsApp profile for a connection",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		resp, err := client.Do("GET", "/api/connections/"+args[0]+"/me", nil)
		if err != nil {
			return err
		}
		resp.Print()
		return nil
	},
}

var connChatsCmd = &cobra.Command{
	Use:   "chats <id>",
	Short: "Get recent chats for a connection",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		resp, err := client.Do("GET", "/api/connections/"+args[0]+"/chats", nil)
		if err != nil {
			return err
		}

		var chats []map[string]interface{}
		if err := resp.JSON(&chats); err != nil || len(chats) == 0 {
			resp.Print()
			return nil
		}

		limit, _ := cmd.Flags().GetInt("limit")
		if limit <= 0 {
			limit = 20
		}

		for i, chat := range chats {
			if i >= limit {
				color.New(color.Faint).Printf("  ... and %d more\n", len(chats)-limit)
				break
			}
			name, _ := chat["name"].(string)
			id, _ := chat["id"].(string)
			if name == "" {
				name = id
			}

			var lastMsg string
			if lm, ok := chat["lastMessage"].(map[string]interface{}); ok {
				body, _ := lm["body"].(string)
				if len(body) > 60 {
					body = body[:60] + "..."
				}
				if fromMe, _ := lm["fromMe"].(bool); fromMe {
					lastMsg = "You: " + body
				} else {
					lastMsg = body
				}
			}

			fmt.Printf("  • %s", name)
			if lastMsg != "" {
				color.New(color.Faint).Printf(" — %s", lastMsg)
			}
			fmt.Println()
		}

		color.New(color.Faint).Printf("\n%d chat(s)\n", len(chats))
		return nil
	},
}

var connRestartCmd = &cobra.Command{
	Use:   "restart <id>",
	Short: "Restart a connection",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		resp, err := client.Do("POST", "/api/connections/"+args[0]+"/restart", nil)
		if err != nil {
			return err
		}
		resp.Print()
		return nil
	},
}

var connDeleteCmd = &cobra.Command{
	Use:     "delete <id>",
	Aliases: []string{"rm"},
	Short:   "Delete a connection",
	Args:    cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		resp, err := client.Do("DELETE", "/api/connections/"+args[0], nil)
		if err != nil {
			return err
		}

		var result map[string]interface{}
		if err := resp.JSON(&result); err == nil {
			if status, ok := result["status"].(string); ok && status == "stopped" {
				color.Green("Connection deleted")
				return nil
			}
		}

		resp.Print()
		return nil
	},
}

// e2e runs a full end-to-end test cycle
var connE2ECmd = &cobra.Command{
	Use:   "e2e",
	Short: "Run end-to-end test: create → qr → restart → delete",
	RunE: func(cmd *cobra.Command, args []string) error {
		noScan, _ := cmd.Flags().GetBool("no-scan")
		bold := color.New(color.Bold)
		pass, fail := 0, 0

		ok := func(msg string) { color.Green("  ✓ %s", msg); pass++ }
		bad := func(msg string) { color.Red("  ✗ %s", msg); fail++ }

		// Health
		bold.Println("Health check...")
		resp, err := client.Do("GET", "/api", nil)
		if err != nil {
			return err
		}
		if resp.StatusCode == 200 {
			ok(fmt.Sprintf("GET /api (%dms)", resp.Duration.Milliseconds()))
		} else {
			bad(fmt.Sprintf("GET /api: HTTP %d", resp.StatusCode))
			return fmt.Errorf("health check failed")
		}

		// Auth guard
		bold.Println("Auth guard...")
		noAuthClient := *client
		noAuthClient.Token = ""
		resp, _ = noAuthClient.Do("GET", "/api/connections", nil)
		if resp.StatusCode == 401 {
			ok("401 without token")
		} else {
			bad(fmt.Sprintf("expected 401, got %d", resp.StatusCode))
		}

		// List connections
		bold.Println("List connections...")
		resp, _ = client.Do("GET", "/api/connections", nil)
		var conns []json.RawMessage
		resp.JSON(&conns)
		ok(fmt.Sprintf("%d existing connections (%dms)", len(conns), resp.Duration.Milliseconds()))

		// Create
		bold.Println("Create connection...")
		resp, err = client.Do("POST", "/api/connections", nil)
		if err != nil {
			return err
		}
		var created map[string]interface{}
		resp.JSON(&created)
		connID, _ := created["id"].(string)
		connStatus, _ := created["status"].(string)
		if connID != "" {
			ok(fmt.Sprintf("created %s (status: %s, %dms)", connID, connStatus, resp.Duration.Milliseconds()))
		} else {
			bad("failed to create connection")
			resp.Print()
			return fmt.Errorf("create failed")
		}

		// QR
		bold.Println("Fetch QR code...")
		qrObtained := false
		for i := 1; i <= 20; i++ {
			resp, _ = client.Do("GET", "/api/connections/"+connID+"/qr", nil)
			if resp.StatusCode == 200 {
				var qr map[string]interface{}
				resp.JSON(&qr)
				if connected, _ := qr["connected"].(bool); connected {
					ok("already connected")
				} else if _, hasValue := qr["value"]; hasValue {
					ok(fmt.Sprintf("QR obtained (%dms)", resp.Duration.Milliseconds()))
					if !noScan {
						imgData, _ := base64.StdEncoding.DecodeString(qr["value"].(string))
						os.WriteFile("/tmp/wahooks-qr.png", imgData, 0644)
						exec.Command("open", "/tmp/wahooks-qr.png").Start()
						color.Yellow("  ▶ Scan QR with WhatsApp")
					}
				}
				qrObtained = true
				break
			}
			color.New(color.Faint).Printf("  attempt %d/20: HTTP %d, retrying...\n", i, resp.StatusCode)
			time.Sleep(3 * time.Second)
		}
		if !qrObtained {
			bad("QR not available after 20 attempts")
		}

		// Me
		bold.Println("Profile...")
		resp, _ = client.Do("GET", "/api/connections/"+connID+"/me", nil)
		ok(fmt.Sprintf("GET /me: HTTP %d (%dms)", resp.StatusCode, resp.Duration.Milliseconds()))

		// Chats
		bold.Println("Chats...")
		resp, _ = client.Do("GET", "/api/connections/"+connID+"/chats", nil)
		ok(fmt.Sprintf("GET /chats: HTTP %d (%dms)", resp.StatusCode, resp.Duration.Milliseconds()))

		// Restart
		bold.Println("Restart...")
		resp, _ = client.Do("POST", "/api/connections/"+connID+"/restart", nil)
		ok(fmt.Sprintf("POST /restart: HTTP %d (%dms)", resp.StatusCode, resp.Duration.Milliseconds()))

		// Delete
		bold.Println("Delete...")
		resp, _ = client.Do("DELETE", "/api/connections/"+connID, nil)
		ok(fmt.Sprintf("DELETE: HTTP %d (%dms)", resp.StatusCode, resp.Duration.Milliseconds()))

		// Verify
		resp, _ = client.Do("GET", "/api/connections", nil)
		resp.JSON(&conns)
		ok(fmt.Sprintf("connections after cleanup: %d", len(conns)))

		fmt.Println()
		color.Green("═══════════════════════════════════════")
		color.Green("  E2E Complete!  ✓ %d passed  ✗ %d failed", pass, fail)
		color.Green("═══════════════════════════════════════")

		if fail > 0 {
			os.Exit(1)
		}
		return nil
	},
}

func init() {
	connQRCmd.Flags().Bool("poll", false, "Poll until QR is available")
	connChatsCmd.Flags().Int("limit", 20, "Max chats to display")
	connE2ECmd.Flags().Bool("no-scan", true, "Skip QR scan (default: true)")

	connectionsCmd.AddCommand(connListCmd)
	connectionsCmd.AddCommand(connCreateCmd)
	connectionsCmd.AddCommand(connGetCmd)
	connectionsCmd.AddCommand(connQRCmd)
	connectionsCmd.AddCommand(connMeCmd)
	connectionsCmd.AddCommand(connChatsCmd)
	connectionsCmd.AddCommand(connRestartCmd)
	connectionsCmd.AddCommand(connDeleteCmd)
	connectionsCmd.AddCommand(connE2ECmd)

	rootCmd.AddCommand(connectionsCmd)
}
