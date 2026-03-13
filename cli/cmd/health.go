package cmd

import (
	"github.com/spf13/cobra"
)

var healthCmd = &cobra.Command{
	Use:   "health",
	Short: "Check API health (no auth required)",
	RunE: func(cmd *cobra.Command, args []string) error {
		resp, err := client.Do("GET", "/api", nil)
		if err != nil {
			return err
		}
		resp.Print()
		return nil
	},
}

func init() {
	rootCmd.AddCommand(healthCmd)
}
