package cmd

import (
	"fmt"

	"github.com/fatih/color"
	"github.com/spf13/cobra"
)

var tokensCmd = &cobra.Command{
	Use:     "tokens",
	Aliases: []string{"token", "t"},
	Short:   "Manage API tokens",
}

var tokensListCmd = &cobra.Command{
	Use:     "list",
	Aliases: []string{"ls"},
	Short:   "List active API tokens",
	RunE: func(cmd *cobra.Command, args []string) error {
		resp, err := client.Do("GET", "/api/tokens", nil)
		if err != nil {
			return err
		}

		var tokens []map[string]interface{}
		if err := resp.JSON(&tokens); err != nil || len(tokens) == 0 {
			fmt.Println("No API tokens")
			return nil
		}

		fmt.Printf("%-36s  %-20s  %-15s  %-20s  %s\n", "ID", "NAME", "PREFIX", "LAST USED", "CREATED")
		fmt.Println("────────────────────────────────────  ────────────────────  ───────────────  ────────────────────  ────────────────────")
		for _, t := range tokens {
			id, _ := t["id"].(string)
			name, _ := t["name"].(string)
			prefix, _ := t["tokenPrefix"].(string)
			if prefix == "" {
				prefix, _ = t["token_prefix"].(string)
			}
			lastUsed, _ := t["lastUsedAt"].(string)
			if lastUsed == "" {
				lastUsed, _ = t["last_used_at"].(string)
			}
			if lastUsed == "" {
				lastUsed = "never"
			}
			createdAt, _ := t["createdAt"].(string)
			if createdAt == "" {
				createdAt, _ = t["created_at"].(string)
			}

			fmt.Printf("%-36s  %-20s  %-15s  %-20s  %s\n", id, name, prefix, lastUsed, createdAt)
		}

		color.New(color.Faint).Printf("\n%d token(s)\n", len(tokens))
		return nil
	},
}

var tokensCreateCmd = &cobra.Command{
	Use:   "create <name>",
	Short: "Create a new API token",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		body := map[string]interface{}{
			"name": args[0],
		}

		resp, err := client.Do("POST", "/api/tokens", body)
		if err != nil {
			return err
		}

		var result map[string]interface{}
		if err := resp.JSON(&result); err == nil {
			if token, ok := result["token"].(string); ok {
				color.Green("Created API token: %s", result["name"])
				fmt.Println()
				color.New(color.Bold).Printf("  %s\n", token)
				fmt.Println()
				color.Yellow("  Save this token — it won't be shown again.")
				return nil
			}
		}

		resp.Print()
		return nil
	},
}

var tokensRevokeCmd = &cobra.Command{
	Use:     "revoke <id>",
	Aliases: []string{"rm", "delete"},
	Short:   "Revoke an API token",
	Args:    cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		resp, err := client.Do("DELETE", "/api/tokens/"+args[0], nil)
		if err != nil {
			return err
		}

		var result map[string]interface{}
		if err := resp.JSON(&result); err == nil {
			if success, _ := result["success"].(bool); success {
				color.Green("Token revoked")
				return nil
			}
		}

		resp.Print()
		return nil
	},
}

func init() {
	tokensCmd.AddCommand(tokensListCmd)
	tokensCmd.AddCommand(tokensCreateCmd)
	tokensCmd.AddCommand(tokensRevokeCmd)

	rootCmd.AddCommand(tokensCmd)
}
