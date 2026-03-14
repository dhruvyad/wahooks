package cmd

import (
	"fmt"
	"os"

	"github.com/dhruvyad/wahooks/cli/internal/api"
	"github.com/dhruvyad/wahooks/cli/internal/auth"
	"github.com/dhruvyad/wahooks/cli/internal/config"
	"github.com/fatih/color"
	"github.com/spf13/cobra"
)

var (
	cfg    *config.Config
	client *api.Client
)

var rootCmd = &cobra.Command{
	Use:   "wahooks",
	Short: "WAHooks CLI — manage WhatsApp connections, webhooks, and billing",
	Long: func() string {
		green := color.New(color.FgGreen, color.Bold)
		faint := color.New(color.Faint)
		return fmt.Sprintf("\n  %s %s\n  %s\n",
			green.Sprint("WAHooks CLI"),
			faint.Sprint("v0.1.0"),
			faint.Sprint("WhatsApp webhooks, instant setup."),
		)
	}(),
	PersistentPreRun: func(cmd *cobra.Command, args []string) {
		cfg = config.Load()

		// Override from flag
		if url, _ := cmd.Flags().GetString("api-url"); url != "" {
			cfg.APIURL = url
		}

		client = api.NewClient(cfg.APIURL, cfg.Token)

		// Auto-refresh tokens on 401
		if cfg.RefreshToken != "" {
			refreshToken := cfg.RefreshToken
			client.TokenRefresher = func() (string, string, error) {
				result, err := auth.Refresh(refreshToken)
				if err != nil {
					return "", "", err
				}
				refreshToken = result.RefreshToken
				return result.AccessToken, result.RefreshToken, nil
			}
			client.OnTokenRefresh = func(accessToken, newRefreshToken string) {
				cfg.Token = accessToken
				cfg.RefreshToken = newRefreshToken
				_ = cfg.Save()
			}
		}
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
