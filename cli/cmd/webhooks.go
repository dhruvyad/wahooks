package cmd

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/dhruvyad/wahooks/cli/internal/style"
	"github.com/fatih/color"
	"github.com/spf13/cobra"
)

func encodeJSON(v interface{}) (string, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

var webhooksCmd = &cobra.Command{
	Use:     "webhooks",
	Aliases: []string{"wh", "w"},
	Short:   "Manage webhook configurations",
}

var whListCmd = &cobra.Command{
	Use:     "list <connection-id>",
	Aliases: []string{"ls"},
	Short:   "List webhooks for a connection",
	Args:    cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		resp, err := client.Do("GET", "/api/connections/"+args[0]+"/webhooks", nil)
		if err != nil {
			return err
		}

		var webhooks []map[string]interface{}
		if err := resp.JSON(&webhooks); err != nil || len(webhooks) == 0 {
			resp.Print()
			return nil
		}

		table := style.NewTable("ID", "ACTIVE", "URL", "EVENTS")
		for _, wh := range webhooks {
			id, _ := wh["id"].(string)
			url, _ := wh["url"].(string)
			active, _ := wh["active"].(bool)

			var events []string
			if evts, ok := wh["events"].([]interface{}); ok {
				for _, e := range evts {
					events = append(events, fmt.Sprint(e))
				}
			}

			activeStr := "false"
			activeColor := style.Red()
			if active {
				activeStr = "true"
				activeColor = style.Green()
			}

			table.AddColoredRow(
				[]string{id, activeStr, url, strings.Join(events, ", ")},
				[]*color.Color{nil, activeColor, nil, nil},
			)
		}
		table.Print()
		style.Count(len(webhooks), "webhook")
		return nil
	},
}

var whCreateCmd = &cobra.Command{
	Use:   "create <connection-id> <url> [events...]",
	Short: "Create a webhook (events default to *)",
	Args:  cobra.MinimumNArgs(2),
	RunE: func(cmd *cobra.Command, args []string) error {
		connID := args[0]
		url := args[1]
		events := []string{"*"}
		if len(args) > 2 {
			events = strings.Split(args[2], ",")
		}

		body := map[string]interface{}{
			"url":    url,
			"events": events,
		}

		resp, err := client.Do("POST", "/api/connections/"+connID+"/webhooks", body)
		if err != nil {
			return err
		}

		var created map[string]interface{}
		if err := resp.JSON(&created); err == nil {
			if id, ok := created["id"].(string); ok {
				style.Success("Created webhook %s", id)

				secret := ""
				if s, ok := created["signing_secret"].(string); ok {
					secret = s
				} else if s, ok := created["signingSecret"].(string); ok {
					secret = s
				}
				if secret != "" {
					style.WarnPanel("Signing Secret", fmt.Sprintf("%s\n\nSave this secret \u2014 it won't be shown again.", secret))
				}
				return nil
			}
		}

		resp.Print()
		return nil
	},
}

var whUpdateCmd = &cobra.Command{
	Use:   "update <webhook-id>",
	Short: "Update a webhook config",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		body := map[string]interface{}{}

		if url, _ := cmd.Flags().GetString("url"); url != "" {
			body["url"] = url
		}
		if events, _ := cmd.Flags().GetString("events"); events != "" {
			body["events"] = strings.Split(events, ",")
		}
		if cmd.Flags().Changed("active") {
			active, _ := cmd.Flags().GetBool("active")
			body["active"] = active
		}

		if len(body) == 0 {
			return fmt.Errorf("specify at least one of --url, --events, --active")
		}

		resp, err := client.Do("PUT", "/api/webhooks/"+args[0], body)
		if err != nil {
			return err
		}
		resp.Print()
		return nil
	},
}

var whDeleteCmd = &cobra.Command{
	Use:     "delete <webhook-id>",
	Aliases: []string{"rm"},
	Short:   "Delete a webhook",
	Args:    cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		resp, err := client.Do("DELETE", "/api/webhooks/"+args[0], nil)
		if err != nil {
			return err
		}

		var result map[string]interface{}
		if err := resp.JSON(&result); err == nil {
			if success, _ := result["success"].(bool); success {
				style.Success("Webhook deleted")
				return nil
			}
		}

		resp.Print()
		return nil
	},
}

var whLogsCmd = &cobra.Command{
	Use:   "logs <webhook-id>",
	Short: "Get delivery logs for a webhook",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		verbose, _ := cmd.Flags().GetBool("verbose")

		resp, err := client.Do("GET", "/api/webhooks/"+args[0]+"/logs", nil)
		if err != nil {
			return err
		}

		var logs []map[string]interface{}
		if err := resp.JSON(&logs); err != nil || len(logs) == 0 {
			resp.Print()
			return nil
		}

		table := style.NewTable("ID", "EVENT", "STATUS", "TRIES", "CREATED")
		for _, l := range logs {
			id, _ := l["id"].(string)
			eventType, _ := l["event_type"].(string)
			if eventType == "" {
				eventType, _ = l["eventType"].(string)
			}
			status, _ := l["status"].(string)
			attempts := fmt.Sprintf("%.0f", l["attempts"])
			createdAt, _ := l["created_at"].(string)
			if createdAt == "" {
				createdAt, _ = l["createdAt"].(string)
			}

			statusColor := style.StatusColor(status)
			table.AddColoredRow(
				[]string{id, eventType, status, attempts, createdAt},
				[]*color.Color{nil, nil, statusColor, nil, nil},
			)
		}
		table.Print()

		// Show message bodies inline after the table
		if verbose {
			for _, l := range logs {
				if payload, ok := l["payload"].(map[string]interface{}); ok {
					id, _ := l["id"].(string)
					if encoded, err := encodeJSON(payload); err == nil {
						style.Dim("  %s: %s", id[:8], encoded)
					}
				}
			}
			fmt.Println()
		}

		style.Count(len(logs), "log")
		return nil
	},
}

var whTestCmd = &cobra.Command{
	Use:   "test <webhook-id>",
	Short: "Send a test event to a webhook",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		resp, err := client.Do("POST", "/api/webhooks/"+args[0]+"/test", nil)
		if err != nil {
			return err
		}

		var result map[string]interface{}
		if err := resp.JSON(&result); err == nil {
			if success, _ := result["success"].(bool); success {
				logId, _ := result["logId"].(string)
				style.Success("Test event enqueued (log: %s)", logId)
				return nil
			}
		}

		resp.Print()
		return nil
	},
}

func init() {
	whUpdateCmd.Flags().String("url", "", "New webhook URL")
	whUpdateCmd.Flags().String("events", "", "Comma-separated event types")
	whUpdateCmd.Flags().Bool("active", true, "Enable/disable webhook")
	whLogsCmd.Flags().BoolP("verbose", "v", false, "Show full payload JSON")

	webhooksCmd.AddCommand(whListCmd)
	webhooksCmd.AddCommand(whCreateCmd)
	webhooksCmd.AddCommand(whUpdateCmd)
	webhooksCmd.AddCommand(whDeleteCmd)
	webhooksCmd.AddCommand(whLogsCmd)
	webhooksCmd.AddCommand(whTestCmd)

	rootCmd.AddCommand(webhooksCmd)
}
