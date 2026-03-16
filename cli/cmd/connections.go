package cmd

import (
	"encoding/base64"
	"fmt"
	"mime"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/dhruvyad/wahooks/cli/internal/style"
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

		table := style.NewTable("ID", "STATUS", "SESSION", "PHONE")
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

			statusColor := style.StatusColor(status)
			table.AddColoredRow(
				[]string{id, status, session, phone},
				[]*color.Color{nil, statusColor, nil, nil},
			)
		}
		table.Print()
		style.Count(len(connections), "connection")
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
				style.Success("Created connection %s (status: %s)", id, status)
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

		var stop func()
		if poll {
			stop = style.Spinner("Waiting for QR code...")
		}

		for i := 1; i <= maxAttempts; i++ {
			resp, err := client.Do("GET", "/api/connections/"+args[0]+"/qr", nil)
			if err != nil {
				if stop != nil {
					stop()
				}
				return err
			}

			if resp.StatusCode == 200 {
				if stop != nil {
					stop()
				}
				var data map[string]interface{}
				if err := resp.JSON(&data); err == nil {
					// Already connected
					if connected, ok := data["connected"].(bool); ok && connected {
						style.Success("Already connected!")
						return nil
					}

					// QR code
					if value, ok := data["value"].(string); ok {
						imgData, err := base64.StdEncoding.DecodeString(value)
						if err == nil {
							path := "/tmp/wahooks-qr.png"
							os.WriteFile(path, imgData, 0644)
							style.Success("QR saved to %s", path)

							// Try to open
							if runtime.GOOS == "darwin" {
								exec.Command("open", path).Start()
							} else if runtime.GOOS == "linux" {
								exec.Command("xdg-open", path).Start()
							}

							style.Warn("Scan the QR code with WhatsApp")
							return nil
						}
					}
				}

				resp.Print()
				return nil
			}

			if poll && i < maxAttempts {
				time.Sleep(3 * time.Second)
			} else {
				if stop != nil {
					stop()
				}
				resp.Print()
			}
		}

		if stop != nil {
			stop()
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

		fmt.Println()
		for i, chat := range chats {
			if i >= limit {
				style.Dim("  ... and %d more", len(chats)-limit)
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

			fmt.Printf("  %s %s", color.New(color.FgCyan).Sprint("\u2022"), name)
			if lastMsg != "" {
				color.New(color.Faint).Printf(" \u2014 %s", lastMsg)
			}
			fmt.Println()
		}

		fmt.Println()
		style.Count(len(chats), "chat")
		return nil
	},
}

var connSendCmd = &cobra.Command{
	Use:   "send <id> <phone> <message>",
	Short: "Send a text message via a connection",
	Args:  cobra.ExactArgs(3),
	RunE: func(cmd *cobra.Command, args []string) error {
		connID := args[0]
		phone := args[1]
		message := args[2]

		chatId := phone
		if !strings.Contains(chatId, "@") {
			chatId = chatId + "@c.us"
		}

		body := map[string]interface{}{
			"chatId": chatId,
			"text":   message,
		}

		resp, err := client.Do("POST", "/api/connections/"+connID+"/send", body)
		if err != nil {
			return err
		}

		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			style.Success("Message sent to %s", phone)
			return nil
		}

		resp.Print()
		return nil
	},
}

// Helper to normalize phone to chatId format
func normalizeChatId(phone string) string {
	if !strings.Contains(phone, "@") {
		return phone + "@c.us"
	}
	return phone
}

// isURL returns true if the string looks like a URL rather than a local file path.
func isURL(s string) bool {
	return strings.HasPrefix(s, "http://") || strings.HasPrefix(s, "https://")
}

func mediaSendCmd(use, short, endpoint string, hasCaption, hasFilename bool) *cobra.Command {
	cmd := &cobra.Command{
		Use:   use,
		Short: short,
		Args:  cobra.ExactArgs(3),
		RunE: func(cmd *cobra.Command, args []string) error {
			body := map[string]interface{}{
				"chatId": normalizeChatId(args[1]),
			}

			source := args[2]
			if isURL(source) {
				body["url"] = source
			} else {
				// Local file — read, base64-encode, detect mimetype
				fileData, err := os.ReadFile(source)
				if err != nil {
					return fmt.Errorf("read file: %w", err)
				}
				body["data"] = base64.StdEncoding.EncodeToString(fileData)
				ext := filepath.Ext(source)
				if mt := mime.TypeByExtension(ext); mt != "" {
					body["mimetype"] = mt
				}
				// Auto-set filename from path if the endpoint supports it
				if hasFilename {
					if f, _ := cmd.Flags().GetString("filename"); f == "" {
						body["filename"] = filepath.Base(source)
					}
				}
				style.Dim("Uploading %s (%d bytes)", filepath.Base(source), len(fileData))
			}

			if hasCaption {
				if c, _ := cmd.Flags().GetString("caption"); c != "" {
					body["caption"] = c
				}
			}
			if hasFilename {
				if f, _ := cmd.Flags().GetString("filename"); f != "" {
					body["filename"] = f
				}
			}
			resp, err := client.Do("POST", "/api/connections/"+args[0]+"/"+endpoint, body)
			if err != nil {
				return err
			}
			if resp.StatusCode >= 200 && resp.StatusCode < 300 {
				style.Success("Sent to %s", args[1])
				return nil
			}
			resp.Print()
			return nil
		},
	}
	if hasCaption {
		cmd.Flags().String("caption", "", "Caption text")
	}
	if hasFilename {
		cmd.Flags().String("filename", "", "Filename for the document")
	}
	return cmd
}

