package cmd

import (
	"fmt"
	"os"

	"github.com/dhruvyad/wahooks/cli/internal/api"
	"github.com/dhruvyad/wahooks/cli/internal/config"
	"github.com/spf13/cobra"
)

var (
	cfg    *config.Config
	client *api.Client
)

var rootCmd = &cobra.Command{
	Use:   "wahooks",
	Short: "WAHooks CLI — manage WhatsApp connections, webhooks, and billing",
	PersistentPreRun: func(cmd *cobra.Command, args []string) {
		cfg = config.Load()

		// Override from flag
		if url, _ := cmd.Flags().GetString("api-url"); url != "" {
			cfg.APIURL = url
		}

		client = api.NewClient(cfg.APIURL, cfg.Token)
	},
}

func Execute() {
	if err := rootCmd.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func init() {
	rootCmd.PersistentFlags().String("api-url", "", "API base URL (default: from config or http://localhost:3001)")
}
