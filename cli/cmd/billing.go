package cmd

import (
	"fmt"
	"os/exec"
	"runtime"
	"strings"

	"github.com/fatih/color"
	"github.com/spf13/cobra"
)

var billingCmd = &cobra.Command{
	Use:     "billing",
	Aliases: []string{"bill", "b"},
	Short:   "Billing and usage management",
}

var billingStatusCmd = &cobra.Command{
	Use:   "status",
	Short: "Show billing status, slots, and subscription",
	RunE: func(cmd *cobra.Command, args []string) error {
		resp, err := client.Do("GET", "/api/billing/status", nil)
		if err != nil {
			return err
		}

		var status map[string]interface{}
		if err := resp.JSON(&status); err != nil {
			resp.Print()
			return nil
		}

		sub, _ := status["subscription"].(map[string]interface{})
		slots, _ := status["slots"].(map[string]interface{})

		fmt.Println()

		active, _ := sub["active"].(bool)
		if active {
			subStatus, _ := sub["status"].(string)
			amount, _ := sub["monthlyAmount"].(float64)
			currency, _ := sub["currency"].(string)
			color.Green("  Subscription: %s", subStatus)
			fmt.Printf("  Monthly cost: %s %.2f\n", strings.ToUpper(currency), amount)
		} else {
			color.Yellow("  Subscription: inactive")
			fmt.Println("  Run 'wahooks billing checkout' to set up billing")
		}

		fmt.Println()

		paid, _ := slots["paid"].(float64)
		used, _ := slots["used"].(float64)
		available, _ := slots["available"].(float64)

		fmt.Printf("  Slots: %.0f paid, %.0f used, ", paid, used)
		if available > 0 {
			color.New(color.FgGreen).Printf("%.0f available\n", available)
		} else {
			color.New(color.FgRed).Println("0 available")
		}
		fmt.Println()

		return nil
	},
}

var billingCheckoutCmd = &cobra.Command{
	Use:   "checkout [slots]",
	Short: "Buy connection slots (opens browser)",
	Args:  cobra.MaximumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		quantity := 1
		if len(args) > 0 {
			fmt.Sscanf(args[0], "%d", &quantity)
			if quantity < 1 {
				quantity = 1
			}
		}
		currency, _ := cmd.Flags().GetString("currency")

		body := map[string]interface{}{
			"quantity": quantity,
			"currency": currency,
		}

		resp, err := client.Do("POST", "/api/billing/checkout", body)
		if err != nil {
			return err
		}

		var result map[string]interface{}
		if err := resp.JSON(&result); err != nil {
			resp.Print()
			return nil
		}

		url, _ := result["url"].(string)
		if url == "" || url == "https://wahooks.com/billing?success=true" {
			color.Green("Slots added to existing subscription!")
			return nil
		}

		fmt.Println("Opening checkout...")
		openBrowserURL(url)
		color.New(color.Faint).Println("Complete payment in your browser")
		return nil
	},
}

var billingPortalCmd = &cobra.Command{
	Use:   "portal",
	Short: "Manage subscription in Stripe portal (opens browser)",
	RunE: func(cmd *cobra.Command, args []string) error {
		resp, err := client.Do("POST", "/api/billing/portal", nil)
		if err != nil {
			return err
		}

		var result map[string]interface{}
		if err := resp.JSON(&result); err != nil {
			resp.Print()
			return nil
		}

		url, _ := result["url"].(string)
		if url != "" {
			fmt.Println("Opening billing portal...")
			openBrowserURL(url)
		}
		return nil
	},
}

func openBrowserURL(url string) {
	switch runtime.GOOS {
	case "darwin":
		exec.Command("open", url).Start()
	case "linux":
		exec.Command("xdg-open", url).Start()
	case "windows":
		exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
	}
}

func init() {
	billingCheckoutCmd.Flags().String("currency", "usd", "Currency: usd or inr")

	billingCmd.AddCommand(billingStatusCmd)
	billingCmd.AddCommand(billingCheckoutCmd)
	billingCmd.AddCommand(billingPortalCmd)

	rootCmd.AddCommand(billingCmd)
}
