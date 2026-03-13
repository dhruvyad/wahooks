package cmd

import (
	"fmt"

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
	Short: "Get billing status and subscription info",
	RunE: func(cmd *cobra.Command, args []string) error {
		resp, err := client.Do("GET", "/api/billing/status", nil)
		if err != nil {
			return err
		}
		resp.Print()
		return nil
	},
}

var billingUsageCmd = &cobra.Command{
	Use:   "usage",
	Short: "Get usage summary",
	RunE: func(cmd *cobra.Command, args []string) error {
		resp, err := client.Do("GET", "/api/billing/usage", nil)
		if err != nil {
			return err
		}
		resp.Print()
		return nil
	},
}

var billingCheckoutCmd = &cobra.Command{
	Use:   "checkout",
	Short: "Create a Stripe checkout session",
	RunE: func(cmd *cobra.Command, args []string) error {
		resp, err := client.Do("POST", "/api/billing/checkout", nil)
		if err != nil {
			return err
		}

		var result map[string]interface{}
		if err := resp.JSON(&result); err == nil {
			if url, ok := result["url"].(string); ok {
				fmt.Printf("Checkout URL: %s\n", url)
				color.New(color.Faint).Println("Open this URL in your browser to complete checkout")
				return nil
			}
		}

		resp.Print()
		return nil
	},
}

var billingPortalCmd = &cobra.Command{
	Use:   "portal",
	Short: "Open Stripe customer portal",
	RunE: func(cmd *cobra.Command, args []string) error {
		resp, err := client.Do("POST", "/api/billing/portal", nil)
		if err != nil {
			return err
		}

		var result map[string]interface{}
		if err := resp.JSON(&result); err == nil {
			if url, ok := result["url"].(string); ok {
				fmt.Printf("Portal URL: %s\n", url)
				return nil
			}
		}

		resp.Print()
		return nil
	},
}

func init() {
	billingCmd.AddCommand(billingStatusCmd)
	billingCmd.AddCommand(billingUsageCmd)
	billingCmd.AddCommand(billingCheckoutCmd)
	billingCmd.AddCommand(billingPortalCmd)

	rootCmd.AddCommand(billingCmd)
}
