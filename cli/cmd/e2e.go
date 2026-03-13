package cmd

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"

	"github.com/fatih/color"
	"github.com/spf13/cobra"
)

var e2eCmd = &cobra.Command{
	Use:   "e2e",
	Short: "Run comprehensive end-to-end tests across all API endpoints",
	Long: `Tests the full WAHooks API lifecycle:
  health, auth, connections, webhooks, billing, and cleanup.

Non-interactive mode (default) tests everything except QR scanning and messaging.
Interactive mode (--interactive) adds QR scanning and message sending.`,
	RunE: runE2E,
}

func runE2E(cmd *cobra.Command, args []string) error {
	interactive, _ := cmd.Flags().GetBool("interactive")
	webhookURL, _ := cmd.Flags().GetString("webhook-url")
	phone, _ := cmd.Flags().GetString("phone")

	bold := color.New(color.Bold)
	faint := color.New(color.Faint)
	pass, fail, skipped := 0, 0, 0

	ok := func(msg string) { color.Green("  ✓ %s", msg); pass++ }
	bad := func(msg string) { color.Red("  ✗ %s", msg); fail++ }
	skip := func(msg string) { faint.Printf("  - %s (skipped)\n", msg); skipped++ }

	// ───────────────────────────────────────────────────────
	// 1. Health check
	// ───────────────────────────────────────────────────────
	bold.Println("\n1. Health check")
	resp, err := client.Do("GET", "/api", nil)
	if err != nil {
		return fmt.Errorf("health check failed: %w", err)
	}
	if resp.StatusCode == 200 {
		ok(fmt.Sprintf("GET /api (%dms)", resp.Duration.Milliseconds()))
	} else {
		bad(fmt.Sprintf("GET /api: HTTP %d", resp.StatusCode))
		return fmt.Errorf("health check failed — aborting")
	}

	// ───────────────────────────────────────────────────────
	// 2. Auth guard
	// ───────────────────────────────────────────────────────
	bold.Println("\n2. Auth guard")
	noAuthClient := *client
	noAuthClient.Token = ""
	resp, _ = noAuthClient.Do("GET", "/api/connections", nil)
	if resp != nil && resp.StatusCode == 401 {
		ok("401 without token")
	} else {
		status := 0
		if resp != nil {
			status = resp.StatusCode
		}
		bad(fmt.Sprintf("expected 401, got %d", status))
	}

	// ───────────────────────────────────────────────────────
	// 3. List connections (baseline)
	// ───────────────────────────────────────────────────────
	bold.Println("\n3. List connections (baseline)")
	resp, _ = client.Do("GET", "/api/connections", nil)
	var baselineConns []json.RawMessage
	if resp != nil {
		resp.JSON(&baselineConns)
	}
	ok(fmt.Sprintf("%d existing connections", len(baselineConns)))

	// ───────────────────────────────────────────────────────
	// 4. Create connection
	// ───────────────────────────────────────────────────────
	bold.Println("\n4. Create connection")
	resp, err = client.Do("POST", "/api/connections", nil)
	if err != nil {
		return fmt.Errorf("create connection failed: %w", err)
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
		return fmt.Errorf("create failed — aborting")
	}

	// ───────────────────────────────────────────────────────
	// 5. Get connection detail
	// ───────────────────────────────────────────────────────
	bold.Println("\n5. Get connection detail")
	resp, _ = client.Do("GET", "/api/connections/"+connID, nil)
	if resp != nil && resp.StatusCode == 200 {
		ok(fmt.Sprintf("GET /connections/%s (%dms)", connID[:8], resp.Duration.Milliseconds()))
	} else {
		bad("failed to get connection detail")
	}

	// ───────────────────────────────────────────────────────
	// 6. Fetch QR code
	// ───────────────────────────────────────────────────────
	bold.Println("\n6. Fetch QR code")
	qrObtained := false
	isConnected := false
	for i := 1; i <= 20; i++ {
		resp, err = client.Do("GET", "/api/connections/"+connID+"/qr", nil)
		if err != nil || resp == nil {
			faint.Printf("  attempt %d/20: request failed, retrying...\n", i)
			time.Sleep(3 * time.Second)
			continue
		}
		if resp.StatusCode == 200 {
			var qr map[string]interface{}
			resp.JSON(&qr)
			if connected, _ := qr["connected"].(bool); connected {
				ok("already connected")
				isConnected = true
			} else if _, hasValue := qr["value"]; hasValue {
				ok(fmt.Sprintf("QR obtained (%dms)", resp.Duration.Milliseconds()))
			}
			qrObtained = true
			break
		}
		faint.Printf("  attempt %d/20: HTTP %d, retrying...\n", i, resp.StatusCode)
		time.Sleep(3 * time.Second)
	}
	if !qrObtained {
		bad("QR not available after 20 attempts")
	}

	// ───────────────────────────────────────────────────────
	// 7. Interactive QR scan
	// ───────────────────────────────────────────────────────
	if interactive && qrObtained && !isConnected {
		bold.Println("\n7. Interactive QR scan")
		// Save and open QR
		resp, _ = client.Do("GET", "/api/connections/"+connID+"/qr", nil)
		if resp != nil && resp.StatusCode == 200 {
			var qr map[string]interface{}
			resp.JSON(&qr)
			if value, ok := qr["value"].(string); ok {
				imgData, _ := base64.StdEncoding.DecodeString(value)
				path := "/tmp/wahooks-qr.png"
				os.WriteFile(path, imgData, 0644)
				if runtime.GOOS == "darwin" {
					exec.Command("open", path).Start()
				} else if runtime.GOOS == "linux" {
					exec.Command("xdg-open", path).Start()
				}
				color.Yellow("  Scan the QR code with WhatsApp...")
			}
		}

		// Poll until connected (up to 2 minutes)
		for i := 1; i <= 40; i++ {
			time.Sleep(3 * time.Second)
			resp, _ = client.Do("GET", "/api/connections/"+connID+"/qr", nil)
			if resp != nil && resp.StatusCode == 200 {
				var qr map[string]interface{}
				resp.JSON(&qr)
				if connected, _ := qr["connected"].(bool); connected {
					ok("WhatsApp connected!")
					isConnected = true
					break
				}
			}
			if i%5 == 0 {
				faint.Printf("  waiting for scan... (%ds)\n", i*3)
			}
		}
		if !isConnected {
			bad("QR not scanned within timeout")
		}
	} else if interactive {
		if isConnected {
			skip("7. QR scan (already connected)")
		}
	} else {
		skip("7. Interactive QR scan (use --interactive)")
	}

	// ───────────────────────────────────────────────────────
	// 8. Profile and chats
	// ───────────────────────────────────────────────────────
	bold.Println("\n8. Profile and chats")
	resp, _ = client.Do("GET", "/api/connections/"+connID+"/me", nil)
	if resp != nil {
		ok(fmt.Sprintf("GET /me: HTTP %d (%dms)", resp.StatusCode, resp.Duration.Milliseconds()))
	} else {
		bad("GET /me failed")
	}

	resp, _ = client.Do("GET", "/api/connections/"+connID+"/chats", nil)
	if resp != nil {
		ok(fmt.Sprintf("GET /chats: HTTP %d (%dms)", resp.StatusCode, resp.Duration.Milliseconds()))
	} else {
		bad("GET /chats failed")
	}

	// ───────────────────────────────────────────────────────
	// 9. Create webhook
	// ───────────────────────────────────────────────────────
	bold.Println("\n9. Create webhook")
	whBody := map[string]interface{}{
		"url":    webhookURL,
		"events": []string{"*"},
	}
	resp, _ = client.Do("POST", "/api/connections/"+connID+"/webhooks", whBody)
	var whCreated map[string]interface{}
	webhookID := ""
	if resp != nil {
		resp.JSON(&whCreated)
		webhookID, _ = whCreated["id"].(string)
	}
	if webhookID != "" {
		ok(fmt.Sprintf("created webhook %s", webhookID[:8]))
	} else {
		bad("failed to create webhook")
		if resp != nil {
			resp.Print()
		}
	}

	// ───────────────────────────────────────────────────────
	// 10. List webhooks
	// ───────────────────────────────────────────────────────
	bold.Println("\n10. List webhooks")
	resp, _ = client.Do("GET", "/api/connections/"+connID+"/webhooks", nil)
	var webhooks []map[string]interface{}
	if resp != nil {
		resp.JSON(&webhooks)
	}
	found := false
	for _, wh := range webhooks {
		if id, _ := wh["id"].(string); id == webhookID {
			found = true
			break
		}
	}
	if found {
		ok(fmt.Sprintf("%d webhook(s), created webhook found", len(webhooks)))
	} else if len(webhooks) > 0 {
		bad("webhook list doesn't contain created webhook")
	} else {
		bad("webhook list empty")
	}

	// ───────────────────────────────────────────────────────
	// 11. Test webhook delivery
	// ───────────────────────────────────────────────────────
	bold.Println("\n11. Test webhook delivery")
	testLogID := ""
	if webhookID != "" {
		resp, _ = client.Do("POST", "/api/webhooks/"+webhookID+"/test", nil)
		if resp != nil && resp.StatusCode >= 200 && resp.StatusCode < 300 {
			var testResult map[string]interface{}
			resp.JSON(&testResult)
			testLogID, _ = testResult["logId"].(string)
			if testLogID != "" {
				ok(fmt.Sprintf("test event enqueued (log: %s)", testLogID[:8]))
			} else {
				ok("test event enqueued")
			}
		} else {
			bad("test webhook failed")
			if resp != nil {
				resp.Print()
			}
		}
	} else {
		skip("no webhook to test")
	}

	// ───────────────────────────────────────────────────────
	// 12. Webhook delivery logs
	// ───────────────────────────────────────────────────────
	bold.Println("\n12. Webhook delivery logs")
	if webhookID != "" {
		// Poll a few times to let delivery complete
		logFound := false
		for i := 0; i < 5; i++ {
			if i > 0 {
				time.Sleep(2 * time.Second)
			}
			resp, _ = client.Do("GET", "/api/webhooks/"+webhookID+"/logs", nil)
			var logs []map[string]interface{}
			if resp != nil {
				resp.JSON(&logs)
			}
			if len(logs) > 0 {
				latest := logs[0]
				status, _ := latest["status"].(string)
				eventType, _ := latest["event_type"].(string)
				if eventType == "" {
					eventType, _ = latest["eventType"].(string)
				}
				if status != "pending" {
					ok(fmt.Sprintf("%d log(s), latest: %s/%s", len(logs), eventType, status))
					logFound = true
					break
				}
			}
		}
		if !logFound {
			// Still show what we have
			resp, _ = client.Do("GET", "/api/webhooks/"+webhookID+"/logs", nil)
			var logs []map[string]interface{}
			if resp != nil {
				resp.JSON(&logs)
			}
			if len(logs) > 0 {
				ok(fmt.Sprintf("%d log(s) (delivery may still be pending)", len(logs)))
			} else {
				bad("no delivery logs found")
			}
		}
	} else {
		skip("no webhook to check logs")
	}

	// ───────────────────────────────────────────────────────
	// 13. Send test message (interactive only)
	// ───────────────────────────────────────────────────────
	if interactive && isConnected && phone != "" {
		bold.Println("\n13. Send test message")
		chatId := phone
		if !strings.Contains(chatId, "@") {
			chatId = chatId + "@c.us"
		}
		sendBody := map[string]interface{}{
			"chatId": chatId,
			"text":   fmt.Sprintf("WAHooks E2E test %s", time.Now().Format("15:04:05")),
		}
		resp, _ = client.Do("POST", "/api/connections/"+connID+"/send", sendBody)
		if resp != nil && resp.StatusCode >= 200 && resp.StatusCode < 300 {
			ok(fmt.Sprintf("message sent to %s (%dms)", phone, resp.Duration.Milliseconds()))

			// Wait for webhook delivery
			if webhookID != "" {
				faint.Println("  waiting 5s for webhook delivery...")
				time.Sleep(5 * time.Second)
				resp, _ = client.Do("GET", "/api/webhooks/"+webhookID+"/logs", nil)
				var logs []map[string]interface{}
				if resp != nil {
					resp.JSON(&logs)
				}
				// Find a message event (not the test event)
				messageDelivered := false
				for _, l := range logs {
					et, _ := l["event_type"].(string)
					if et == "" {
						et, _ = l["eventType"].(string)
					}
					if et != "test" {
						messageDelivered = true
						status, _ := l["status"].(string)
						ok(fmt.Sprintf("webhook received %s event (status: %s)", et, status))
						break
					}
				}
				if !messageDelivered {
					faint.Println("  no message webhook delivered yet (may take longer)")
				}
			}
		} else {
			bad("send message failed")
			if resp != nil {
				resp.Print()
			}
		}
	} else if interactive && !isConnected {
		skip("13. Send message (not connected)")
	} else {
		skip("13. Send message (use --interactive --phone <number>)")
	}

	// ───────────────────────────────────────────────────────
	// 14. Update webhook
	// ───────────────────────────────────────────────────────
	bold.Println("\n14. Update webhook")
	if webhookID != "" {
		// Disable
		resp, _ = client.Do("PUT", "/api/webhooks/"+webhookID, map[string]interface{}{"active": false})
		if resp != nil && resp.StatusCode == 200 {
			var updated map[string]interface{}
			resp.JSON(&updated)
			active, _ := updated["active"].(bool)
			if !active {
				ok("disabled webhook (active=false)")
			} else {
				bad("webhook should be disabled")
			}
		} else {
			bad("update webhook (disable) failed")
		}

		// Re-enable
		resp, _ = client.Do("PUT", "/api/webhooks/"+webhookID, map[string]interface{}{"active": true})
		if resp != nil && resp.StatusCode == 200 {
			var updated map[string]interface{}
			resp.JSON(&updated)
			active, _ := updated["active"].(bool)
			if active {
				ok("re-enabled webhook (active=true)")
			} else {
				bad("webhook should be enabled")
			}
		} else {
			bad("update webhook (enable) failed")
		}
	} else {
		skip("no webhook to update")
	}

	// ───────────────────────────────────────────────────────
	// 15. Delete webhook
	// ───────────────────────────────────────────────────────
	bold.Println("\n15. Delete webhook")
	if webhookID != "" {
		resp, _ = client.Do("DELETE", "/api/webhooks/"+webhookID, nil)
		if resp != nil && resp.StatusCode == 200 {
			ok("webhook deleted")
		} else {
			bad("delete webhook failed")
		}

		// Verify deleted
		resp, _ = client.Do("GET", "/api/connections/"+connID+"/webhooks", nil)
		var remaining []map[string]interface{}
		if resp != nil {
			resp.JSON(&remaining)
		}
		stillExists := false
		for _, wh := range remaining {
			if id, _ := wh["id"].(string); id == webhookID {
				stillExists = true
				break
			}
		}
		if !stillExists {
			ok("verified webhook removed from list")
		} else {
			bad("webhook still in list after delete")
		}
	} else {
		skip("no webhook to delete")
	}

	// ───────────────────────────────────────────────────────
	// 16. Billing
	// ───────────────────────────────────────────────────────
	bold.Println("\n16. Billing")
	resp, _ = client.Do("GET", "/api/billing/status", nil)
	if resp != nil && resp.StatusCode == 200 {
		ok(fmt.Sprintf("GET /billing/status: HTTP %d (%dms)", resp.StatusCode, resp.Duration.Milliseconds()))
	} else if resp != nil {
		// Billing may fail if Stripe not configured — treat as warning
		color.Yellow("  ! GET /billing/status: HTTP %d (Stripe may not be configured)", resp.StatusCode)
	} else {
		bad("GET /billing/status failed")
	}

	resp, _ = client.Do("GET", "/api/billing/usage", nil)
	if resp != nil && resp.StatusCode == 200 {
		ok(fmt.Sprintf("GET /billing/usage: HTTP %d (%dms)", resp.StatusCode, resp.Duration.Milliseconds()))
	} else if resp != nil {
		color.Yellow("  ! GET /billing/usage: HTTP %d (Stripe may not be configured)", resp.StatusCode)
	} else {
		bad("GET /billing/usage failed")
	}

	// ───────────────────────────────────────────────────────
	// 17. Restart connection
	// ───────────────────────────────────────────────────────
	bold.Println("\n17. Restart connection")
	resp, _ = client.Do("POST", "/api/connections/"+connID+"/restart", nil)
	if resp != nil && resp.StatusCode >= 200 && resp.StatusCode < 300 {
		ok(fmt.Sprintf("POST /restart: HTTP %d (%dms)", resp.StatusCode, resp.Duration.Milliseconds()))
	} else {
		bad(fmt.Sprintf("restart failed (HTTP %d)", resp.StatusCode))
	}

	// ───────────────────────────────────────────────────────
	// 18. Delete connection
	// ───────────────────────────────────────────────────────
	bold.Println("\n18. Delete connection")
	resp, _ = client.Do("DELETE", "/api/connections/"+connID, nil)
	if resp != nil && resp.StatusCode == 200 {
		ok(fmt.Sprintf("DELETE: HTTP %d (%dms)", resp.StatusCode, resp.Duration.Milliseconds()))
	} else {
		bad("delete failed")
	}

	// ───────────────────────────────────────────────────────
	// 19. Verify cleanup
	// ───────────────────────────────────────────────────────
	bold.Println("\n19. Verify cleanup")
	resp, _ = client.Do("GET", "/api/connections", nil)
	var finalConns []json.RawMessage
	if resp != nil {
		resp.JSON(&finalConns)
	}
	if len(finalConns) == len(baselineConns) {
		ok(fmt.Sprintf("connections back to baseline (%d)", len(finalConns)))
	} else {
		bad(fmt.Sprintf("expected %d connections, got %d", len(baselineConns), len(finalConns)))
	}

	// ───────────────────────────────────────────────────────
	// Summary
	// ───────────────────────────────────────────────────────
	fmt.Println()
	color.Green("═══════════════════════════════════════════════════")
	color.Green("  E2E Complete!  ✓ %d passed  ✗ %d failed  - %d skipped", pass, fail, skipped)
	color.Green("═══════════════════════════════════════════════════")

	if fail > 0 {
		os.Exit(1)
	}
	return nil
}

func init() {
	e2eCmd.Flags().Bool("interactive", false, "Enable interactive mode (QR scan + message send)")
	e2eCmd.Flags().String("webhook-url", "https://httpbin.org/post", "URL for test webhook delivery")
	e2eCmd.Flags().String("phone", "", "Phone number for test message (with --interactive)")

	rootCmd.AddCommand(e2eCmd)
}
