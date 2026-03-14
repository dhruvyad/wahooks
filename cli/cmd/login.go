package cmd

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"

	"github.com/dhruvyad/wahooks/cli/internal/auth"
	"github.com/fatih/color"
	"github.com/spf13/cobra"
	"golang.org/x/term"
)

type callbackTokens struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
}

func openBrowser(url string) error {
	switch runtime.GOOS {
	case "darwin":
		return exec.Command("open", url).Start()
	case "linux":
		return exec.Command("xdg-open", url).Start()
	case "windows":
		return exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
	default:
		return fmt.Errorf("unsupported platform")
	}
}

func browserLogin() error {
	// Start local server on a random port
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return fmt.Errorf("start local server: %w", err)
	}
	port := listener.Addr().(*net.TCPAddr).Port

	tokensCh := make(chan callbackTokens, 1)
	errCh := make(chan error, 1)

	mux := http.NewServeMux()
	mux.HandleFunc("/callback", func(w http.ResponseWriter, r *http.Request) {
		// Handle CORS preflight from the browser page
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")

		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusOK)
			return
		}

		if r.Method != "POST" {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		var tokens callbackTokens
		if err := json.NewDecoder(r.Body).Decode(&tokens); err != nil {
			http.Error(w, "Invalid body", http.StatusBadRequest)
			return
		}

		if tokens.AccessToken == "" {
			http.Error(w, "Missing access_token", http.StatusBadRequest)
			return
		}

		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"ok":true}`))
		tokensCh <- tokens
	})

	server := &http.Server{Handler: mux}
	go func() {
		if err := server.Serve(listener); err != nil && err != http.ErrServerClosed {
			errCh <- err
		}
	}()

	// Determine the dashboard URL
	dashboardURL := "https://wahooks.com"
	if cfg.APIURL == "http://localhost:3001" {
		dashboardURL = "http://localhost:3000"
	}

	authURL := fmt.Sprintf("%s/cli/auth?port=%d", dashboardURL, port)

	fmt.Printf("Opening browser to authorize...\n")
	if err := openBrowser(authURL); err != nil {
		fmt.Printf("Could not open browser. Please visit:\n  %s\n", authURL)
	}
	color.New(color.Faint).Printf("Waiting for authorization (press Ctrl+C to cancel)...\n")

	// Wait for callback or timeout
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	select {
	case tokens := <-tokensCh:
		server.Shutdown(context.Background())
		cfg.Token = tokens.AccessToken
		cfg.RefreshToken = tokens.RefreshToken
		if err := cfg.Save(); err != nil {
			return fmt.Errorf("save config: %w", err)
		}
		color.Green("Logged in successfully")
		return nil
	case err := <-errCh:
		server.Shutdown(context.Background())
		return fmt.Errorf("server error: %w", err)
	case <-ctx.Done():
		server.Shutdown(context.Background())
		return fmt.Errorf("timed out waiting for authorization")
	}
}

func passwordLogin(args []string, cmd *cobra.Command) error {
	reader := bufio.NewReader(os.Stdin)

	var email string
	if len(args) > 0 {
		email = args[0]
	} else {
		fmt.Print("Email: ")
		email, _ = reader.ReadString('\n')
		email = strings.TrimSpace(email)
	}

	password, _ := cmd.Flags().GetString("password")
	if password == "" {
		fmt.Print("Password: ")
		passwordBytes, err := term.ReadPassword(int(os.Stdin.Fd()))
		fmt.Println()
		if err != nil {
			return fmt.Errorf("read password: %w", err)
		}
		password = string(passwordBytes)
	}

	result, err := auth.Login(email, password)
	if err != nil {
		return err
	}

	cfg.Token = result.AccessToken
	cfg.RefreshToken = result.RefreshToken
	if err := cfg.Save(); err != nil {
		return fmt.Errorf("save config: %w", err)
	}

	color.Green("Logged in as %s (%s)", result.User.Email, result.User.ID)
	return nil
}

var loginCmd = &cobra.Command{
	Use:   "login [email]",
	Short: "Authenticate with WAHooks (opens browser by default)",
	Args:  cobra.MaximumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		noBrowser, _ := cmd.Flags().GetBool("no-browser")

		if noBrowser || len(args) > 0 {
			return passwordLogin(args, cmd)
		}

		return browserLogin()
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
	loginCmd.Flags().StringP("password", "p", "", "Password (avoids interactive prompt)")
	loginCmd.Flags().Bool("no-browser", false, "Use email/password instead of browser")

	rootCmd.AddCommand(loginCmd)
	rootCmd.AddCommand(configSetCmd)
	rootCmd.AddCommand(statusCmd)
}
