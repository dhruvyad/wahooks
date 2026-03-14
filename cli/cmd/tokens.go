package cmd

import (
	"fmt"

	"github.com/dhruvyad/wahooks/cli/internal/style"
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
			style.Dim("  No API tokens")
			return nil
		}

		table := style.NewTable("ID", "NAME", "PREFIX", "LAST USED", "CREATED")
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

			table.AddRow(id, name, prefix, lastUsed, createdAt)
		}
		table.Print()
		style.Count(len(tokens), "token")
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
				style.Success("Created API token: %s", result["name"])
				style.WarnPanel("Save Your Token", fmt.Sprintf("%s\n\nThis token will not be shown again.", token))
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
				style.Success("Token revoked")
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
