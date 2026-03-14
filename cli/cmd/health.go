package cmd

import (
	"fmt"

	"github.com/dhruvyad/wahooks/cli/internal/style"
	"github.com/spf13/cobra"
)

var healthCmd = &cobra.Command{
	Use:   "health",
	Short: "Check API health (no auth required)",
	RunE: func(cmd *cobra.Command, args []string) error {
		resp, err := client.Do("GET", "/api", nil)
		if err != nil {
			style.Error("API unreachable: %v", err)
			return err
		}

		if resp.StatusCode == 200 {
			style.Success("API is healthy (%dms)", resp.Duration.Milliseconds())
		} else {
			style.Error("API returned HTTP %d (%dms)", resp.StatusCode, resp.Duration.Milliseconds())
		}

		// Still show the body for detail
		var body map[string]interface{}
		if err := resp.JSON(&body); err == nil {
			if msg, ok := body["message"].(string); ok {
				style.Dim("  %s", msg)
			} else if status, ok := body["status"].(string); ok {
				style.Dim("  %s", status)
			}
		} else {
			fmt.Println(string(resp.Body))
		}

		return nil
	},
}

func init() {
	rootCmd.AddCommand(healthCmd)
}