var connSendImageCmd = mediaSendCmd("send-image <id> <phone> <url-or-file>", "Send an image (URL or local file)", "send-image", true, false)
var connSendDocCmd = mediaSendCmd("send-document <id> <phone> <url-or-file>", "Send a document (URL or local file)", "send-document", true, true)
var connSendVideoCmd = mediaSendCmd("send-video <id> <phone> <url-or-file>", "Send a video (URL or local file)", "send-video", true, false)
var connSendAudioCmd = mediaSendCmd("send-audio <id> <phone> <url-or-file>", "Send audio (URL or local file)", "send-audio", false, false)

var connSendLocationCmd = &cobra.Command{
	Use:   "send-location <id> <phone> <latitude> <longitude>",
	Short: "Send a location pin",
	Args:  cobra.ExactArgs(4),
	RunE: func(cmd *cobra.Command, args []string) error {
		var lat, lng float64
		fmt.Sscanf(args[2], "%f", &lat)
		fmt.Sscanf(args[3], "%f", &lng)
		body := map[string]interface{}{
			"chatId":    normalizeChatId(args[1]),
			"latitude":  lat,
			"longitude": lng,
		}
		if n, _ := cmd.Flags().GetString("name"); n != "" {
			body["name"] = n
		}
		if a, _ := cmd.Flags().GetString("address"); a != "" {
			body["address"] = a
		}
		resp, err := client.Do("POST", "/api/connections/"+args[0]+"/send-location", body)
		if err != nil {
			return err
		}
		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			style.Success("Location sent to %s", args[1])
			return nil
		}
		resp.Print()
		return nil
	},
}

var connSendContactCmd = &cobra.Command{
	Use:   "send-contact <id> <phone> <contact-name> <contact-phone>",
	Short: "Send a contact card",
	Args:  cobra.ExactArgs(4),
	RunE: func(cmd *cobra.Command, args []string) error {
		body := map[string]interface{}{
			"chatId":       normalizeChatId(args[1]),
			"contactName":  args[2],
			"contactPhone": args[3],
		}
		resp, err := client.Do("POST", "/api/connections/"+args[0]+"/send-contact", body)
		if err != nil {
			return err
		}
		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			style.Success("Contact sent to %s", args[1])
			return nil
		}
		resp.Print()
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

var connQuickCmd = &cobra.Command{
	Use:     "quick",
	Aliases: []string{"q"},
	Short:   "Get a scannable connection (reuses idle or creates new)",
	RunE: func(cmd *cobra.Command, args []string) error {
		stop := style.Spinner("Getting scannable connection...")

		resp, err := client.Do("POST", "/api/connections/get-or-create", nil)
		stop()
		if err != nil {
			return err
		}

		var result map[string]interface{}
		if err := resp.JSON(&result); err != nil {
			resp.Print()
			return nil
		}

		id, _ := result["id"].(string)
		status, _ := result["status"].(string)
		qr, _ := result["qr"].(string)

		if id == "" {
			resp.Print()
			return nil
		}

		style.Success("Connection %s (status: %s)", id, status)

		if qr != "" {
			imgData, err := base64.StdEncoding.DecodeString(qr)
			if err == nil {
				path := "/tmp/wahooks-qr.png"
				os.WriteFile(path, imgData, 0644)
				style.Info("QR saved to %s", path)
				if runtime.GOOS == "darwin" {
					exec.Command("open", path).Start()
				} else if runtime.GOOS == "linux" {
					exec.Command("xdg-open", path).Start()
				}
				style.Warn("Scan the QR code with WhatsApp")
			}
		} else if status == "working" {
			style.Success("Already connected — no QR needed")
		} else {
			style.Dim("QR not ready yet. Run: wahooks connections qr %s --poll", id)
		}

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
				style.Success("Connection deleted")
				return nil
			}
		}

		resp.Print()
		return nil
	},
}

func init() {
	connQRCmd.Flags().Bool("poll", false, "Poll until QR is available")
	connChatsCmd.Flags().Int("limit", 20, "Max chats to display")

	connectionsCmd.AddCommand(connListCmd)
	connectionsCmd.AddCommand(connCreateCmd)
	connectionsCmd.AddCommand(connGetCmd)
	connectionsCmd.AddCommand(connQRCmd)
	connectionsCmd.AddCommand(connMeCmd)
	connectionsCmd.AddCommand(connChatsCmd)
	connectionsCmd.AddCommand(connSendCmd)
	connectionsCmd.AddCommand(connSendImageCmd)
	connectionsCmd.AddCommand(connSendDocCmd)
	connectionsCmd.AddCommand(connSendVideoCmd)
	connectionsCmd.AddCommand(connSendAudioCmd)
	connSendLocationCmd.Flags().String("name", "", "Location name")
	connSendLocationCmd.Flags().String("address", "", "Location address")
	connectionsCmd.AddCommand(connSendLocationCmd)
	connectionsCmd.AddCommand(connSendContactCmd)
	connectionsCmd.AddCommand(connRestartCmd)
	connectionsCmd.AddCommand(connDeleteCmd)
	connectionsCmd.AddCommand(connQuickCmd)

	rootCmd.AddCommand(connectionsCmd)
}
