package cmd

import (
	"bufio"
	"fmt"
	"os"
	"strings"

	"github.com/dhruvyad/wahooks/cli/internal/auth"
	"github.com/fatih/color"
	"github.com/spf13/cobra"
	"golang.org/x/term"
)

var loginCmd = &cobra.Command{
	Use:   "login [email]",
	Short: "Authenticate with Supabase",
	Args:  cobra.MaximumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		reader := bufio.NewReader(os.Stdin)

		var email string
		if len(args) > 0 {
			email = args[0]
		} else {
			fmt.Print("Email: ")
			email, _ = reader.ReadString('\n')
			email = strings.TrimSpace(email)
		}

		fmt.Print("Password: ")
		passwordBytes, err := term.ReadPassword(int(os.Stdin.Fd()))
		fmt.Println()
		if err != nil {
			return fmt.Errorf("read password: %w", err)
		}
		password := string(passwordBytes)

		result, err := auth.Login(email, password)
		if err != nil {
			return err
		}

		cfg.Token = result.AccessToken
		if err := cfg.Save(); err != nil {
			return fmt.Errorf("save config: %w", err)
		}

		color.Green("Logged in as %s (%s)", result.User.Email, result.User.ID)
		return nil
	},
}

var configSetCmd = &cobra.Command{
	Use:   "config <key> <value>",
	Short: "Set config values (api-url)",
	Args:  cobra.ExactArgs(2),
	RunE: func(cmd *cobra.Command, args []string) error {
		switch args[0] {
		case "api-url":
			cfg.APIURL = args[1]
		default:
			return fmt.Errorf("unknown config key: %s (available: api-url)", args[0])
		}
		if err := cfg.Save(); err != nil {
			return err
		}
		color.Green("Set %s = %s", args[0], args[1])
		return nil
	},
}

var statusCmd = &cobra.Command{
	Use:   "status",
	Short: "Show current config and auth state",
	Run: func(cmd *cobra.Command, args []string) {
		fmt.Printf("  API URL: %s\n", cfg.APIURL)
		if cfg.Token != "" {
			color.Green("  Auth: authenticated")
		} else {
			color.Yellow("  Auth: not authenticated (run 'wahooks login')")
		}
	},
}

func init() {
	rootCmd.AddCommand(loginCmd)
	rootCmd.AddCommand(configSetCmd)
	rootCmd.AddCommand(statusCmd)
}
